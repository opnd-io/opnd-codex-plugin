import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir, withBrokerLockAsync } from "./state.mjs";
import { terminateProcessTree } from "./process.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

// B3 — broker 는 자신의 세션 dir 를 지울 수 없다: Windows 에서 broker.log 를 여전히
// stdout/stderr 로 열고 있고, hard kill 은 shutdown 을 아예 건너뛴다. 그래서 다음 spawn
// 이 죽은 것들을 회수한다. 상한이 있고 best-effort 다 — broker 시작 hot path 에서 돌며,
// 남은 temp dir 하나가 throw 할 값어치는 결코 없다.
const MAX_SWEPT_SESSION_DIRS = 200;

// `broker.pid` 가 없는 세션 dir 는 모호하다: broker 가 정상 종료했거나(종료 시 pid 파일을
// unlink 한다), 아니면 아직 자식을 띄우지 않은 동시 spawn 이 방금 만들었을 수도 있다 —
// `createBrokerSessionDir` 는 mkdtemp 를 하고, pid 파일은 spawn 된 broker 만 쓴다. 따라서
// "pid 파일 없음" 만으로 sweep 하면 다른 workspace 의 살아있는 세션을 지운다. cwd 별
// broker lock 은 그것을 직렬화해 주지 않는다.
//
// pid 없는 dir 를 버려진 것으로 취급하기 전에 그 창이 지나기를 기다린다. 죽은 dir 가
// spawn 한 번을 더 살아남는 비용은 0 이지만, 살아있는 dir 를 지우면 endpoint socket
// (POSIX) 과 broker 자신의 로그가 파괴된다.
export const SESSION_DIR_ADOPTION_GRACE_MS = 60_000;

/** @returns {"dead" | "live" | "too-young"} */
function classifySessionDir(sessionDir, nowMs) {
  const pidFile = path.join(sessionDir, "broker.pid");
  let raw;
  try {
    raw = fs.readFileSync(pidFile, "utf8").trim();
  } catch {
    // 아직 pid 파일이 없거나, 더 이상 없다.
    let birth;
    try {
      const stat = fs.statSync(sessionDir);
      birth = Math.min(stat.birthtimeMs || Infinity, stat.mtimeMs);
    } catch {
      return "dead"; // 우리 발밑에서 사라졌다
    }
    if (Number.isFinite(birth) && nowMs - birth < SESSION_DIR_ADOPTION_GRACE_MS) {
      return "too-young";
    }
    return "dead";
  }
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0) {
    return "dead";
  }
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    // EPERM 은 pid 가 존재하되 다른 사용자 소유라는 뜻 — 건드리지 않는다.
    return error?.code === "EPERM" ? "live" : "dead";
  }
}

export function sweepDeadBrokerSessionDirs(prefix = "cxc-", tmpdir = os.tmpdir(), nowMs = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(tmpdir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let swept = 0;
  for (const entry of entries) {
    if (swept >= MAX_SWEPT_SESSION_DIRS) {
      break;
    }
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const sessionDir = path.join(tmpdir, entry.name);
    if (classifySessionDir(sessionDir, nowMs) !== "dead") {
      continue;
    }
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true, maxRetries: 1 });
      swept += 1;
    } catch {
      // 다른 프로세스가 broker.log 를 아직 열고 있을 수 있다. 다음 spawn 에서 재시도.
    }
  }
  return swept;
}

export function createBrokerSessionDir(prefix = "cxc-") {
  sweepDeadBrokerSessionDirs(prefix);
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// Bound the shutdown wait so a hung broker cannot block SessionEnd indefinitely; if the
// RPC does not respond within this window the caller falls through to teardown anyway.
const BROKER_SHUTDOWN_TIMEOUT_MS = 5000;

export async function sendBrokerShutdown(endpoint, timeoutMs = BROKER_SHUTDOWN_TIMEOUT_MS) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore — best effort
      }
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      clearTimeout(timer);
      socket.end();
      settle();
    });
    socket.on("error", () => {
      clearTimeout(timer);
      settle();
    });
    socket.on("close", () => {
      clearTimeout(timer);
      settle();
    });
  });
}

