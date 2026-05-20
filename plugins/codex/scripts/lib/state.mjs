import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const TASK_SESSIONS_DIR_NAME = "task-sessions";
const MAX_JOBS = 50;
const LOCK_DIR_NAME = ".lock";
const BROKER_LOCK_DIR_NAME = ".broker.lock";
const READ_RETRY_COUNT = 5;
const READ_RETRY_DELAY_MS = 20;
const LOCK_RETRY_COUNT = 100;
const LOCK_RETRY_DELAY_MS = 20;
const STALE_LOCK_MS = 30000;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveTaskSessionsDir(cwd) {
  return path.join(resolveStateDir(cwd), TASK_SESSIONS_DIR_NAME);
}

function resolveLockDir(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
  fs.mkdirSync(resolveTaskSessionsDir(cwd), { recursive: true });
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export function isPidRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

// PR-1.1 (#222 / #164 / #202 / #264) — OS-level process birth time, used as a
// PID-reuse guard alongside isPidRunning. Returns the raw OS-reported value as
// a string (no parsing required since we only need equality comparison between
// the recorded value and the current value). Returns null on any error so
// callers can degrade gracefully.
//
// Per Codex audit C9 mitigation: kill(pid,0) alone is insufficient because the
// OS may have recycled the PID for an unrelated process. Comparing recorded vs.
// current birth time catches the recycle case without requiring kernel-level
// process tokens.
export function getProcessStartTimeRaw(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  try {
    if (process.platform === "linux") {
      // /proc/<pid>/stat field 22 is "starttime" (jiffies since boot). The
      // command field (#2) is wrapped in parentheses and may contain spaces, so
      // split on the LAST `)` to skip past it.
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/);
      // Field 22 of the original line == index 19 of `tail` (fields 3..52).
      return tail[19] ?? null;
    }
  } catch {
    return null;
  }

  try {
    if (process.platform === "darwin") {
      const result = childProcessSpawnSync("ps", ["-o", "lstart=", "-p", String(pid)]);
      if (result?.status === 0) {
        const text = String(result.stdout ?? "").trim();
        return text || null;
      }
    } else if (process.platform === "win32") {
      // wmic is being deprecated but is universally available on supported
      // Windows hosts. Powershell's Get-Process .StartTime is more durable but
      // launching it costs ~300ms; reaper hot path stays cheap with wmic.
      const result = childProcessSpawnSync("wmic", [
        "process",
        "where",
        `ProcessId=${pid}`,
        "get",
        "CreationDate",
        "/format:value"
      ]);
      if (result?.status === 0) {
        const match = String(result.stdout ?? "").match(/CreationDate=(\S+)/);
        return match?.[1] ?? null;
      }
    } else {
      // Other POSIX (FreeBSD, etc.) — best-effort lstart.
      const result = childProcessSpawnSync("ps", ["-o", "lstart=", "-p", String(pid)]);
      if (result?.status === 0) {
        const text = String(result.stdout ?? "").trim();
        return text || null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

// Helper indirection — exposed so tests can inject a fake spawnSync without
// real subprocess overhead. Default uses node:child_process spawnSync with a
// short timeout so a slow ps/wmic call cannot stall the reaper hot path.
const defaultSpawnSync = (cmd, args) =>
  nodeSpawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 2000 });
let childProcessSpawnSync = defaultSpawnSync;

export function __setSpawnSyncForTests(fn) {
  childProcessSpawnSync = typeof fn === "function" ? fn : defaultSpawnSync;
}

// PR-1.1 — given a stored job entry, decide whether the recorded pid still
// belongs to the same Codex worker. Returns true only when isPidRunning AND
// (no recorded processStartedAt OR current matches recorded). Otherwise the
// caller should reap the entry as failed.
export function isJobProcessAlive(job) {
  const pid = Number(job?.pid);
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  if (!isPidRunning(pid)) {
    return false;
  }
  const recordedStart = job?.processStartedAt ?? null;
  if (!recordedStart) {
    // Legacy jobs predating PR-1.1 don't carry a recorded birth time. Trust
    // isPidRunning for those — the reaper will only reap when kill(pid,0) fails.
    return true;
  }
  const currentStart = getProcessStartTimeRaw(pid);
  if (!currentStart) {
    // OS-level lookup failed (unsupported platform, transient error). Fall back
    // to liveness only; this matches v1.0.4 behavior.
    return true;
  }
  return String(currentStart) === String(recordedStart);
}

function readLockOwnerPid(lockDir) {
  try {
    const [pidLine] = fs.readFileSync(path.join(lockDir, "owner"), "utf8").split(/\r?\n/);
    return Number(pidLine);
  } catch {
    return Number.NaN;
  }
}

function normalizeState(parsed) {
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function readJsonFileWithRetry(filePath, fallback, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < READ_RETRY_COUNT; attempt += 1) {
    if (!fs.existsSync(filePath)) {
      return fallback();
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      if (attempt < READ_RETRY_COUNT - 1) {
        sleepSync(READ_RETRY_DELAY_MS);
      }
    }
  }

  if (options.throwOnInvalid) {
    throw lastError;
  }
  return fallback();
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(tempFile, content, "utf8");
  try {
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    removeFileIfExists(tempFile);
    throw error;
  }
}

function tryAcquireLockOnce(cwd, lockDirName) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), lockDirName);
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return {
      acquired: true,
      release: () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup. A stale lock is handled on the next acquire.
        }
      }
    };
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    try {
      const ownerPid = readLockOwnerPid(lockDir);
      const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (!isPidRunning(ownerPid) || ageMs > STALE_LOCK_MS) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch {
      // The lock may have disappeared between attempts.
    }
    return { acquired: false, lockDir };
  }
}

