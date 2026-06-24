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

// #21 — 공유 broker 사전-warm 헬퍼. SessionStart 와 UserPromptSubmit 양쪽이 호출한다.
// (1) cwd 게이트: 실제 workspace cwd 가 있을 때만 warm 한다. hooks.json 이 이 스크립트
//     실행 전 CLAUDE_PLUGIN_ROOT 로 `cd` 하므로 process.cwd() 는 plugin 디렉토리 —
//     그걸로 warm 하면 broker 가 엉뚱한 workspace 로 키잉돼(real /opnd-codex:* 는
//     사용자 workspace 에서 broker 상태를 찾으므로 여전히 no broker), plugin-root
//     broker 는 idle cleanup 까지 lingers 한다. 그래서 반드시 input.cwd 만 쓴다.
// (2) best-effort: warm 실패는 절대 throw 되어선 안 된다. warmBrokerBestEffort 가 이미
//     모든 에러를 흡수하지만, 여기서 catch 로 계약을 코드로 명시해 UserPromptSubmit 의
//     exit-1 전파(=prompt 차단) 가능성을 원천 차단한다 (QUAL-001).
export async function maybeWarmBroker(input, warm = warmBrokerBestEffort) {
  if (!input.cwd) {
    return;
  }
  try {
    const result = await warm(input.cwd);
    // 관측성(SEC-001/QUAL-R2-3): warm 은 best-effort 라 결과를 prompt 흐름에 반영하지
    // 않지만, 실제 인프라 에러(spawn 실패 등)는 stderr 로 진단을 남긴다 — stdout 이
    // 아니므로 UserPromptSubmit 의 prompt 컨텍스트를 오염시키지 않으며, 만성 broker
    // warm 실패가 완전 무음으로 묻히지 않게 한다.
    if (result && result.reason === "error") {
      process.stderr.write(`[codex-plugin] broker warm failed: ${result.error}\n`);
    }
  } catch {
    // best-effort — warm 실패가 SessionStart/UserPromptSubmit 를 막아선 안 된다.
  }
}

async function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // #338 — codex-namespaced so other plugins' CLAUDE_PLUGIN_DATA is untouched.
  appendEnvVar(CODEX_PLUGIN_DATA_DIR_ENV, process.env[PLUGIN_DATA_ENV]);
  await maybeWarmBroker(input);
}

// #21 follow-up — 매 사용자 턴마다 session broker 를 재워밍한다. broker 에는 idle
// self-exit watchdog(기본 10분 무소켓)이 있는데, crash-orphan broker 회수가 목적
// 이지만 "세션 종료"와 "세션 alive-but-idle"을 구분 못 해 정상 think-time 공백에도
// 세션 도중 broker 를 죽인다(연결 시 idle 타이머 갱신은 app-server-broker.mjs CDX-001
// 참조). 그러면 이후 codex-rescue subagent 가 live broker 를 못 찾고 survivable
// broker 를 spawn 할 수도 없어(subagent 는 kill-on-close Windows Job Object 안에서
// 실행, #21), `setup` 이 auth ready 라고 보고해도(broker liveness 는 setup 이 워밍하지
// 않는 별도 축) NO_SURVIVABLE_BROKER 로 실패한다. SessionStart 단독은 첫 ~10분 idle 만
// 커버한다. UserPromptSubmit 은 main-session 컨텍스트에서 prompt 처리 전·턴이 spawn 할
// 어떤 subagent 보다 먼저 실행되므로, 여기서 재워밍하면 subagent codex 호출 시 항상
// live broker 가 있음을 보장한다. broker 가 이미 warm 이면 저렴하다(ensureBrokerSession
// 이 ~150ms liveness 체크 후 기존 세션 반환). 게이트/실패정책은 maybeWarmBroker 참조.
async function handleUserPromptSubmit(input) {
  await maybeWarmBroker(input);
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
