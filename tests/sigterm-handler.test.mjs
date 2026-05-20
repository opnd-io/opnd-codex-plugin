import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTempDir } from "./helpers.mjs";
import { __testHooks } from "../plugins/opnd-codex/scripts/lib/tracked-jobs.mjs";
import { writeJobFile, ensureStateDir, resolveJobFile } from "../plugins/opnd-codex/scripts/lib/state.mjs";

// PR-1.2 (#228) regression — runTrackedJob installs SIGTERM/SIGINT/SIGHUP/SIGBREAK
// handlers around the runner so a foreground task that gets killed mid-run flushes
// its job to a terminal "terminated" state instead of leaving status="running"
// with a stale pid forever.

const { installForegroundSignalHandlers, markJobTerminated, SIGNAL_EXIT_CODES } = __testHooks;

test("markJobTerminated writes status=failed/phase=terminated to per-job file and index", async () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const job = {
    id: "task-test-sigterm",
    workspaceRoot,
    kind: "task",
    title: "Sigterm test",
    summary: "test"
  };
  const runningRecord = {
    ...job,
    status: "running",
    phase: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    logFile: null
  };
  writeJobFile(workspaceRoot, job.id, runningRecord);

  markJobTerminated(job, runningRecord, {}, "SIGTERM");

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, job.id), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "terminated");
  assert.equal(stored.pid, null);
  assert.equal(stored.failureReason, "signal:SIGTERM");
  assert.match(stored.errorMessage, /SIGTERM/);
  assert.ok(stored.completedAt, "completedAt timestamp recorded");
});

test("installForegroundSignalHandlers returns a cleanup that removes its listeners", () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);
  const job = {
    id: "task-test-cleanup",
    workspaceRoot,
    kind: "task",
    title: "Cleanup test",
    summary: "test"
  };
  const runningRecord = { ...job, status: "running", pid: process.pid, logFile: null };
  writeJobFile(workspaceRoot, job.id, runningRecord);

  const before = process.listenerCount("SIGTERM");
  const release = installForegroundSignalHandlers(job, runningRecord, {});
  assert.equal(process.listenerCount("SIGTERM"), before + 1, "SIGTERM listener installed");
  release();
  assert.equal(process.listenerCount("SIGTERM"), before, "SIGTERM listener removed by cleanup");
});

test("SIGNAL_EXIT_CODES uses Unix conventions", () => {
  assert.equal(SIGNAL_EXIT_CODES.SIGTERM, 143);
  assert.equal(SIGNAL_EXIT_CODES.SIGINT, 130);
  assert.equal(SIGNAL_EXIT_CODES.SIGHUP, 129);
});

test("end-to-end: spawning a foreground task and killing it leaves a terminal state", async (t) => {
  // Skip on Windows: the test relies on POSIX SIGTERM semantics. On Windows the
  // companion uses taskkill via terminateProcessTree, which the runtime suite
  // already exercises.
  if (process.platform === "win32") {
    t.skip("POSIX-only");
    return;
  }

  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);
  const job = {
    id: "task-e2e-sigterm",
    workspaceRoot,
    kind: "task",
    title: "E2E sigterm",
    summary: "test"
  };
  const runningRecord = { ...job, status: "running", pid: process.pid, logFile: null };
  writeJobFile(workspaceRoot, job.id, runningRecord);

  // Spawn an in-process "runner" that hangs forever, then send SIGTERM.
  const release = installForegroundSignalHandlers(job, runningRecord, {});

  // process.exit replacement: capture instead of actually exiting.
  const originalExit = process.exit;
  let capturedExitCode = null;
  process.exit = (code) => {
    capturedExitCode = code;
    throw new Error("process.exit called");
  };

  try {
    process.emit("SIGTERM");
  } catch (err) {
    assert.match(err.message, /process\.exit called/);
  } finally {
    process.exit = originalExit;
    release();
  }

  assert.equal(capturedExitCode, 143, "process.exit invoked with SIGTERM exit code");

  const stored = JSON.parse(fs.readFileSync(resolveJobFile(workspaceRoot, job.id), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "terminated");
  assert.equal(stored.failureReason, "signal:SIGTERM");
});