function acquireMkdirLock(cwd, lockDirName, errorLabel) {
  let lockDir = null;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    const result = tryAcquireLockOnce(cwd, lockDirName);
    if (result.acquired) {
      return result.release;
    }
    lockDir = result.lockDir;
    sleepSync(LOCK_RETRY_DELAY_MS);
  }
  throw new Error(`Timed out waiting for ${errorLabel} at ${lockDir}.`);
}

// PR-1.4 — async lock acquirer. Same retry budget as the sync flavor but uses
// setTimeout so concurrent async callers in the SAME process can interleave
// (the sync path uses Atomics.wait which blocks the event loop and would
// deadlock when an async lock holder yields with `await`).
async function acquireMkdirLockAsync(cwd, lockDirName, errorLabel) {
  let lockDir = null;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    const result = tryAcquireLockOnce(cwd, lockDirName);
    if (result.acquired) {
      return result.release;
    }
    lockDir = result.lockDir;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
  throw new Error(`Timed out waiting for ${errorLabel} at ${lockDir}.`);
}

function acquireStateLock(cwd) {
  return acquireMkdirLock(cwd, LOCK_DIR_NAME, "Codex companion state lock");
}

// PR-1.4 (#286 race 3) — broker.json was previously read-modify-written without
// any cross-process synchronization. Two parallel /codex:* invocations from
// the same cwd both saw "no existing broker", both spawned a new app-server,
// and both wrote broker.json — last writer winning. The orphan broker process
// then sat in `/tmp/cxc-*` until the idle watchdog timed out. This dedicated
// lock dir (.broker.lock) gives broker-lifecycle.mjs the same mkdir-atomicity
// guarantee as the state lock while remaining independent (state writes and
// broker writes never block each other).
export function withBrokerLock(cwd, fn) {
  const release = acquireMkdirLock(cwd, BROKER_LOCK_DIR_NAME, "Codex companion broker lock");
  try {
    return fn();
  } finally {
    release();
  }
}

export async function withBrokerLockAsync(cwd, fn) {
  const release = await acquireMkdirLockAsync(cwd, BROKER_LOCK_DIR_NAME, "Codex companion broker lock");
  try {
    return await fn();
  } finally {
    release();
  }
}

function withStateLock(cwd, fn) {
  const release = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    release();
  }
}

export function loadState(cwd, options = {}) {
  const stateFile = resolveStateFile(cwd);
  const parsed = readJsonFileWithRetry(stateFile, defaultState, options);
  return normalizeState(parsed);
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd, { throwOnInvalid: true }).jobs;
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd, { throwOnInvalid: true });
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd, options = {}) {
  if (options.reap) {
    reapDeadJobs(cwd, options);
  }
  return loadState(cwd).jobs;
}

