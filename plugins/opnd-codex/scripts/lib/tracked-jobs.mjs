import fs from "node:fs";
import process from "node:process";

import {
  getProcessStartTimeRaw,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  updateJobFile,
  upsertJob,
  writeJobFile,
  writeTaskSession
} from "./state.mjs";
import { hashText } from "./task-identity.mjs";
import { createTraceId, emitEvent } from "./telemetry.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

// PR-7.4 (#134) — opt-in audible completion bell. When the user sets
// CODEX_PLUGIN_BELL_ON_COMPLETE=1, every terminal-state transition in a
// tracked job (completed / failed / cancelled / terminated / timeout)
// writes a single ASCII BEL character (`\x07`) to stderr. Stays cross-OS
// without any native dependency: every common terminal (xterm, Terminal,
// iTerm2, Windows Terminal, ConEmu, VSCode integrated terminal, Git Bash)
// honors BEL when its own "bell sound" setting is on, and silently no-ops
// when off. Defaults to off so plugin invocations never produce surprise
// audio.
const BELL_ENV = "CODEX_PLUGIN_BELL_ON_COMPLETE";
const BELL_CHAR = "\x07";

function shouldRingCompletionBell(env = process.env) {
  const raw = String(env[BELL_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function maybeRingCompletionBell(env = process.env) {
  if (!shouldRingCompletionBell(env)) return false;
  try {
    process.stderr.write(BELL_CHAR);
    return true;
  } catch {
    // best-effort; never break the job teardown path because stderr is broken
    return false;
  }
}

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

function extractRawResultText(execution) {
  return (
    (typeof execution?.payload?.rawOutput === "string" && execution.payload.rawOutput) ||
    (typeof execution?.payload?.codex?.stdout === "string" && execution.payload.codex.stdout) ||
    (typeof execution?.rendered === "string" && execution.rendered) ||
    ""
  );
}

function classifyFailure(job, execution) {
  const rawOutput =
    (typeof execution?.payload?.rawOutput === "string" && execution.payload.rawOutput) ||
    (typeof execution?.payload?.codex?.stdout === "string" && execution.payload.codex.stdout) ||
    "";
  const text = [
    rawOutput,
    execution?.payload?.failureMessage,
    execution?.payload?.errorMessage,
    execution?.rendered,
    execution?.error?.message
  ]
    .filter(Boolean)
    .join("\n");
  if (execution?.exitStatus === 0 && job?.jobClass === "task" && !rawOutput.trim()) {
    return "no_final_output";
  }
  if (execution?.exitStatus === 0) {
    return null;
  }
  if (/rate.?limit|429|quota/i.test(text)) return "rate-limit";
  if (/auth|login|sign in|access token|api key/i.test(text)) return "auth";
  if (/sandbox|permission denied|operation not permitted|eperm|eacces/i.test(text)) return "sandbox";
  if (/timeout|timed out|finalizing/i.test(text)) return "timeout";
  if (/approval|denied|rejected/i.test(text)) return "approval";
  if (/parse|json/i.test(text)) return "parse";
  return "other";
}

function buildResultDigest(job, execution, completionStatus, failureClass, completedAt) {
  const rawOutput = extractRawResultText(execution);
  const parsed = execution?.payload?.parsedResult ?? execution?.payload?.result ?? null;
  const verdict =
    (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.verdict === "string"
      ? parsed.verdict
      : null) ?? (completionStatus === "completed" ? "completed" : "failed");
  const summary =
    (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.summary === "string"
      ? parsed.summary
      : null) ??
    execution?.summary ??
    rawOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ??
    "";
  return {
    schemaVersion: 1,
    jobId: job.id,
    status: completionStatus,
    failureClass: failureClass ?? null,
    verdict,
    summary,
    outputHash: hashText(rawOutput),
    renderedHash: hashText(execution?.rendered ?? ""),
    threadId: execution?.threadId ?? null,
    turnId: execution?.turnId ?? null,
    taskKey: job?.taskKey ?? null,
    taskFingerprint: job?.taskFingerprint ?? null,
    promptHash: job?.promptHash ?? null,
    capsuleHash: job?.capsuleHash ?? null,
    outputProfile: job?.outputProfile ?? null,
    completedAt
  };
}

function registerTaskSession(job, execution, resultDigest) {
  if (!job?.taskKey || !execution?.threadId || resultDigest.status !== "completed") {
    return;
  }
  try {
    writeTaskSession(job.workspaceRoot, {
      taskKey: job.taskKey,
      taskFingerprint: job.taskFingerprint ?? null,
      promptHash: job.promptHash ?? null,
      capsuleHash: job.capsuleHash ?? null,
      outputProfile: job.outputProfile ?? null,
      threadId: execution.threadId,
      turnId: execution.turnId ?? null,
      jobId: job.id,
      summary: resultDigest.summary,
      executionContractHash: job.executionContractHash ?? null,
      codexHomeMode: job.codexHomeMode ?? null,
      codexHomeHash: job.codexHomeHash ?? null,
      fanOutGroupId: job.fanOutGroupId ?? null
    });
  } catch (error) {
    appendLogLine(job.logFile ?? null, `Task-session registry write skipped: ${error?.message ?? error}`);
  }
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
  // PR-9.1 — terminated event. Best-effort: emitEvent itself never throws,
  // but we still wrap to match the rest of this teardown path's belt-and-
  // suspenders error swallowing.
  try {
    const startedAtMs = Date.parse(runningRecord.startedAt ?? "");
    emitEvent("terminated", {
      traceId: runningRecord.traceId ?? job.traceId,
      jobId: job.id,
      jobClass: job.jobClass ?? job.kind ?? "task",
      phase: "terminated",
      cwd: job.workspaceRoot,
      elapsedMs: Number.isFinite(startedAtMs) ? Date.parse(completedAt) - startedAtMs : undefined,
      errorClass: "other",
      signal
    });
  } catch {
    // ignore
  }
  // PR-7.4 (#134) — signal-terminated is still a terminal state, so the
  // bell fires for it too. Ordered AFTER the log/state writes + telemetry
  // emit so a bell sound means "all teardown done", not "teardown started".
  maybeRingCompletionBell();
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
  const startedAt = nowIso();
  // PR-9.2 — prefer the trace id propagated by enqueueBackgroundTask (or
  // any other upstream). Foreground tasks have no prior emit, so synthesize
  // one here so their lifecycle still appears as a single correlated thread
  // in the telemetry stream.
  const traceId = job.traceId ?? createTraceId();
  const startedAtMs = Date.parse(startedAt);
  const runningRecord = {
    ...job,
    status: "running",
    startedAt,
    phase: "starting",
    pid: process.pid,
    traceId,
    // PR-1.1 (#222) — record the OS-reported birth time so the reaper can
    // detect PID reuse (kill(pid,0) succeeds against a recycled PID, but the
    // birth time of the new process will not match this recorded value).
    processStartedAt: getProcessStartTimeRaw(process.pid),
    logFile: options.logFile ?? job.logFile ?? null
  };
  // PR-9.1 audit finding #2 — if the pre-run state persistence throws,
  // both the `started` emit and the throw-path `failed` emit (inside the
  // try/catch below) would be skipped, leaving the job invisible to
  // telemetry. Wrap the state writes so a failure here still emits a
  // `failed` event with the trace id we already have, then re-throws.
  try {
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
  } catch (initError) {
    emitEvent("failed", {
      traceId,
      jobId: job.id,
      jobClass: job.jobClass ?? job.kind ?? "task",
      phase: "starting",
      cwd: job.workspaceRoot,
      errorClass: "other",
      errorMessage: initError instanceof Error ? initError.message : String(initError),
      stage: "pre-run-state-persist"
    });
    throw initError;
  }

  // PR-9.1 — start event. Includes the cwd/jobClass so consumers can split
  // the stream by repo / by command without re-reading the per-job records.
  emitEvent("started", {
    traceId,
    jobId: job.id,
    jobClass: job.jobClass ?? job.kind ?? "task",
    phase: "starting",
    cwd: job.workspaceRoot
  });

  const releaseSignalHandlers = installForegroundSignalHandlers(job, runningRecord, options);

  try {
    const rawExecution = await runner();
    const failureClass = classifyFailure(job, rawExecution);
    const execution =
      failureClass && rawExecution.exitStatus === 0
        ? {
            ...rawExecution,
            exitStatus: 1,
            payload: {
              ...(rawExecution.payload ?? {}),
              failureClass,
              failureMessage:
                rawExecution.payload?.failureMessage ??
                (failureClass === "no_final_output"
                  ? "Codex completed without a final assistant message."
                  : `Codex run classified as ${failureClass}.`)
            }
          }
        : rawExecution;
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const resultDigest = buildResultDigest(job, execution, completionStatus, failureClass, completedAt);
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: truncateRendered(execution.rendered),
      resultDigest,
      failureClass: failureClass ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      resultDigest,
      failureClass: failureClass ?? null
    });
    registerTaskSession(job, execution, resultDigest);
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);

    // PR-9.1 — terminal event for the success path (or runner-reported
    // non-zero exit). elapsedMs is wall-clock since startedAt to keep the
    // stream meaningful across long pauses.
    emitEvent(completionStatus, {
      traceId,
      jobId: job.id,
      jobClass: job.jobClass ?? job.kind ?? "task",
      phase: completionStatus === "completed" ? "done" : "failed",
      cwd: job.workspaceRoot,
      elapsedMs: Number.isFinite(startedAtMs) ? Date.parse(completedAt) - startedAtMs : undefined,
      threadId: execution.threadId ?? undefined,
      failureClass: failureClass ?? undefined,
      outputProfile: job.outputProfile ?? undefined,
      taskKey: job.taskKey ?? undefined
    });

    // PR-7.4 (#134) — opt-in audible completion bell. No-op unless the
    // user set CODEX_PLUGIN_BELL_ON_COMPLETE=1.
    maybeRingCompletionBell();

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

    // PR-9.1 — terminal event for the throw path. We deliberately do not
    // try to classify the error here (errorClass is left undefined) so the
    // emit stays cheap and unambiguous. Downstream code that has more
    // context (rate-limit / auth / sandbox / timeout) can emit a dedicated
    // `failed` event with errorClass set before the throw reaches us.
    emitEvent("failed", {
      traceId,
      jobId: job.id,
      jobClass: job.jobClass ?? job.kind ?? "task",
      phase: "failed",
      cwd: job.workspaceRoot,
      elapsedMs: Number.isFinite(startedAtMs) ? Date.parse(completedAt) - startedAtMs : undefined,
      errorMessage
    });

    // PR-7.4 (#134) — bell on failure too. Symmetric with the success path
    // so the user knows ANY terminal state triggered the bell, not just
    // success.
    maybeRingCompletionBell();

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
