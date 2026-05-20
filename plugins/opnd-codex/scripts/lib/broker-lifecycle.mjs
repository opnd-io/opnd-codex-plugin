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

export function createBrokerSessionDir(prefix = "cxc-") {
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
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
