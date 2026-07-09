import { createHash } from "node:crypto";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
// telemetry.mjs 는 node builtin 만 import 하므로 여기로 되돌아오는 cycle 이 생길 수
// 없다. 그 상태를 유지할 것 — telemetry.mjs 의 회전 경로가 아래 lock helper 를
// 의도적으로 피하는 이유가 정확히 이것이다.
import { createTraceId, emitEvent } from "./telemetry.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// #338 — codex-namespaced plugin-data var. The SessionStart hook exports the
// CLAUDE_PLUGIN_DATA value under this name so command subprocesses can resolve
// the state dir without the hook having to hijack the generic CLAUDE_PLUGIN_DATA
// in the shared session env file.
const CODEX_PLUGIN_DATA_DIR_ENV = "CODEX_PLUGIN_DATA_DIR";
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

// 두 timestamp 중 하나라도 없거나 파싱 불가면 0 이 아니라 undefined 를 반환한다.
// emitEvent 가 지어낸 duration 을 기록하는 대신 필드를 버리도록.
function elapsedMsBetween(startedAt, completedAt) {
  const start = Date.parse(String(startedAt ?? ""));
  const end = Date.parse(String(completedAt ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  return end - start;
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
  const dirName = `${slug}-${hash}`;
  // #338 — prefer the codex-namespaced var (set by the SessionStart hook for
  // command subprocesses); fall back to the generic CLAUDE_PLUGIN_DATA which is
  // natively present in the hook context itself.
  const pluginDataDir = process.env[CODEX_PLUGIN_DATA_DIR_ENV] ?? process.env[PLUGIN_DATA_ENV];

  // #59 fix (manual port of upstream PR #125) — when CLAUDE_PLUGIN_DATA is
  // set the persistent state dir is authoritative, but a Bash command run
  // without that env (the common `/opnd-codex:*` invocation outside a hook) writes
  // to the tmpdir fallback instead. Without this migration the two contexts
  // see different state dirs and jobs appear lost across them. If state
  // exists ONLY in the tmpdir fallback, migrate it into the persistent
  // location so future reads/writes converge and state survives tmp cleanup.
  if (pluginDataDir) {
    const primaryDir = path.join(pluginDataDir, "state", dirName);
    const fallbackDir = path.join(FALLBACK_STATE_ROOT_DIR, dirName);
    if (
      !fs.existsSync(path.join(primaryDir, STATE_FILE_NAME)) &&
      fs.existsSync(path.join(fallbackDir, STATE_FILE_NAME))
    ) {
      fs.cpSync(fallbackDir, primaryDir, { recursive: true });
      // Rewrite paths in all migrated JSON files (state.json + jobs/*.json)
      // so logFile and other absolute references point to the persistent
      // location. Replace both raw paths and JSON-escaped paths (Windows
      // backslashes are doubled inside JSON strings).
      const escapedFallback = fallbackDir.replaceAll("\\", "\\\\");
      const escapedPrimary = primaryDir.replaceAll("\\", "\\\\");
      const rewritePaths = (filePath) => {
        try {
          let updated = fs.readFileSync(filePath, "utf8");
          const original = updated;
          updated = updated.replaceAll(fallbackDir, primaryDir);
          if (escapedFallback !== fallbackDir) {
            updated = updated.replaceAll(escapedFallback, escapedPrimary);
          }
          if (updated !== original) {
            fs.writeFileSync(filePath, updated, "utf8");
          }
        } catch {
          /* non-fatal — a migrated file that cannot be rewritten still works
             for state reads; only absolute path references degrade. */
        }
      };
      rewritePaths(path.join(primaryDir, STATE_FILE_NAME));
      const jobsDir = path.join(primaryDir, JOBS_DIR_NAME);
      if (fs.existsSync(jobsDir)) {
        for (const entry of fs.readdirSync(jobsDir)) {
          if (entry.endsWith(".json")) {
            rewritePaths(path.join(jobsDir, entry));
          }
        }
      }
    }
    return primaryDir;
  }

  return path.join(FALLBACK_STATE_ROOT_DIR, dirName);
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
    // OS 수준 조회 실패 (미지원 플랫폼, 일시적 에러, 미래 Windows 에서 제거된 `wmic`,
    // probe 를 막는 sandbox). liveness 만으로 폴백한다. v1.0.4 동작과 같다.
    //
    // C8 — 그 폴백은 pid-reuse guard 를 맨 kill(pid,0) 으로 조용히 격하시키는데,
    // 이것으로는 "우리 worker" 와 "그 pid 를 물려받은 무관한 프로세스" 를 구분할 수
    // 없다. 지금까지 보이지 않았다. 프로세스당 한 번 기록해, 몇 달 뒤 잘못 reap 된
    // job 으로 발견되는 대신 ledger 에 격하가 드러나게 한다.
    notePidGuardDegraded(pid);
    return true;
  }
  return String(currentStart) === String(recordedStart);
}

// warn-once latch. probe 는 구조적 이유로 실패한다 — `wmic` 부재, spawn 을 막는
// sandbox — 따라서 그 프로세스의 모든 pid 에 대해 실패하고, 이벤트 하나가 신호 전부를
// 담는다. trade-off 는 실재한다: *일시적* 인 첫 실패가 같은 프로세스의 이후 다른 원인
// 보고를 억제한다. 수명이 짧은 CLI 에서는 허용 가능하고, 유일한 장수 프로세스인
// broker 는 reap 하지 않는다.
let pidGuardDegradedNoticeEmitted = false;

/** 테스트 전용: C8 warn-once latch 를 초기화한다. */
export function __resetPidGuardDegradedNotice() {
  pidGuardDegradedNoticeEmitted = false;
}

function notePidGuardDegraded(pid) {
  if (pidGuardDegradedNoticeEmitted) {
    return;
  }
  // 신호가 실제로 stream 에 들어간 뒤에만 latch 한다. 먼저 세우면 write 실패(디스크
  // 가득, 쓰기 불가한 telemetry dir)가 격하를 보고하는 그 하나의 이벤트를 조용히
  // 버렸다 — 이 코드가 표면화하려던 바로 그것을.
  // telemetry 가 비활성일 때도 `emitEvent` 는 false 를 반환한다. 그 경우 기록할 것이
  // 없고, 재시도 비용은 값싼 early return 뿐이다.
  pidGuardDegradedNoticeEmitted = emitEvent("progress", {
    traceId: createTraceId(),
    phase: "pid_guard_degraded",
    pidGuard: "liveness-only",
    platform: process.platform,
    probedPid: pid
  });
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
// any cross-process synchronization. Two parallel /opnd-codex:* invocations from
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

// C7 — 상한이 status 를 보지 않았다: job 을 `updatedAt` 으로 정렬해 MAX_JOBS 를 넘는
// 것을 로그 파일과 함께 버렸다. 마지막 progress write 가 더 새로운 job 50개 뒤로 밀린
// 장수 `running` / `queued` job 은 그래서 *아직 실행 중인데도* 인덱스에서 쫓겨나고
// 로그가 unlink 되어, 추적 불가능한 orphan 프로세스를 남겼다.
//
// active job 은 절대 쫓아내지 않는다. 상한은 여전히 terminal job 에 적용되므로 정상
// 사용에서 인덱스가 무한히 자라지 않는다. 멈춘 `running` 항목이 병적으로 쌓이는 것은
// pruner 가 아니라 reaper 가 다룰 문제다.
const ACTIVE_JOB_STATUSES = new Set(["running", "queued"]);

function pruneJobs(jobs) {
  const byRecency = [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  const active = byRecency.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  const terminal = byRecency.filter((job) => !ACTIVE_JOB_STATUSES.has(job.status));
  const terminalBudget = Math.max(0, MAX_JOBS - active.length);
  const retained = new Set([...active, ...terminal.slice(0, terminalBudget)]);
  // 나머지 코드가 기대하는 최신순 정렬을 보존한다.
  return byRecency.filter((job) => retained.has(job));
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
// /opnd-codex:status, /opnd-codex:result, --resume-last calls see a terminal state
// instead of an indefinitely "running" zombie.
//
// 멱등하다. 어떤 read entrypoint 에서 호출해도 안전하다. best-effort: state lock 이
// 경합 중이면 block 하지 않고 건너뛴다 — 다음 read 가 알아서 reap 한다.
// #21 (F3 defense-in-depth) — `process_died` means the recorded pid is
// genuinely gone (not recycled, not "no pid"), yet the job never reached a
// terminal state on its own. On Windows the dominant cause is an EXTERNAL kill:
// a foreground codex task hosted inside a `codex-rescue` subagent gets
// terminated when that subagent's kill-on-close Job Object closes at turn end.
// Surfacing that likely cause + remedy keeps it from being misread as a
// watchdog/timeout. `failureReason` stays the machine-readable `reaper:*`.
// C11 — `queued` job 은 *아직* pid 가 없다: dispatcher 는 worker 를 spawn 한 뒤에야
// pid 를 기록한다. 따라서 "queued && pid 없음" 으로 reap 하면 단지 dispatch 중이던
// job 을 죽였고, 이는 `broker-ambiguous` 가 job 을 세워 두는 상태이기도 하다 (broker
// 에는 닿았으나 명확한 응답이 없어, local-spawn 하면 worker 중복 위험). dispatch 에
// 유예 창을 준다. 그 너머면 job 은 정말 유실된 것이고, 영원한 "queued" 보다 그렇게
// 말하는 편이 낫다.
export const QUEUED_DISPATCH_GRACE_MS = 60_000;

function queuedDispatchStillPlausible(job, nowMs) {
  const stamp = Date.parse(String(job.updatedAt ?? job.createdAt ?? job.startedAt ?? ""));
  if (!Number.isFinite(stamp)) {
    return false; // 신뢰할 timestamp 없음 — 유실로 간주
  }
  return nowMs - stamp < QUEUED_DISPATCH_GRACE_MS;
}

// 이 job 이 reap 대상인가? 읽기 전용 pre-scan 과 쓰기 경로가 공유하므로, 무엇을 죽은
// 것으로 볼지 둘의 판정이 어긋날 수 없다.
function shouldReap(job, aliveCheck, nowMs) {
  if (job.status !== "running" && job.status !== "queued") {
    return false;
  }
  const pidValue = Number(job.pid);
  const hasPid = Number.isFinite(pidValue) && pidValue > 0;
  if (!hasPid && job.status === "queued" && queuedDispatchStillPlausible(job, nowMs)) {
    return false;
  }
  return !aliveCheck(job);
}

export function reapErrorMessage(reason) {
  if (reason === "dispatch_lost") {
    return (
      "Job reaped by liveness check (dispatch_lost): it stayed queued without a worker process. " +
      "The broker was reached but never confirmed a spawn (broker-ambiguous), or the dispatch died before " +
      "recording a pid. Re-run the request; nothing was executed."
    );
  }
  if (reason === "process_died") {
    return (
      "Job reaped by liveness check (process_died): the worker process is gone but never reported completion. " +
      "On Windows this usually means it was terminated externally when its spawning context ended — e.g. a " +
      "codex-rescue subagent's Job Object closing at turn end (issue #21). Prefer a broker-routed/background " +
      "launch (`--background`, then `/opnd-codex:result --wait <jobId>`) so the worker survives subagent teardown."
    );
  }
  return `Job reaped by liveness check (${reason}).`;
}

export function reapDeadJobs(cwd, options = {}) {
  const aliveCheck = options.aliveCheck ?? isJobProcessAlive;
  const nowMs = options.nowMs ?? Date.now();

  // 읽기 전용 pre-scan. `updateState` 는 state lock 을 잡고, mutator 가 아무것도 바꾸지
  // 않아도 state.json 을 무조건 다시 쓴다. 이제 모든 read entrypoint 가 reap 하며
  // `--wait` poll 루프도 tick 마다 한 번씩 그렇게 하므로, 압도적으로 흔한 "reap 할 것
  // 없음" 경우는 lock 도 디스크도 건드리면 안 된다.
  //
  // 여기서의 throw 는 "reap 할 것 없음" 이 *아니다*: 판단할 수 없었다는 뜻이다. 빈
  // 결과로 삼키지 말고 lock 경로로 흘려보낸다 — fast path 는 불필요함을 증명한 일만
  // 건너뛸 수 있다.
  try {
    if (!loadState(cwd).jobs.some((job) => shouldReap(job, aliveCheck, nowMs))) {
      return [];
    }
  } catch {
    // 흘려보낸다
  }

  let reaped = [];
  try {
    updateState(cwd, (state) => {
      const completedAt = nowIso();
      for (const job of state.jobs) {
        // lock 아래서 재평가한다. 위 pre-scan 은 fast path 일 뿐이다.
        if (!shouldReap(job, aliveCheck, nowMs)) {
          continue;
        }
        // `Number(null)` 은 0 이고 Number.isFinite 를 통과한다 — 그래서 `pid: null` 인
        // 레코드(모든 queued job, 그리고 reaper 가 이미 손댄 모든 job)가 "pid 없음" 이
        // 아니라 `process_died` 로 분류되곤 했다. isJobProcessAlive 자신의 `pid > 0`
        // 검사를 그대로 따른다.
        const pidValue = Number(job.pid);
        const hasPid = Number.isFinite(pidValue) && pidValue > 0;
        const reason = !hasPid
          ? job.status === "queued"
            ? "dispatch_lost"
            : "no_pid_recorded"
          : isPidRunning(pidValue)
          ? "pid_reused"
          : "process_died";
        job.status = "failed";
        job.phase = "terminated";
        job.pid = null;
        job.completedAt = completedAt;
        job.errorMessage = job.errorMessage ?? reapErrorMessage(reason);
        job.failureReason = job.failureReason ?? `reaper:${reason}`;
        reaped.push({
          id: job.id,
          reason,
          jobClass: job.jobClass ?? job.kind ?? "task",
          traceId: job.traceId ?? null,
          startedAt: job.startedAt ?? null,
          completedAt
        });
      }
    });
  } catch {
    // Best-effort: another process may hold the state lock. Skip — the next
    // reader will reap. We never want the reaper to bubble an error up to the
    // status / result rendering path.
    return [];
  }

  // O5 — 외부에서 죽은 job 이 terminal 상태에 도달하는 유일한 지점이 reaper 다: 외부
  // TerminateProcess(Windows 의 지배적 경우)는 가로챌 수 없으므로 SIGTERM 핸들러가
  // 돌지 않고, job 자신의 프로세스에서는 terminal 이벤트가 나오지 않는다. 이 emit 이
  // 없으면 실행의 약 7% 가 terminal 이벤트 없는 `started` 로 남고, ledger 에서 읽는
  // 모든 완료율이 낙관 편향된다.
  for (const entry of reaped) {
    emitEvent("terminated", {
      traceId: entry.traceId ?? createTraceId(),
      jobId: entry.id,
      jobClass: entry.jobClass,
      phase: "terminated",
      cwd,
      elapsedMs: elapsedMsBetween(entry.startedAt, entry.completedAt),
      errorClass: entry.reason === "no_pid_recorded" ? "other" : "broker",
      reason: `reaper:${entry.reason}`
    });
  }
  // Mirror the terminal state into per-job files so individual /opnd-codex:result
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
          errorMessage: storedJob.errorMessage ?? reapErrorMessage(reason),
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

// #18 (capture-first) — the detached task-worker's own stdout/stderr (Node crash
// traces, `main().catch` writes) go here instead of being discarded to a null
// sink, so a silent worker death (e.g. a Windows Job Object kill-on-close) leaves
// a diagnosable artifact. Distinct from `${jobId}.log`, which only carries the
// JSON-RPC progress notifications routed through the broker.
export function resolveWorkerStdioFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.worker.log`);
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