// PR-1.1 (#222 / #164 / #202 / #264) — sweep any job recorded as
// running/queued whose pid is no longer alive (or whose pid was recycled by
// the OS, detected via processStartedAt mismatch). Marks each as
// status="failed" + phase="terminated" + failureReason so subsequent
// /codex:status, /codex:result, --resume-last calls see a terminal state
// instead of an indefinitely "running" zombie.
//
// Idempotent. Safe to call from any read entrypoint. Best-effort: if the
// state lock is contested we skip rather than block, since the next read
// will reap on its own.
export function reapDeadJobs(cwd, options = {}) {
  const aliveCheck = options.aliveCheck ?? isJobProcessAlive;
  let reaped = [];
  try {
    updateState(cwd, (state) => {
      const completedAt = nowIso();
      for (const job of state.jobs) {
        if (job.status !== "running" && job.status !== "queued") {
          continue;
        }
        if (aliveCheck(job)) {
          continue;
        }
        const reason = !Number.isFinite(Number(job.pid))
          ? "no_pid_recorded"
          : isPidRunning(Number(job.pid))
          ? "pid_reused"
          : "process_died";
        job.status = "failed";
        job.phase = "terminated";
        job.pid = null;
        job.completedAt = completedAt;
        job.errorMessage = job.errorMessage ?? `Job reaped by liveness check (${reason}).`;
        job.failureReason = job.failureReason ?? `reaper:${reason}`;
        reaped.push({ id: job.id, reason });
      }
    });
  } catch {
    // Best-effort: another process may hold the state lock. Skip — the next
    // reader will reap. We never want the reaper to bubble an error up to the
    // status / result rendering path.
    return [];
  }
  // Mirror the terminal state into per-job files so individual /codex:result
  // calls see the same thing the index says. Done outside the lock to keep
  // the critical section short; if a per-job write fails we tolerate it.
  for (const { id, reason } of reaped) {
    try {
      updateJobFile(cwd, id, (storedJob) => {
        if (!storedJob) {
          return null;
        }
        if (storedJob.status === "completed" || storedJob.status === "failed") {
          return storedJob;
        }
        return {
          ...storedJob,
          status: "failed",
          phase: "terminated",
          pid: null,
          completedAt: nowIso(),
          errorMessage: storedJob.errorMessage ?? `Job reaped by liveness check (${reason}).`,
          failureReason: storedJob.failureReason ?? `reaper:${reason}`
        };
      });
    } catch {
      // tolerate
    }
  }
  return reaped;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function writeJobFile(cwd, jobId, payload) {
  return withStateLock(cwd, () => writeJobFileUnlocked(cwd, jobId, payload));
}

export function updateJobFile(cwd, jobId, mutate) {
  return withStateLock(cwd, () => {
    const jobFile = resolveJobFile(cwd, jobId);
    const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
    const next = mutate(existing);
    if (next == null) {
      return null;
    }
    writeJobFileUnlocked(cwd, jobId, next);
    return next;
  });
}

export function readJobFile(jobFile) {
  return readJsonFileWithRetry(jobFile, () => null, { throwOnInvalid: true });
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function sanitizeStateFileKey(value) {
  // `:` is intentionally NOT in the allow-list: auto capsule keys look
  // like `capsule:<hash>` and a literal `:` in a filename is the NTFS
  // alternate-data-stream separator on Windows (`capsule:hash.json`
  // would write a hidden stream on the `capsule` file). The logical
  // key keeps its `:` inside the JSON payload; only the on-disk name
  // is collapsed to `-`.
  const key = String(value ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key) {
    throw new Error("Task session key is required.");
  }
  return key.slice(0, 120);
}

export function resolveTaskSessionFile(cwd, taskKey) {
  ensureStateDir(cwd);
  return path.join(resolveTaskSessionsDir(cwd), `${sanitizeStateFileKey(taskKey)}.json`);
}

export function readTaskSession(cwd, taskKey) {
  const filePath = resolveTaskSessionFile(cwd, taskKey);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJsonFileWithRetry(filePath, () => null, { throwOnInvalid: true });
}

export function writeTaskSession(cwd, entry) {
  if (!entry?.taskKey) {
    throw new Error("Task session entry requires taskKey.");
  }
  return withStateLock(cwd, () => {
    const next = {
      ...entry,
      taskKey: sanitizeStateFileKey(entry.taskKey),
      updatedAt: nowIso()
    };
    writeFileAtomic(resolveTaskSessionFile(cwd, next.taskKey), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function invalidateTaskSession(cwd, taskKey, reason) {
  return withStateLock(cwd, () => {
    const filePath = resolveTaskSessionFile(cwd, taskKey);
    const existing = fs.existsSync(filePath) ? readJsonFileWithRetry(filePath, () => null, { throwOnInvalid: true }) : null;
    if (!existing) {
      return null;
    }
    const next = {
      ...existing,
      invalidatedAt: nowIso(),
      invalidationReason: String(reason ?? "invalidated")
    };
    writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
