/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   finalizingPhaseTimer: ReturnType<typeof setTimeout> | null,
 *   finalizingStartedAt: number | null,
 *   finalizingTimeoutMs: number,
 *   watchdogTimer: ReturnType<typeof setTimeout> | null,
 *   watchdogMs: number | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import fs from "node:fs";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { clearBrokerSession, loadBrokerSession, teardownBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { withBrokerLockAsync } from "./state.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
// Cap notifications buffered before the initial turn id is known. Drops the oldest entry on
// overflow so a stuck startRequest cannot grow the queue without bound.
const MAX_BUFFERED_NOTIFICATIONS = 4096;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
// PR-1.3 (#183) — bound the "finalizing" phase so a hung spark-model turn or
// cancel-without-interrupt cannot leave the job pinned at status=running forever.
// Override via CODEX_FINALIZING_PHASE_TIMEOUT_MS for slow CI / sandboxed reviews.
const FINALIZING_PHASE_TIMEOUT_MS = (() => {
  const override = Number(process.env.CODEX_FINALIZING_PHASE_TIMEOUT_MS);
  if (Number.isFinite(override) && override > 0) {
    return override;
  }
  return 5 * 60 * 1000;
})();

// A2 fix (docs/code-review/2026-05-20-pair-readiness-adversarial.md) — the
// per-turn inactivity watchdog now defaults ON. It measures SILENCE between
// JSON-RPC notifications (not total turn time), so a generous 10 min default
// never trips a healthy turn (which emits progress continuously) yet still
// bounds a fully-stuck broker. Override via CODEX_TURN_WATCHDOG_MS (ms);
// set 0 to disable. An explicit `watchdogMs` option still wins over both.
const DEFAULT_TURN_WATCHDOG_MS = 10 * 60 * 1000;
function resolveDefaultTurnWatchdogMs() {
  const override = Number(process.env.CODEX_TURN_WATCHDOG_MS);
  if (Number.isFinite(override) && override >= 0) {
    return override > 0 ? override : null;
  }
  return DEFAULT_TURN_WATCHDOG_MS;
}

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

// PR-2.1 (#240 / #167 / #304) BREAKING — omit `sandbox` from thread/start +
// thread/resume requests when the caller did not explicitly pass one, so the
// app-server falls back to whatever the user configured in ~/.codex/config.toml.
// The previous code injected sandbox:"read-only" unconditionally and that
// hard-coded value silently overrode user config (bwrap failures on Linux,
// .git/ EPERM on macOS, git push DNS errors when --write was active, etc.).
//
// Legacy v1.0.x behavior can be restored by setting:
//   CODEX_PLUGIN_SANDBOX_DEFAULT=read-only     (review / non-write paths)
// callers that need a hard-coded sandbox can still pass options.sandbox.
function pickSandboxDefault(env = process.env) {
  const explicit = env.CODEX_PLUGIN_SANDBOX_DEFAULT;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return null;
}

function resolveSandboxValue(options) {
  if (options.sandbox != null && String(options.sandbox).length > 0) {
    return options.sandbox;
  }
  return pickSandboxDefault(options.env ?? process.env);
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  const params = {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
  const sandbox = resolveSandboxValue(options);
  if (sandbox != null) {
    params.sandbox = sandbox;
  }
  return params;
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  const params = {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never"
  };
  const sandbox = resolveSandboxValue(options);
  if (sandbox != null) {
    params.sandbox = sandbox;
  }
  return params;
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}, state = null) {
  if (state) {
    armFinalizingPhaseTimerIfNeeded(state, phase);
  }
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  // Note: log-event paths that carry phase="finalizing" should still arm the
  // finalizing gate via the parallel emitProgress call sites (see callers that
  // pass state). Keep this helper purely log-shaped to avoid coupling.
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/**
 * Per-turn inactivity watchdog (manual port of upstream PR #312).
 *
 * fork v2.1.0 already bounds the `finalizing` phase (PR-1.3 #183, 5 min
 * default), but the full turn lifecycle had no general silence guard —
 * a broker that stops emitting JSON-RPC notifications mid-turn (stuck
 * `app-server`, dropped TCP keepalive, hung MCP tool call) would leave
 * `captureTurn` hanging forever. This watchdog arms when the turn begins
 * and is kicked forward by every notification; if `watchdogMs` of silence
 * passes the turn fails fast with exit 124 (matching `timeout(1)`).
 *
 * Triggers: opt-in via `runAppServerTurn({ watchdogMs })` or env
 * `CODEX_TURN_WATCHDOG_MS`. Closes upstream issue #49 (background task
 * hangs indefinitely — no timeout on Codex API response generation) and
 * partial-fixes #250 (MCP elicitation hang) by giving the watch loop a
 * deterministic upper bound. See docs/upstream-tracking/2026-05-18-...
 * Tier 1 Group B for the audit trail.
 */
export class TurnWatchdogError extends Error {
  /**
   * @param {string} message
   * @param {{ watchdogMs?: number | null, threadId?: string | null, turnId?: string | null }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    const { watchdogMs, threadId, turnId } = options;
    this.name = "TurnWatchdogError";
    this.code = "TURN_WATCHDOG_TIMEOUT";
    this.exitCode = 124;
    this.watchdogMs = watchdogMs ?? null;
    this.threadId = threadId ?? null;
    this.turnId = turnId ?? null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    finalizingPhaseTimer: null,
    finalizingStartedAt: null,
    finalizingTimeoutMs: options.finalizingTimeoutMs ?? FINALIZING_PHASE_TIMEOUT_MS,
    watchdogTimer: null,
    watchdogMs:
      typeof options.watchdogMs === "number" && options.watchdogMs > 0
        ? options.watchdogMs
        : null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

function clearFinalizingPhaseTimer(state) {
  if (state.finalizingPhaseTimer) {
    clearTimeout(state.finalizingPhaseTimer);
    state.finalizingPhaseTimer = null;
  }
}

function armFinalizingPhaseTimerIfNeeded(state, phase) {
  if (phase !== "finalizing" || state.completed || state.finalizingPhaseTimer) {
    return;
  }
  // Disable when caller sets a non-positive timeout. Useful for tests that
  // intentionally exercise long-running finalizing flows without firing the gate.
  if (!Number.isFinite(state.finalizingTimeoutMs) || state.finalizingTimeoutMs <= 0) {
    return;
  }
  state.finalizingStartedAt = Date.now();
  state.finalizingPhaseTimer = setTimeout(() => {
    state.finalizingPhaseTimer = null;
    if (state.completed) {
      return;
    }
    const seconds = Math.round(state.finalizingTimeoutMs / 1000);
    failTurn(
      state,
      new Error(
        `Codex turn stuck in phase=finalizing for ${seconds}s without producing a final turn. ` +
          `Aborting to release the running state.`
      )
    );
  }, state.finalizingTimeoutMs);
  state.finalizingPhaseTimer.unref?.();
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

// Watchdog helpers (manual port of upstream PR #312). `armWatchdog` is
// only effective when `state.watchdogMs > 0`; otherwise all three helpers
// are no-ops, preserving fork v2.1.0 behavior when the opt-in env var
// `CODEX_TURN_WATCHDOG_MS` or the `watchdogMs` option is not set.
function disarmWatchdog(state) {
  if (state.watchdogTimer) {
    clearTimeout(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

function armWatchdog(state) {
  if (!state.watchdogMs || state.completed) {
    return;
  }
  disarmWatchdog(state);
  state.watchdogTimer = setTimeout(() => {
    state.watchdogTimer = null;
    if (state.completed) {
      return;
    }
    state.completed = true;
    clearCompletionTimer(state);
    clearFinalizingPhaseTimer(state);
    const message =
      `Codex turn watchdog fired after ${state.watchdogMs}ms of silence ` +
      `(thread ${state.threadId}, turn ${state.turnId ?? "pending"}). ` +
      `No JSON-RPC notification arrived in that window.`;
    state.rejectCompletion(
      new TurnWatchdogError(message, {
        watchdogMs: state.watchdogMs,
        threadId: state.threadId,
        turnId: state.turnId
      })
    );
  }, state.watchdogMs);
  state.watchdogTimer.unref?.();
}

function kickWatchdog(state) {
  if (!state.watchdogMs || state.completed) {
    return;
  }
  armWatchdog(state);
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  clearFinalizingPhaseTimer(state);
  disarmWatchdog(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    // completeTurn was just called so finalizingPhaseTimer is already cleared;
    // it is safe to call emitProgress without state-side arming here.
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function failTurn(state, error) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  clearFinalizingPhaseTimer(state);
  state.completed = true;
  state.rejectCompletion?.(error);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        if (item.phase === "final_answer") {
          armFinalizingPhaseTimerIfNeeded(state, "finalizing");
        }
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      armFinalizingPhaseTimerIfNeeded(state, "finalizing");
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, {}, state);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, {}, state);
      }
      break;
    case "error": {
      const codexErr = message.params.error;
      state.error = codexErr;
      emitProgress(state.onProgress, `Codex error: ${codexErr.message}`, "failed");
      // Without settling, captureTurn()'s `await state.completion` hangs forever when the
      // app-server emits a terminal error without a subsequent `turn/completed`.
      const wrapped = Object.assign(
        new Error(`Codex app-server error: ${codexErr.message ?? "unknown"}`),
        { cause: codexErr, code: codexErr.code ?? null }
      );
      failTurn(state, wrapped);
      break;
    }
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

// Overlapping captureTurn() calls on the same client must restore the
// notification handler correctly even when they finish out of LIFO order.
// A single save/restore slot clobbers a still-active sibling capture when an
// earlier one finishes first. Track handlers as a per-client stack instead:
// the active handler is always the stack top, and a finished capture removes
// itself by identity rather than blindly reinstating its captured predecessor.
const notificationHandlerStacks = new WeakMap();

function pushNotificationHandler(client, handler) {
  let stack = notificationHandlerStacks.get(client);
  if (!stack) {
    // Seed index 0 with the handler already installed so the final pop
    // restores the original base handler rather than null.
    stack = [client.notificationHandler ?? null];
    notificationHandlerStacks.set(client, stack);
  }
  stack.push(handler);
  client.setNotificationHandler(handler);
}

function popNotificationHandler(client, handler) {
  const stack = notificationHandlerStacks.get(client);
  if (!stack) {
    client.setNotificationHandler(null);
    return;
  }
  const index = stack.lastIndexOf(handler);
  // index 0 is the seeded base handler — never splice it out.
  if (index > 0) {
    stack.splice(index, 1);
  }
  client.setNotificationHandler(stack[stack.length - 1] ?? null);
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  const turnNotificationHandler = (message) => {
    // Manual port of upstream PR #312 — every JSON-RPC notification kicks
    // the inactivity watchdog forward. Opt-in (no-op when watchdogMs unset).
    kickWatchdog(state);

    if (!state.turnId) {
      // Bound the buffered-notification queue. If startRequest never returns a turn id
      // (e.g., a stuck app-server), the buffer would otherwise grow without limit.
      if (state.bufferedNotifications.length >= MAX_BUFFERED_NOTIFICATIONS) {
        state.bufferedNotifications.shift();
      }
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }

    applyTurnNotification(state, message);
  };
  pushNotificationHandler(client, turnNotificationHandler);

  try {
    armWatchdog(state);
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    disarmWatchdog(state);
    popNotificationHandler(client, turnNotificationHandler);
  }
}

async function withAppServer(cwd, fn, options = {}) {
  // PR-5.5 (#251) — when the caller selected a Codex profile, the only
  // codex-cli invocation path that picks it up is the direct-spawn one
  // (BrokerCodexAppServerClient talks to a pre-existing app-server whose
  // profile was fixed at broker spawn). Force a direct spawn so the user's
  // --profile takes effect for this single command. Multi-command broker
  // sharing for the same profile remains unchanged.
  const wantsProfile = typeof options.profile === "string" && options.profile.trim().length > 0;
  const wantsFast = Boolean(options.fast);
  // PR-7.6 (#210) — fast tier is a per-invocation knob, so force a direct
  // codex spawn (broker bypass) when requested. Sharing a broker between
  // a fast and non-fast caller would silently apply the first tier choice
  // to both.
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      serverRequestHandler: options.serverRequestHandler,
      profile: options.profile,
      fast: options.fast,
      disableBroker: wantsProfile || wantsFast || options.disableBroker === true
    });
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (options.retryDirectOnBusy !== false && client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      // Teardown best-effort: a failed close has no recovery path and must
      // not mask the primary turn error/result being propagated.
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      profile: options.profile,
      fast: options.fast,
      serverRequestHandler: options.serverRequestHandler
    });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    // Broker busy is transient — actual auth state unknown, NOT a logged-out signal.
    // Without this branch, setup --json reports `loggedIn: false` for any concurrent
    // broker request (e.g., another plugin call in flight, broker init handshake in
    // progress, 28MB+ SQLite WAL flush blocking new requests). That produces a
    // false-negative mirror of the false-positive pattern documented in
    // plan-issue-setup-advisory-false-positive.md — caller cannot distinguish
    // "user actually logged out" vs "transient broker contention".
    if (error?.rpcCode === BROKER_BUSY_RPC_CODE) {
      return buildAuthStatus({
        loggedIn: null,
        detail: "Broker busy — actual auth state unknown. Retry setup --json after broker init completes (typically 5-30s; longer if plugin home SQLite WAL is large).",
        source: "app-server",
        transient: true,
      });
    }
    // Broker stuck (account/read timed out) — broker process 가 init handshake 또는 SQLite WAL flush
    // 에 막혀 응답 못함. transient 와 분리: 사용자 가 broker kill + plugin home WAL cleanup 필요.
    // 본 case 도 actual logged-out 시그널 아님 — false-negative 회피.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (/timed out|timeout|ECONNRESET|EPIPE/i.test(errorMessage)) {
      return buildAuthStatus({
        loggedIn: null,
        detail: `Broker stuck (${errorMessage}) — actual auth state unknown. Recovery: kill plugin broker processes (Windows PowerShell: \`Get-Process | Where-Object { $_.ProcessName -ceq 'codex' } | Stop-Process -Force\` — case-sensitive lowercase only, excludes Codex Desktop GUI; macOS/Linux: \`pkill -f 'codex.*app-server'\`) + check plugin home SQLite WAL (~/.codex/claude-code/*.sqlite-wal — delete if >10MB). See plan-issue-setup-advisory-false-positive.md.`,
        source: "app-server",
        transient: true,
      });
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: errorMessage,
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? loadBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

// PR-5.4 (#233) — when the user points Codex at a non-OpenAI endpoint via
// `openai_base_url` in ~/.codex/config.toml, the auth gate fails because
// `codex login status` requires the official OpenAI auth flow. The codex
// subprocess itself runs fine against the custom endpoint (proxy / self-host)
// so the gate is just a false negative.
//
// We bypass when either:
//   - env CODEX_PLUGIN_SKIP_AUTH=1 (explicit user override; honors both
//     "1" and "true" / "yes" for ergonomics)
//   - ~/.codex/config.toml is parseable and contains a non-empty
//     `openai_base_url` key at the top level (heuristic; if the file uses
//     profiles only, the user must set the env var)
function shouldBypassCodexAuthCheck(env = process.env) {
  const flag = String(env.CODEX_PLUGIN_SKIP_AUTH ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") {
    return { bypass: true, reason: "env CODEX_PLUGIN_SKIP_AUTH" };
  }
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {
    return { bypass: false, reason: null };
  }
  try {
    const configPath = `${home}/.codex/config.toml`;
    const raw = readFileSyncSafe(configPath);
    if (raw && /^\s*openai_base_url\s*=\s*["'][^"']+["']/m.test(raw)) {
      return { bypass: true, reason: "openai_base_url detected in ~/.codex/config.toml" };
    }
  } catch {
    // Best-effort. If we cannot read the config, fall through to the
    // normal auth check.
  }
  return { bypass: false, reason: null };
}

function readFileSyncSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  const bypass = shouldBypassCodexAuthCheck(options.env ?? process.env);
  if (bypass.bypass) {
    return {
      available: true,
      loggedIn: true,
      detail: `Auth check bypassed (${bypass.reason}). Codex must be configured correctly for the custom endpoint.`,
      source: "bypass",
      authMethod: "custom",
      verified: false,
      requiresOpenaiAuth: false,
      provider: "custom"
    };
  }

  let client = null;
  try {
    // #41 — a reused broker can hold an invalidated token after the user ran
    // `codex logout && codex login`. getCodexAuthStatusFromClient swallows the
    // resulting error into a loggedIn:false status object, so the orchestrator
    // detects the stale-auth signature on `status.detail` (not only thrown
    // exceptions) and restarts the broker ONCE before re-probing.
    const reuseBrokerEndpoint = Boolean(options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]);
    const { status } = await probeAuthWithStaleRetry({
      connect: () => CodexAppServerClient.connect(cwd, { env: options.env, reuseExistingBroker: true }),
      probe: (probeClient) => getCodexAuthStatusFromClient(probeClient, cwd),
      restartBroker: () => restartStaleBrokerSession(cwd),
      reuseBrokerEndpoint
    });
    return status;
  } catch (error) {
    const hasExplicitBrokerEndpoint = Boolean(options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]);
    if (!hasExplicitBrokerEndpoint && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED")) {
      try {
        client = await CodexAppServerClient.connect(cwd, {
          env: options.env,
          disableBroker: true
        });
        return await getCodexAuthStatusFromClient(client, cwd);
      } catch (directError) {
        return buildAuthStatus({
          loggedIn: false,
          detail: directError instanceof Error ? directError.message : String(directError),
          source: "app-server"
        });
      }
    }
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      // Teardown best-effort: a failed close has no recovery path and must
      // not mask the primary turn error/result being propagated.
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    // Teardown best-effort: a failed close has no recovery path and must
    // not mask the primary error/result being propagated.
    await client?.close().catch(() => {});
  }
}

// PR-5.8 (#270) — when the user's top-level Codex config defaults to a newer
// model (e.g. gpt-5.5) that the structured-review path cannot use yet, the
// app-server returns 400 invalid_request_error with the literal message
// "The 'gpt-5.5' model requires a newer version of Codex". We detect that
// signature once per review and retry with the documented stable fallback
// (`gpt-5.4`) plus a warning so the user sees what happened.
const REVIEW_MODEL_FALLBACK = "gpt-5.4";

// PR-5.2 (#281) — `codex app-server` keeps its access token in memory after
// startup and does not re-read ~/.codex/auth.json when the user runs
// `codex logout && codex login`. Subsequent companion-mediated calls fail
// with "Your access token could not be refreshed because you have since
// logged out or signed in to another account. Please sign in again." even
// though `codex exec` from the same shell works fine. We detect that
// signature and surface a structured hint so the user knows to restart the
// broker instead of seeing a generic Codex error.
function isStaleAuthCacheError(error) {
  if (!error) {
    return false;
  }
  const text = typeof error === "string" ? error : error.message ?? "";
  return /access token could not be refreshed|Please sign in again/i.test(String(text));
}

function annotateStaleAuthCacheError(error) {
  if (!error || !isStaleAuthCacheError(error)) {
    return error;
  }
  const original = typeof error === "string" ? error : error.message ?? "";
  const guidance =
    "\n\nThe Codex app-server has cached an invalidated session. Run /opnd-codex:cancel to drain " +
    "any in-flight jobs, then restart Claude Code (or run `pkill -f \"codex app-server\"`) so " +
    "the next invocation re-reads ~/.codex/auth.json. If the problem persists after a fresh " +
    "login, file an upstream codex-cli bug.";
  if (typeof error === "string") {
    return original + guidance;
  }
  return Object.assign(new Error(original + guidance), { cause: error, code: error.code ?? null });
}

// #41 — a reused broker app-server caches its OpenAI token at startup and does
// NOT re-read ~/.codex/auth.json after `codex logout && codex login`. The auth
// probe then comes back with the stale-auth signature even though the user just
// logged in fresh. Tear the stale broker down — under the broker lock so this
// is safe against concurrent /opnd-codex:* callers (#286) — and clear
// broker.json; the next connect respawns a fresh app-server that re-reads
// auth.json. Caller bounds this to one restart per probe.
async function restartStaleBrokerSession(cwd) {
  await withBrokerLockAsync(cwd, async () => {
    const session = loadBrokerSession(cwd);
    if (session) {
      teardownBrokerSession({
        endpoint: session.endpoint ?? null,
        pidFile: session.pidFile ?? null,
        logFile: session.logFile ?? null,
        sessionDir: session.sessionDir ?? null,
        pid: session.pid ?? null
      });
    }
    clearBrokerSession(cwd);
  });
}

// #41 — orchestrates the auth probe + one-shot stale-broker restart. Extracted
// with injected deps (`connect` / `probe` / `restartBroker`) so the behavioral
// test can drive the retry path without a real broker or app-server. Returns
// `{ status, restarted }`. The restart is bounded to exactly one attempt — a
// second stale-auth result after the restart is returned as-is (no loop).
async function probeAuthWithStaleRetry({ connect, probe, restartBroker, reuseBrokerEndpoint }) {
  let client = await connect();
  let restarted = false;
  try {
    let status = await probe(client);
    if (!reuseBrokerEndpoint && !status?.loggedIn && isStaleAuthCacheError(status?.detail)) {
      restarted = true;
      await client.close().catch(() => {});
      client = null;
      await restartBroker();
      client = await connect();
      status = await probe(client);
    }
    return { status, restarted };
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

function isModelRequiresNewerCodexError(error) {
  if (!error) {
    return false;
  }
  const text = typeof error === "string" ? error : error.message ?? "";
  // Match the upstream phrasing; keep the regex loose enough that minor
  // wording changes (e.g. CLI vs app suggestion variants) still trip it.
  return /requires a newer version of Codex/i.test(String(text));
}

// #309 — shared model-version fallback for BOTH the review and the task/turn
// paths (was review-only; gpt-5.5 on CLI 0.130 also 400s task/agent runs).
// `runWithModel(modelOverride)` MUST: (a) return a result object with an
// `.error` field rather than throwing for the model-version case, and (b) be
// safe to call twice — re-issuing thread + turn/start from scratch.
//
// Retrying the whole function is safe ONLY because the "requires a newer
// version of Codex" failure is a request-time 400 (invalid_request) rejection
// of the thread/start or turn/start call: the server never created a turn, so
// the retry IS the first and only real turn. Do NOT broaden
// `isModelRequiresNewerCodexError` to mid-turn errors without removing this
// whole-function retry — that would create a duplicate server-side turn.
async function withModelFallback(runWithModel, { explicitModel, onProgress, label }) {
  const firstAttempt = await runWithModel(undefined);
  // Only auto-fallback when the user did NOT explicitly select a model, so an
  // intentional choice is never silently overridden.
  if (!explicitModel && isModelRequiresNewerCodexError(firstAttempt?.error)) {
    emitProgress(
      onProgress,
      `${label} failed: default model unavailable. Retrying with model="${REVIEW_MODEL_FALLBACK}".`,
      "warn"
    );
    return await runWithModel(REVIEW_MODEL_FALLBACK);
  }
  return firstAttempt;
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }

  async function executeReviewWithModel(modelOverride) {
    return withAppServer(cwd, async (client) => {
      emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
      const thread = await startThread(client, cwd, {
        model: modelOverride ?? options.model,
        sandbox: options.sandbox,
        ephemeral: true,
        threadName: options.threadName
      });
      const sourceThreadId = thread.thread.id;
      emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
        threadId: sourceThreadId
      });
      const delivery = options.delivery ?? "inline";

      const turnState = await captureTurn(
        client,
        sourceThreadId,
        () =>
          client.request("review/start", {
            threadId: sourceThreadId,
            delivery,
            target: options.target
          }),
        {
          onProgress: options.onProgress,
          onResponse(response, state) {
            if (response.reviewThreadId) {
              state.threadIds.add(response.reviewThreadId);
              if (delivery === "detached") {
                state.threadId = response.reviewThreadId;
              }
            }
          }
        }
      );

      return {
        status: buildResultStatus(turnState),
        threadId: turnState.threadId,
        sourceThreadId,
        turnId: turnState.turnId,
        reviewText: turnState.reviewText,
        reasoningSummary: turnState.reasoningSummary,
        turn: turnState.finalTurn,
        // PR-5.2 (#281) — annotate the stale-auth-cache error with a
        // structured hint so the user knows to restart the broker rather
        // than seeing a bare Codex error.
        error: annotateStaleAuthCacheError(turnState.error),
        stderr: cleanCodexStderr(client.stderr)
      };
    }, { profile: options.profile, fast: options.fast });
  }

  const explicitModel = options.model != null && String(options.model).length > 0;
  return withModelFallback(executeReviewWithModel, {
    explicitModel,
    onProgress: options.onProgress,
    label: "Codex review"
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }

  return withAppServer(
    cwd,
    async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    // #309 — retry ONLY turn/start, on the SAME already-created thread, with
    // the stable fallback model when the default model 400s. The thread is
    // created exactly once above, so — unlike a whole-function retry — no
    // orphan thread is left behind (Codex audit BUG fix). The model-version
    // 400 is a turn/start-time rejection (thread/start already succeeded);
    // re-issuing turn/start on the same thread is the first and only real turn.
    const runTurn = (modelOverride) =>
      captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: buildTurnInput(prompt),
            model: (modelOverride ?? options.model) ?? null,
            effort: options.effort ?? null,
            approvalPolicy: options.approvalPolicy ?? null,
            outputSchema: options.outputSchema ?? null
          }),
        {
          onProgress: options.onProgress,
          // PR-G-B (manual port of upstream PR #312) + A2 fix — per-turn
          // inactivity watchdog. An explicit `options.watchdogMs` from the
          // direct caller (companion / task path) wins; otherwise it resolves
          // to `CODEX_TURN_WATCHDOG_MS` env, then the default-on 10 min bound
          // (`resolveDefaultTurnWatchdogMs`). `CODEX_TURN_WATCHDOG_MS=0`
          // disables; an explicit `null` option also disables.
          watchdogMs:
            typeof options.watchdogMs === "number"
              ? options.watchdogMs
              : resolveDefaultTurnWatchdogMs()
        }
      );

    let turnState = await runTurn(undefined);
    const explicitModel = options.model != null && String(options.model).length > 0;
    if (!explicitModel && isModelRequiresNewerCodexError(turnState.error)) {
      emitProgress(
        options.onProgress,
        `Codex task failed: default model unavailable. Retrying with model="${REVIEW_MODEL_FALLBACK}".`,
        "warn"
      );
      turnState = await runTurn(REVIEW_MODEL_FALLBACK);
    }

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      // PR-5.2 (#281) — annotate the stale-auth-cache error path so the
      // user sees a clear restart hint, not a bare Codex error.
      error: annotateStaleAuthCacheError(turnState.error),
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  }, { serverRequestHandler: options.serverRequestHandler, profile: options.profile, fast: options.fast });
}

export async function steerAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }
  if (!options.threadId || !options.turnId) {
    throw new Error("A thread id and active turn id are required to steer Codex.");
  }
  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("A prompt is required to continue the active Codex turn.");
  }

  return withAppServer(
    cwd,
    async (client) => {
      const response = await client.request("turn/steer", {
        threadId: options.threadId,
        expectedTurnId: options.turnId,
        input: buildTurnInput(prompt)
      });
      return {
        status: 0,
        threadId: options.threadId,
        turnId: response.turnId ?? options.turnId,
        stderr: cleanCodexStderr(client.stderr)
      };
    },
    { serverRequestHandler: options.serverRequestHandler, retryDirectOnBusy: false }
  );
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/opnd-codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };

// PR-1.3 (#183) — exposed for the finalizing-timeout contract test. Internal
// only; callers outside the test suite should treat these as private.
// CDX-004 — also expose `resolveSandboxValue` + `buildThreadParams` so the
// sandbox-default-omit contract test can verify the runtime omit/inherit
// behavior directly, not just the source pattern of executeReviewWithModel.
export const __testHooks = {
  createTurnCaptureState,
  armFinalizingPhaseTimerIfNeeded,
  clearFinalizingPhaseTimer,
  completeTurn,
  failTurn,
  FINALIZING_PHASE_TIMEOUT_MS,
  resolveSandboxValue,
  buildThreadParams,
  // #41 — exposed so the behavioral test can drive the stale-broker restart
  // retry without a real broker/app-server.
  probeAuthWithStaleRetry,
  isStaleAuthCacheError,
  withModelFallback,
  isModelRequiresNewerCodexError,
  // Codex R1 M2 (본 세션 발견 false-negative pattern) — broker busy / timeout 분기 직접 test 가능하도록 export
  getCodexAuthStatusFromClient,
  BROKER_BUSY_RPC_CODE
};
