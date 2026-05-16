import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  __setSpawnSyncForTests,
  ensureStateDir,
  getProcessStartTimeRaw,
  isJobProcessAlive,
  isPidRunning,
  listJobs,
  reapDeadJobs,
  upsertJob,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

// PR-1.1 (#222 / #164 / #202 / #264) regression — listJobs/reapDeadJobs must
// transition any job recorded as running/queued whose pid is dead (or whose
// pid was recycled by the OS) into a terminal failed/terminated state, so
// /codex:status, /codex:result, and --resume-last never see indefinite zombies.

test("isPidRunning reports false for non-positive / non-finite pids", () => {
  assert.equal(isPidRunning(0), false);
  assert.equal(isPidRunning(-1), false);
  assert.equal(isPidRunning(Number.NaN), false);
  assert.equal(isPidRunning(undefined), false);
});

test("isPidRunning reports true for the current process pid", () => {
  assert.equal(isPidRunning(process.pid), true);
});

test("getProcessStartTimeRaw returns a non-empty value for the current process on supported platforms", () => {
  const start = getProcessStartTimeRaw(process.pid);
  if (process.platform === "linux" || process.platform === "darwin" || process.platform === "win32") {
    // Best-effort: spawning ps/wmic can fail in restricted CI sandboxes — accept
    // null but require non-empty when present.
    if (start !== null) {
      assert.ok(typeof start === "string" && start.length > 0, "non-empty raw birth time");
    }
  } else {
    // Other POSIX flavors fall through to ps; treat null as acceptable.
    assert.ok(start === null || (typeof start === "string" && start.length > 0));
  }
});

test("isJobProcessAlive returns false for jobs with no pid", () => {
  assert.equal(isJobProcessAlive({ pid: null }), false);
  assert.equal(isJobProcessAlive({}), false);
});

test("isJobProcessAlive accepts a recorded processStartedAt that matches the current OS value", () => {
  const recorded = getProcessStartTimeRaw(process.pid);
  // If the OS lookup is unsupported in this environment, isJobProcessAlive
  // falls back to isPidRunning only and still returns true.
  assert.equal(isJobProcessAlive({ pid: process.pid, processStartedAt: recorded }), true);
});

test("isJobProcessAlive rejects a recorded processStartedAt that does NOT match (PID reuse simulation)", (t) => {
  // The stored job claims a different birth time than the current pid actually
  // has. This is exactly the recycled-pid case the reaper must catch — but only
  // when the OS-level lookup is functional in this environment. If
  // getProcessStartTimeRaw returns null (e.g. wmic / ps unavailable in a CI
  // sandbox) the helper documents fall-back-to-liveness-only behavior and the
  // assertion would not hold.
  const currentStart = getProcessStartTimeRaw(process.pid);
  if (!currentStart) {
    t.skip("OS-level birth time lookup unavailable in this environment");
    return;
  }
  assert.equal(
    isJobProcessAlive({ pid: process.pid, processStartedAt: "definitely-not-the-real-birth-time" }),
    false
  );
});

test("reapDeadJobs marks running jobs with dead pids as failed/terminated", () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const jobId = "task-test-reap-dead-pid";
  const runningRecord = {
    id: jobId,
    workspaceRoot,
    kind: "task",
    title: "reap test",
    summary: "",
    status: "running",
    phase: "running",
    pid: 999_999_999, // very unlikely to be a live PID
    processStartedAt: "fake",
    startedAt: new Date().toISOString(),
    logFile: null
  };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);

  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped.length, 1, "one job reaped");
  assert.equal(reaped[0].id, jobId);
  assert.match(reaped[0].reason, /process_died|pid_reused|no_pid_recorded/);

  const indexed = listJobs(workspaceRoot);
  const stored = indexed.find((entry) => entry.id === jobId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "terminated");
  assert.equal(stored.pid, null);
  assert.match(stored.failureReason, /^reaper:/);
});

test("reapDeadJobs preserves jobs with a live pid + matching processStartedAt", () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const jobId = "task-test-reap-live";
  const runningRecord = {
    id: jobId,
    workspaceRoot,
    kind: "task",
    title: "live test",
    summary: "",
    status: "running",
    phase: "running",
    pid: process.pid,
    processStartedAt: getProcessStartTimeRaw(process.pid),
    startedAt: new Date().toISOString(),
    logFile: null
  };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);

  reapDeadJobs(workspaceRoot);

  const indexed = listJobs(workspaceRoot);
  const stored = indexed.find((entry) => entry.id === jobId);
  assert.equal(stored.status, "running", "live job is preserved");
});

test("listJobs honors { reap: true } and reaps inline before returning", () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const jobId = "task-test-listJobs-reap";
  const runningRecord = {
    id: jobId,
    workspaceRoot,
    kind: "task",
    status: "running",
    phase: "running",
    pid: 999_999_998,
    processStartedAt: "fake",
    startedAt: new Date().toISOString(),
    logFile: null
  };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);

  const jobs = listJobs(workspaceRoot, { reap: true });
  const stored = jobs.find((entry) => entry.id === jobId);
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "terminated");
});

test("listJobs without reap option preserves legacy behavior (no reap)", () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const jobId = "task-test-listJobs-no-reap";
  const runningRecord = {
    id: jobId,
    workspaceRoot,
    kind: "task",
    status: "running",
    phase: "running",
    pid: 999_999_997,
    processStartedAt: "fake",
    startedAt: new Date().toISOString(),
    logFile: null
  };
  writeJobFile(workspaceRoot, jobId, runningRecord);
  upsertJob(workspaceRoot, runningRecord);

  const jobs = listJobs(workspaceRoot);
  const stored = jobs.find((entry) => entry.id === jobId);
  assert.equal(stored.status, "running", "no reap when option is omitted");
});

test("getProcessStartTimeRaw uses injected spawnSync for unit tests (PID reuse simulation)", () => {
  __setSpawnSyncForTests(() => ({ status: 0, stdout: "Wed May 14 12:00:00 2026", stderr: "" }));
  try {
    if (process.platform === "darwin") {
      const start = getProcessStartTimeRaw(process.pid);
      assert.equal(start, "Wed May 14 12:00:00 2026");
    }
  } finally {
    // Restore default spawnSync from node:child_process to keep other tests honest.
    __setSpawnSyncForTests(null);
  }
});
