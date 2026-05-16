import fs from "node:fs";
import process from "node:process";

import { getProcessStartTimeRaw, readJobFile, resolveJobFile, resolveJobLogFile, updateJobFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

// Truncate per-block body to keep job log files bounded. Long agent transcripts can run
// into MB of structured output; we keep the head with an explicit truncation marker.
const MAX_LOG_BLOCK_BYTES = 64 * 1024;
// Per-job stored `rendered` text. Headroom is generous so review/audit Markdown fits
// without truncation in the common case, but pathological multi-MB results stay bounded.
const MAX_RENDERED_BYTES = 1024 * 1024;

function truncateForLog(text, max = MAX_LOG_BLOCK_BYTES) {
  if (!text) {
    return "";
  }
  const str = String(text);
  if (str.length <= max) {
    return str;
  }
  const omitted = str.length - max;
  return `${str.slice(0, max)}\n[…${omitted} bytes truncated by tracked-jobs cap]`;
}

function truncateRendered(text, max = MAX_RENDERED_BYTES) {
  if (text == null) {
    return text;
  }
  const str = String(text);
  if (str.length <= max) {
    return str;
  }
  return `${str.slice(0, max)}\n[…${str.length - max} bytes truncated]`;
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  const safeBody = truncateForLog(String(body).trimEnd());
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${safeBody}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    updateJobFile(workspaceRoot, jobId, (storedJob) => (storedJob ? { ...storedJob, ...patch } : null));
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

// PR-1.2 (#228) — when the foreground entrypoint receives SIGTERM/SIGINT/SIGHUP
// without a registered handler Node exits immediately and runTrackedJob's catch
// block never runs, leaving status="running" + a stale pid in state.json. Install
// idempotent signal handlers around the runner invocation that flush the job to
// a terminal "terminated" status before re-raising the original signal exit.
//
// Process exit codes follow the Unix convention: SIGTERM=143, SIGINT=130, SIGHUP=129.
const SIGNAL_EXIT_CODES = { SIGTERM: 143, SIGINT: 130, SIGHUP: 129, SIGBREAK: 149 };
const SIGNAL_NAMES = Object.keys(SIGNAL_EXIT_CODES);

function markJobTerminated(job, runningRecord, options, signal) {
  const completedAt = nowIso();
  const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
  const failureReason = `signal:${signal}`;
  try {
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "terminated",
      errorMessage: `Foreground task received ${signal}; marking job terminated.`,
      failureReason,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
  } catch {
    // best-effort — the per-job file may already be unwritable in some teardown paths
  }
  try {
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "terminated",
      pid: null,
      errorMessage: `Foreground task received ${signal}; marking job terminated.`,
      failureReason,
      completedAt
    });
  } catch {
    // best-effort
  }
  try {
    appendLogLine(options.logFile ?? job.logFile ?? null, `Foreground task received ${signal}; marking job terminated.`);
  } catch {
    // ignore
  }
}

function installForegroundSignalHandlers(job, runningRecord, options) {
  let triggered = false;
  const installed = [];
  const handler = (signal) => {
    if (triggered) {
      return;
    }
    triggered = true;
    markJobTerminated(job, runningRecord, options, signal);
    // Detach the handler so a second signal does not re-enter the cleanup path.
    cleanup();
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  };

  for (const signal of SIGNAL_NAMES) {
    try {
      const bound = () => handler(signal);
      process.on(signal, bound);
      installed.push([signal, bound]);
    } catch {
      // Some signals (e.g. SIGBREAK on POSIX) are not supported; skip silently.
    }
  }

  function cleanup() {
    for (const [signal, bound] of installed) {
      try {
        process.removeListener(signal, bound);
      } catch {
        // ignore
      }
    }
  }

  return cleanup;
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    // PR-1.1 (#222) — record the OS-reported birth time so the reaper can
    // detect PID reuse (kill(pid,0) succeeds against a recycled PID, but the
    // birth time of the new process will not match this recorded value).
    processStartedAt: getProcessStartTimeRaw(process.pid),
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  const releaseSignalHandlers = installForegroundSignalHandlers(job, runningRecord, options);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: truncateRendered(execution.rendered)
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  } finally {
    releaseSignalHandlers();
  }
}

// PR-1.2 (#228) — exposed for the SIGTERM-handler contract. Internal only.
export const __testHooks = {
  installForegroundSignalHandlers,
  markJobTerminated,
  SIGNAL_EXIT_CODES
};
