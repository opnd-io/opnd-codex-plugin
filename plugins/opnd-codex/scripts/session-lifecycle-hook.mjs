#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { readHookStdinJsonAsync } from "./lib/fs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// #338 — the SessionStart hook must NOT re-export the generic CLAUDE_PLUGIN_DATA
// into CLAUDE_ENV_FILE: that file is sourced by EVERY tool call and every other
// plugin, so exporting it there overrides their own per-plugin CLAUDE_PLUGIN_DATA.
// Re-export under a codex-namespaced name instead; the plugin's own consumers
// (state.mjs / telemetry.mjs / codex-efficiency-report.mjs / codex-companion.mjs)
// read `CODEX_PLUGIN_DATA_DIR ?? CLAUDE_PLUGIN_DATA`.
const CODEX_PLUGIN_DATA_DIR_ENV = "CODEX_PLUGIN_DATA_DIR";

// PR-1.6 (#120 / #247) — sync fs.readFileSync(0) crashes with EAGAIN whenever
// the parent passes a non-blocking stdin fd. Switch to event-based async drain
// with a 5s fallback so the hook degrades to an empty-input run instead of
// killing the whole session lifecycle.
async function readHookInput() {
  return readHookStdinJsonAsync({ timeoutMs: 5000 });
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

// #21 — eager broker warm-up. The broker survives the whole Claude session
// because it is spawned from the main-session Job Object (which carries
// SILENT_BREAKAWAY_OK on Windows, so the broker auto-escapes). When a later
// `codex-rescue` subagent runs a foreground `task`, it then REUSES this warm
// broker (the codex app-server is hosted by the surviving broker) instead of
// lazily spawning a fresh broker inside the subagent's own kill-on-close Job
// Object — that lazy spawn is what dies on subagent turn-end, losing the
// result (#21). SessionStart is the only plugin touchpoint guaranteed to run
// in the main session before any subagent, so it is where the warm belongs.
// Default-on; opt out with CODEX_PLUGIN_EAGER_BROKER=0 (also off when value is
// false/off/no). Best-effort + time-boxed: a warm failure must NEVER break
// session start, and the lazy path still works for main-thread commands.
export function eagerBrokerEnabled(env = process.env) {
  const raw = String(env.CODEX_PLUGIN_EAGER_BROKER ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

// Cheap (no subprocess) codex-on-PATH probe so non-codex sessions never pay for
// a broker spawn. Scans PATH dirs for a codex launcher; on Windows it also
// checks the PATHEXT-style launcher suffixes Node would resolve.
export function codexOnPath(env = process.env) {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) {
    return false;
  }
  const names =
    process.platform === "win32"
      ? ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"]
      : ["codex"];
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      try {
        if (fs.existsSync(path.join(dir, name))) {
          return true;
        }
      } catch {
        // Unreadable PATH entry — skip it.
      }
    }
  }
  return false;
}

// Exposed (with injectable deps) for unit tests so they can assert the gating
// without spawning a real broker.
export async function warmBrokerBestEffort(cwd, options = {}) {
  const env = options.env ?? process.env;
  const ensure = options.ensureBroker ?? ensureBrokerSession;
  const pathProbe = options.codexOnPath ?? codexOnPath;
  if (!eagerBrokerEnabled(env)) {
    return { warmed: false, reason: "opted-out" };
  }
  if (!pathProbe(env)) {
    return { warmed: false, reason: "codex-not-on-path" };
  }
  try {
    const session = await ensure(cwd, { timeoutMs: options.timeoutMs ?? 2000, env });
    return session?.endpoint ? { warmed: true, reason: "ok" } : { warmed: false, reason: "not-ready" };
  } catch (error) {
    // The lazy connect path still works for the main thread; a warm failure
    // only forgoes the subagent-cold-start protection.
    return { warmed: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // #338 — codex-namespaced so other plugins' CLAUDE_PLUGIN_DATA is untouched.
  appendEnvVar(CODEX_PLUGIN_DATA_DIR_ENV, process.env[PLUGIN_DATA_ENV]);
  // #21 — pre-warm the session broker from this (main-session) context, but
  // ONLY when the hook supplied a real workspace cwd. hooks.json `cd`s into
  // CLAUDE_PLUGIN_ROOT before running this script, so process.cwd() is the
  // plugin directory — warming for it would key the broker to the wrong
  // workspace (real /opnd-codex:* commands resolve broker state from the user's
  // workspace and would still see no broker, while the plugin-root broker
  // lingers until idle cleanup).
  if (input.cwd) {
    await warmBrokerBestEffort(input.cwd);
  }
}

// #21 follow-up — 매 사용자 턴마다 session broker 를 재워밍한다. broker 에는 idle
// self-exit watchdog(기본 10분 무소켓)이 있는데, crash-orphan broker 회수가 목적
// 이지만 "세션 종료"와 "세션 alive-but-idle"을 구분 못 해 정상 think-time 공백에도
// 세션 도중 broker 를 죽인다. 그러면 이후 codex-rescue subagent 가 live broker 를
// 못 찾고 survivable broker 를 spawn 할 수도 없어(subagent 는 kill-on-close Windows
// Job Object 안에서 실행, #21), `setup` 이 auth ready 라고 보고해도(broker liveness
// 는 setup 이 워밍하지 않는 별도 축) NO_SURVIVABLE_BROKER 로 실패한다. SessionStart
// 단독은 첫 ~10분 idle 만 커버한다. 여기서 재워밍 — UserPromptSubmit 은 main-session
// 컨텍스트에서 prompt 처리 전·턴이 spawn 할 어떤 subagent 보다 먼저 실행 — 하면
// subagent codex 호출 시 항상 live broker 가 있음을 보장한다. broker 가 이미 warm
// 이면 저렴하고(ensureBrokerSession 이 ~150ms liveness 체크 후 기존 세션 반환),
// SessionStart 와 똑같이 codex-on-PATH + CODEX_PLUGIN_EAGER_BROKER 게이트를 따르며,
// best-effort 다: warm 실패가 prompt 를 절대 막아선 안 된다.
async function handleUserPromptSubmit(input) {
  if (input.cwd) {
    await warmBrokerBestEffort(input.cwd);
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = await readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
    return;
  }

  if (eventName === "UserPromptSubmit") {
    await handleUserPromptSubmit(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

// Only run the hook when executed as the entry point — importing this module
// for its exported helpers (codexOnPath / warmBrokerBestEffort / …, e.g. in
// tests) must NOT trigger the stdin drain or, worse, a SessionEnd broker
// teardown if argv happened to match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