// #18 — ask the long-lived broker (which lives in the main-session job that
// permits silent breakaway) to spawn the detached task-worker on our behalf.
// A worker spawned by the broker escapes the nested subagent Job Object
// (KILL_ON_JOB_CLOSE, no breakaway) that would otherwise terminate it the
// moment the dispatching Agent subagent's turn ends.
//
// Return contract (the caller MUST distinguish these to avoid a double-spawn):
//   { pid }            — broker confirmed a worker; the caller validates the pid.
//   <result object>    — a non-error reply is passed through verbatim, so a
//                        pid-less reply (e.g. `{}`) resolves to that object. The
//                        caller's pid check (Number(result.pid) → NaN) then
//                        treats it as "no worker" and local-spawns. (i.e. any
//                        definite reply without a usable pid behaves like null.)
//   null               — DEFINITELY no worker was spawned (never connected, or
//                        the broker replied with an explicit error). Safe to
//                        local-spawn.
//   { ambiguous: true } — we connected but got no clear reply (timeout / socket
//                        closed mid-RPC). The broker MAY have spawned a worker,
//                        so the caller must NOT local-spawn (would duplicate it).
// Timeout is short: the broker's spawn+reply is effectively synchronous, so a
// silent connected socket means trouble, not slow work. A stale broker.json
// fails fast on connect (no listener) and lands in the `null` path.
const BROKER_SPAWN_WORKER_TIMEOUT_MS = 2000;

export async function sendBrokerSpawnWorker(endpoint, params, timeoutMs = BROKER_SPAWN_WORKER_TIMEOUT_MS) {
  return await new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let buffer = "";
    let timer = null;
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    // Single settle point clears the timer exactly once (guarded by `settled`),
    // so the error→close handler pair cannot double-clear or double-resolve.
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        socket.destroy();
      } catch {
        // ignore — best effort
      }
      resolve(value);
    };
    // Connected-but-silent is ambiguous (worker may exist); never-connected is null.
    const settleNoReply = () => settle(connected ? { ambiguous: true } : null);
    timer = setTimeout(settleNoReply, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      connected = true;
      try {
        socket.write(`${JSON.stringify({ id: 1, method: "broker/spawnWorker", params: params ?? {} })}\n`);
      } catch {
        // A synchronous write failure (socket destroyed mid-connect) would
        // otherwise leave the Promise pending forever — settle it now.
        settleNoReply();
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }
        if (message && message.id === 1) {
          // An explicit error reply resolves to null (definitely no worker →
          // safe to local-spawn). A non-error reply is passed through verbatim:
          // the result object carries the pid for the caller to validate, and a
          // pid-less result (e.g. `{}`) likewise drives the caller to local-spawn.
          settle(message.error ? null : message.result ?? null);
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    });
    socket.on("error", settleNoReply);
    socket.on("close", settleNoReply);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
    child.unref();
    return child;
  } finally {
    // Always close the parent-side fd; the child inherits its own dup via stdio[1]/[2].
    fs.closeSync(logFd);
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

// PR-1.4 (#286 race 3) — serialize the broker session lifecycle so that two
// parallel /opnd-codex:* invocations from the same cwd never both spawn a fresh
// broker. The lock covers the entire read-decide-spawn-write critical section:
//
//   load broker.json → check liveness → teardown if stale → spawn new →
//   wait ready → write broker.json
//
// Without this guard, both callers passed the "no existing broker" check
// before either had written, both spawned an app-server, and both wrote
// broker.json. The losing writer's broker process was orphaned in `/tmp/cxc-*`
// and lived until the idle watchdog timed out.
export async function ensureBrokerSession(cwd, options = {}) {
  return withBrokerLockAsync(cwd, async () => {
    const existing = loadBrokerSession(cwd);
    if (existing && (await isBrokerEndpointReady(existing.endpoint))) {
      return existing;
    }

    if (existing) {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }

    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

    // PR-5.6 (#282) — broker process inherits the plugin-flavored env so any
    // codex children it spawns also see CODEX_HOME=$HOME/.codex/claude-code/.
    // Import lazy via dynamic to avoid a circular import with app-server.mjs
    // (which itself imports from this module).
    const { buildPluginCodexEnv } = await import("./app-server.mjs");
    const brokerEnv = buildPluginCodexEnv(options.env ?? process.env);
    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: brokerEnv
    });

    const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
    if (!ready) {
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    saveBrokerSession(cwd, session);
    return session;
  });
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  // A3 fix (docs/code-review/2026-05-20-pair-readiness-adversarial.md) —
  // default to a real process-tree kill when no `killProcess` is supplied.
  // Previously a null `killProcess` (the common `ensureBrokerSession` stale /
  // failed-readiness path) skipped the kill entirely, orphaning the broker
  // process. Callers and tests can still inject their own killer.
  const killer = killProcess ?? terminateProcessTree;
  if (Number.isFinite(pid)) {
    try {
      killer(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      // B3 — 예전에는 `rmdirSync` 였고, 비어있지 않은 디렉터리에서 조용히 실패했다.
      // broker 가 남긴 파일(지우지 못한 로그, socket)이 하나라도 있으면 dir 가 영원히
      // 살아남았다. 트리째 제거한다.
      fs.rmSync(resolvedSessionDir, { recursive: true, force: true, maxRetries: 1 });
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
