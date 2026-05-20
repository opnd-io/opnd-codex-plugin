import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { buildCommandInvocation, terminateProcessTree } from "../plugins/opnd-codex/scripts/lib/process.mjs";
import { loadBrokerSession } from "../plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs";

// Track every test-spawned workspace + broker session dir so process exit can sweep
// any survivors. Prevents the /tmp/cxc-* orphan accumulation reported in upstream #163.
const trackedTestWorkspaces = new Set();
const trackedBrokerSessionDirs = new Set();
let sweepHooksInstalled = false;

function installSweepHooks() {
  if (sweepHooksInstalled) {
    return;
  }
  sweepHooksInstalled = true;
  const handler = () => {
    sweepTrackedBrokers();
  };
  process.on("exit", handler);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, () => {
        sweepTrackedBrokers();
        process.exit(130);
      });
    } catch {
      // ignore platform-unsupported signals
    }
  }
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  installSweepHooks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTestWorkspaces.add(dir);
  return dir;
}

// Tests that spawn real brokers (via codex-companion task/review) can record the
// session dir so cleanup can find and kill the broker.pid even if the test itself
// throws before its own teardown runs.
export function trackBrokerSessionDir(sessionDir) {
  if (sessionDir) {
    trackedBrokerSessionDirs.add(sessionDir);
  }
}

function readPidFile(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killBrokerPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    terminateProcessTree(pid, { platform: process.platform });
  } catch {
    // best-effort — broker may already be gone
  }
}

function removeBrokerSessionDir(sessionDir) {
  if (!sessionDir) {
    return;
  }
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // ignore — leftover artifacts are tolerable
  }
}

export function sweepTrackedBrokers() {
  // First: sessionDirs that tests explicitly registered.
  for (const sessionDir of trackedBrokerSessionDirs) {
    const pidFile = path.join(sessionDir, "broker.pid");
    killBrokerPid(readPidFile(pidFile));
    removeBrokerSessionDir(sessionDir);
  }
  trackedBrokerSessionDirs.clear();

  // Second: any test workspace whose broker.json points at a sessionDir we missed.
  for (const workspace of trackedTestWorkspaces) {
    let session;
    try {
      session = loadBrokerSession(workspace);
    } catch {
      session = null;
    }
    if (session) {
      if (Number.isFinite(session.pid)) {
        killBrokerPid(session.pid);
      } else if (session.pidFile) {
        killBrokerPid(readPidFile(session.pidFile));
      }
      removeBrokerSessionDir(session.sessionDir);
    }
  }
  trackedTestWorkspaces.clear();
}

// Exposed for tests that want to release a workspace early (e.g. between
// reproductions inside a single test process).
export function untrackTestWorkspace(workspace) {
  trackedTestWorkspaces.delete(workspace);
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  const invocation = buildCommandInvocation(command, args, {
    env: options.env,
    platform: process.platform
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
