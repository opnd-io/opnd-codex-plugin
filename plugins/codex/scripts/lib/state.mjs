import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_DIR_NAME = ".lock";
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

function resolveLockDir(cwd) {
  return path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isPidRunning(pid) {
  if (!Number.isFinite(pid)) {
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

function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockDir = resolveLockDir(cwd);
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      return () => {
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup. A stale lock is handled on the next acquire.
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
          continue;
        }
      } catch {
        // The lock may have disappeared between attempts.
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`Timed out waiting for Codex companion state lock at ${lockDir}.`);
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

export function listJobs(cwd) {
  return loadState(cwd).jobs;
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
