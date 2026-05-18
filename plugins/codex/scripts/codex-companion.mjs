#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn,
    steerAppServerTurn
  } from "./lib/codex.mjs";
import {
  buildApprovalResponse,
  createPendingApprovalRecord,
  isApprovalRequestMethod,
  normalizeApprovalPolicy,
  pendingApprovalCount
} from "./lib/approvals.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  updateJobFile,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { getUserDefault } from "./lib/user-config.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";
import { createTraceId, emitEvent } from "./lib/telemetry.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs agent [--wait|--background] [--sandbox <read-only|workspace-write|danger-full-access>] [--approval <never|on-request|on-failure|untrusted>] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--sandbox <read-only|workspace-write|danger-full-access>] [--approval <never|on-request|on-failure|untrusted>] [--resume-last|--resume|--resume-id <thread-id>|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [--profile <name>] [--max-findings <N>] [--full-access | --dangerously-skip-permissions] [--prompt-stdin] [prompt]",
      "  node scripts/codex-companion.mjs continue [--job <job-id>] [--background] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs approve <approval-id> [--session] [--response-json <json>] [--json]",
      "  node scripts/codex-companion.mjs deny <approval-id> [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--dry-run] [--json]"
    ].join("\n")
  );
}

// PR-2.1 / PR-8.6 — emit a one-shot first-run warning when the v2.0.0
// BREAKING defaults could change behavior for an upgrading user. We mark
// "seen" in the workspace state file so the warning appears once per
// workspace, not on every invocation. Users who set
// CODEX_PLUGIN_SANDBOX_DEFAULT=read-only never see the warning because the
// legacy behavior is restored.
let firstRunWarningEmitted = false;
function maybeEmitV2FirstRunWarning() {
  if (firstRunWarningEmitted) {
    return;
  }
  firstRunWarningEmitted = true;
  if (String(process.env.CODEX_PLUGIN_SANDBOX_DEFAULT ?? "").trim()) {
    return; // user opted out of v2.0.0 default change
  }
  if (process.env.CODEX_PLUGIN_SUPPRESS_V2_NOTICE === "1") {
    return;
  }
  process.stderr.write(
    "[codex-plugin-cc v2.0.0] BREAKING changes from v1.x:\n" +
      "  1. Sandbox default is now inherited from ~/.codex/config.toml\n" +
      "     - Before: review/task hard-coded sandbox=\"read-only\" / \"workspace-write\"\n" +
      "     - Now:    omitted unless --sandbox is passed; user codex config takes effect\n" +
      "     Restore legacy: CODEX_PLUGIN_SANDBOX_DEFAULT=read-only (or workspace-write)\n" +
      "  2. Plugin codex sessions land in $HOME/.codex/claude-code/ instead of\n" +
      "     ~/.codex/ so they no longer pollute the Codex Desktop history feed.\n" +
      "     Restore legacy shared home: CODEX_PLUGIN_USE_DEFAULT_HOME=1\n" +
      "  Suppress this notice: CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1\n"
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

function normalizeSandboxMode(sandbox) {
  if (sandbox == null) {
    return null;
  }
  const normalized = String(sandbox).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_SANDBOX_MODES.has(normalized)) {
    throw new Error(
      `Unsupported sandbox mode "${sandbox}". Use one of: read-only, workspace-write, danger-full-access.`
    );
  }
  return normalized;
}

// PR-7.7 (#213) — resolvers that prefer the CLI value, then the user-level
// config default, then null. The CLI must always win — the merge happens
// here (not inside the normalize helpers) so the normalize functions stay
// pure single-input validators.
//
// Each resolver runs the same normalize that the explicit-CLI path uses, so
// an invalid user-config value (e.g. `defaultEffort: "ultra"`) raises the
// same human-readable error a bad `--effort ultra` would — the user sees a
// pointer to the config file via the surrounding context.
// PR-7.7 audit finding #5 — an explicit CLI flag (even with an empty value
// like `--model ""`) is still a user choice. Treat it as "explicitly clear
// the default" rather than letting the user-config silently fill it in,
// which would violate the "CLI always wins" contract. `null`/`undefined`
// means "the flag was never passed" and is the only case where the
// user-config fallback fires.
function cliExplicitlyPassed(cliValue) {
  return cliValue !== null && cliValue !== undefined;
}

function resolveModel(cliValue, { env = process.env } = {}) {
  if (cliExplicitlyPassed(cliValue)) {
    return normalizeRequestedModel(cliValue);
  }
  const configDefault = getUserDefault("defaultModel", { env });
  if (configDefault === undefined) return null;
  return normalizeRequestedModel(configDefault);
}

function resolveEffort(cliValue, { env = process.env } = {}) {
  if (cliExplicitlyPassed(cliValue)) {
    return normalizeReasoningEffort(cliValue);
  }
  const configDefault = getUserDefault("defaultEffort", { env });
  if (configDefault === undefined) return null;
  try {
    return normalizeReasoningEffort(configDefault);
  } catch (error) {
    throw new Error(
      `Invalid defaultEffort in user config: ${error?.message ?? error}. Edit your codex-plugin-cc config or unset the key.`
    );
  }
}

function resolveSandbox(cliValue, { env = process.env } = {}) {
  if (cliExplicitlyPassed(cliValue)) {
    return normalizeSandboxMode(cliValue);
  }
  const configDefault = getUserDefault("defaultSandbox", { env });
  if (configDefault === undefined) return null;
  try {
    return normalizeSandboxMode(configDefault);
  } catch (error) {
    throw new Error(
      `Invalid defaultSandbox in user config: ${error?.message ?? error}. Edit your codex-plugin-cc config or unset the key.`
    );
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...config.aliasMap
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function normalizeApprovals(value) {
  return Array.isArray(value) ? value : [];
}

function readStoredJobRequired(workspaceRoot, jobId) {
  const storedJob = readStoredJob(workspaceRoot, jobId);
  if (!storedJob) {
    throw new Error(`No stored job found for ${jobId}.`);
  }
  return storedJob;
}

function summarizePendingApprovals(approvals) {
  return normalizeApprovals(approvals).map((approval) => ({
    id: approval.id,
    method: approval.method,
    status: approval.status,
    summary: approval.summary,
    risk: approval.risk,
    createdAt: approval.createdAt,
    decidedAt: approval.decision?.decidedAt ?? null
  }));
}

function writeStoredJobWithApprovals(workspaceRoot, jobId, storedJob) {
  const approvals = normalizeApprovals(storedJob.pendingApprovals);
  const count = pendingApprovalCount(approvals);
  const activePhase =
    storedJob.status === "queued" || storedJob.status === "running" ? (count > 0 ? "waiting-approval" : "running") : null;
  updateJobFile(workspaceRoot, jobId, (existing) => ({
    ...(existing ?? storedJob),
    pendingApprovals: approvals,
    ...(activePhase ? { phase: activePhase } : {})
  }));
  upsertJob(workspaceRoot, {
    id: jobId,
    pendingApprovals: summarizePendingApprovals(approvals),
    pendingApprovalCount: count,
    ...(activePhase ? { phase: activePhase } : {})
  });
}

function appendPendingApproval(workspaceRoot, jobId, approval) {
  const storedJob = readStoredJobRequired(workspaceRoot, jobId);
  const approvals = normalizeApprovals(storedJob.pendingApprovals);
  const nextApprovals = [...approvals.filter((candidate) => candidate.id !== approval.id), approval];
  writeStoredJobWithApprovals(workspaceRoot, jobId, {
    ...storedJob,
    pendingApprovals: nextApprovals
  });
}

function isPendingApproval(approval) {
  return approval?.status === "pending";
}

function pendingApprovalsForJob(job) {
  return normalizeApprovals(job?.pendingApprovals).filter(isPendingApproval);
}

function updateApprovalDecision(workspaceRoot, approvalReference, decision, options = {}) {
  if (!approvalReference) {
    throw new Error("Provide an approval id. Run /codex:status to list pending approvals.");
  }
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot, { reap: true }));
  const matches = [];
  for (const job of jobs) {
    if (options.sessionId && job.sessionId !== options.sessionId) {
      continue;
    }
    if (job.status !== "queued" && job.status !== "running") {
      continue;
    }
    const storedJob = readStoredJob(workspaceRoot, job.id) ?? job;
    for (const approval of pendingApprovalsForJob(storedJob)) {
      if (approval.id !== approvalReference && !approval.id.startsWith(approvalReference)) {
        continue;
      }
      matches.push({ job, storedJob, approval });
    }
  }

  if (matches.length === 0) {
    throw new Error(approvalReference ? `No pending approval found for "${approvalReference}".` : "No pending Codex approvals found.");
  }
  if (matches.length > 1) {
    throw new Error(`Approval reference "${approvalReference ?? ""}" is ambiguous. Use a longer approval id.`);
  }

  const { job, storedJob, approval } = matches[0];
  const { responseJson, ...decisionMetadata } = decision;
  const decidedApproval = {
    ...approval,
    status: decision.action === "deny" ? "denied" : "approved",
    decision: {
      ...decisionMetadata,
      decidedAt: nowIso()
    },
    responseJson: responseJson ?? null,
    updatedAt: nowIso()
  };
  const nextApprovals = normalizeApprovals(storedJob.pendingApprovals).map((candidate) =>
    candidate.id === approval.id ? decidedApproval : candidate
  );
  writeStoredJobWithApprovals(workspaceRoot, job.id, {
    ...storedJob,
    pendingApprovals: nextApprovals
  });
  appendLogLine(storedJob.logFile, `Approval ${decidedApproval.status}: ${decidedApproval.id}.`);

  return { jobId: job.id, approval: decidedApproval };
}

async function waitForApprovalDecision(workspaceRoot, jobId, approvalId) {
  while (true) {
    const storedJob = readStoredJobRequired(workspaceRoot, jobId);
    if (storedJob.status !== "queued" && storedJob.status !== "running") {
      throw new Error(`Pending approval ${approvalId} cannot continue because job ${jobId} is ${storedJob.status}.`);
    }
    const approval = normalizeApprovals(storedJob.pendingApprovals).find((candidate) => candidate.id === approvalId);
    if (!approval) {
      throw new Error(`Pending approval ${approvalId} disappeared.`);
    }
    if (approval.status !== "pending") {
      const response = buildApprovalResponse(approval);
      const nextApprovals = normalizeApprovals(storedJob.pendingApprovals).map((candidate) =>
        candidate.id === approval.id ? { ...candidate, responseJson: null, updatedAt: nowIso() } : candidate
      );
      writeStoredJobWithApprovals(workspaceRoot, jobId, {
        ...storedJob,
        pendingApprovals: nextApprovals
      });
      return response;
    }
    await sleep(1000);
  }
}

function createJobServerRequestHandler({ workspaceRoot, jobId, onProgress }) {
  return async (message) => {
    if (!isApprovalRequestMethod(message.method)) {
      const error = new Error(`Unsupported server request: ${message.method}`);
      error.rpcCode = -32601;
      throw error;
    }

    const approval = createPendingApprovalRecord(message);
    appendPendingApproval(workspaceRoot, jobId, approval);

    const progressMessage = approval.hardDeny
      ? `Approval hard-denied: ${approval.summary}`
      : `Approval required: ${approval.id} - ${approval.summary}`;
    onProgress?.({
      message: progressMessage,
      phase: approval.hardDeny ? "running" : "waiting-approval",
      logTitle: approval.hardDeny ? "Approval hard-denied" : "Approval required",
      logBody: [
        `ID: ${approval.id}`,
        `Method: ${approval.method}`,
        `Risk: ${approval.risk}`,
        approval.reason ? `Reason: ${approval.reason}` : null,
        approval.hardDenyReason ? `Hard deny: ${approval.hardDenyReason}` : null,
        `Summary: ${approval.summary}`
      ]
        .filter(Boolean)
        .join("\n")
    });

    if (approval.hardDeny) {
      return buildApprovalResponse(approval);
    }

    return waitForApprovalDecision(workspaceRoot, jobId, approval.id);
  };
}

function renderApprovalDecisionResult(payload) {
  const lines = [
    `# Codex ${payload.action === "deny" ? "Deny" : "Approve"}`,
    "",
    `${payload.action === "deny" ? "Denied" : "Approved"} ${payload.approval.id}.`,
    "",
    `- Job: ${payload.jobId}`,
    `- Method: ${payload.approval.method}`,
    `- Summary: ${payload.approval.summary}`
  ];
  return `${lines.join("\n")}\n`;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// PR-6.6 (#298) — /codex:review and /codex:adversarial-review consistently
// returned 2-3 findings per run even when a large refactor surfaced 20+
// material issues. The prompt itself never asked for more, so the model
// optimized for "prefer one strong finding over several weak ones" beyond
// the user's intent. Expose `--max-findings <N>` (default 20) so the prompt
// requests up to N defensible findings while keeping the "no filler" guard.
const DEFAULT_MAX_FINDINGS = 20;

function normalizeMaxFindings(raw) {
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_FINDINGS;
  }
  return Math.min(numeric, 100); // hard cap to keep prompts bounded
}

function buildAdversarialReviewPrompt(context, focusText, options = {}) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    MAX_FINDINGS: String(normalizeMaxFindings(options.maxFindings))
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot, { reap: true })).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      profile: request.profile,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText, {
    maxFindings: request.maxFindings
  });
  // PR-2.1 (#240 / #167) — adversarial-review is a read-only flow, but we no
  // longer hard-code sandbox:"read-only" here. The legacy hard-code prevented
  // user `~/.codex/config.toml` `sandbox_mode = "danger-full-access"` from
  // working on Linux hosts where the codex CLI's bundled sandbox cannot
  // initialize. Callers can still force read-only via `--sandbox read-only`
  // or `CODEX_PLUGIN_SANDBOX_DEFAULT=read-only`.
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    profile: request.profile,
    sandbox: request.sandbox ?? null,
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);
  const sandbox = request.sandbox ?? (request.write ? "workspace-write" : "read-only");
  const approvalPolicy = request.approvalPolicy ?? "never";
  const writeCapable = sandbox !== "read-only";

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = request.threadId ?? null;
  if (!resumeThreadId && request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    profile: request.profile,
    fast: request.fast,
    approvalPolicy,
    sandbox,
    onProgress: request.onProgress,
    serverRequestHandler: request.jobId
      ? createJobServerRequestHandler({
          workspaceRoot,
          jobId: request.jobId,
          onProgress: request.onProgress
        })
      : null,
    persistThread: true,
    // PR-5.7 (#283) — when no user prompt is supplied we used to fall back to
    // DEFAULT_CONTINUE_PROMPT, which made every "continue/resume" session
    // collapse to an identical thread name ("Codex Companion Task: Continue
    // from the current thread state..."). Append the jobId so the user can
    // still tell sessions apart in Codex Desktop. Real user prompts keep the
    // existing short-excerpt behavior, only this fall-back path changes.
    threadName: resumeThreadId
      ? null
      : request.prompt
      ? buildPersistentTaskThreadName(request.prompt)
      : `${buildPersistentTaskThreadName(DEFAULT_CONTINUE_PROMPT)} [${request.jobId ?? "session"}]`
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: writeCapable
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: writeCapable
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, sandbox, approvalPolicy, resumeLast, threadId, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    sandbox,
    approvalPolicy,
    resumeLast,
    threadId,
    jobId
  };
}

// PR-3.2 (#308) — when the parent agent forwards a ~6KB+ prompt as an
// inline argv string, the Claude Code Bash tool silently rejects the call
// with the "user denied tool use" wording — there is no actual user prompt
// shown and the rescue agent has no way to recover. The plugin already
// supports --prompt-file but the codex-rescue prompt template did not use
// it. Two mitigations land in this PR:
//
//   1. A --prompt-stdin flag for callers that prefer piping over a tmpfile.
//      stdin is still drained when no other source is supplied, but
//      --prompt-stdin makes that intent explicit and skips the positional
//      / prompt-file branches even when they happen to be set to empty
//      strings.
//   2. A PROMPT_INLINE_SIZE_WARN_BYTES heuristic that emits a one-shot
//      stderr warning when the user passed > 3KB of inline positionals.
//      The warning tells them to switch to --prompt-file or --prompt-stdin
//      so the next invocation does not trip the upstream rejection.
const PROMPT_INLINE_SIZE_WARN_BYTES = 3 * 1024;
let inlinePromptWarningEmitted = false;

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-stdin"]) {
    return readStdinIfPiped();
  }
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  if (positionalPrompt && positionalPrompt.length > PROMPT_INLINE_SIZE_WARN_BYTES && !inlinePromptWarningEmitted) {
    inlinePromptWarningEmitted = true;
    process.stderr.write(
      `[codex-plugin-cc] inline prompt is ${positionalPrompt.length} bytes (>${PROMPT_INLINE_SIZE_WARN_BYTES}). ` +
        "Consider --prompt-file <path> or --prompt-stdin to avoid the upstream " +
        "argv-size rejection that surfaces as a generic 'user denied' error (#308).\n"
    );
  }
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  // PR-9.2 — generate a correlation id at enqueue time so every downstream
  // event (start / progress / completion) can be stitched back to this run.
  // The id is also surfaced in the job log header for ad-hoc grep, and
  // stashed inside the request payload so the detached worker inherits it
  // without an extra plumbing channel.
  const traceId = createTraceId();
  appendLogLine(logFile, `trace.id=${traceId}`);
  const requestWithTrace = { ...request, traceId };

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    traceId,
    request: requestWithTrace
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  // The state.json index is keyed by-job and read on every status/list call. Strip the
  // large `request` payload (full prompts, focus text) so the index stays bounded; the
  // per-job file above still has the full record for the worker to consume.
  const { request: _request, ...indexRecord } = queuedRecord;
  upsertJob(job.workspaceRoot, indexRecord);

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const spawnedPid = child.pid ?? null;
  updateJobFile(job.workspaceRoot, job.id, (storedJob) => ({
    ...(storedJob ?? queuedRecord),
    pid: spawnedPid
  }));
  upsertJob(job.workspaceRoot, {
    id: job.id,
    pid: spawnedPid
  });

  // PR-9.1 — every queued job emits one `enqueued` event with the
  // identifying metadata. Failure-tolerant: a swallowed write is logged to
  // stderr only when CODEX_PLUGIN_TELEMETRY_DEBUG=1.
  emitEvent("enqueued", {
    traceId,
    jobId: job.id,
    jobClass: job.jobClass ?? job.kind ?? "task",
    phase: "queued",
    cwd,
    model: request?.model,
    effort: request?.effort
  });

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      traceId
    },
    logFile,
    traceId
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd", "profile", "max-findings", "branch"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope,
    // PR-7.5 (#114) — accept --branch <ref> to review a remote branch
    // without local checkout. resolveReviewTarget threads `tipRef` into the
    // git diff range so the review compares <ref> against the default base.
    branch: options.branch
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  // PR-3.4 (#279 / #207) — `--background` was declared in the option set
  // but never read by handleReviewCommand, so /codex:review --background
  // silently ran foreground and the caller (Claude Code) got the raw log
  // stream instead of the queued-job JSON it was waiting for. Wire the
  // background queue the same way handleTask does so review/adversarial
  // -review can run async without the bridge breaking.
  if (options.background) {
    const reviewRequest = {
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      profile: options.profile,
      maxFindings: options["max-findings"],
      focusText,
      reviewName: config.reviewName,
      validateRequestKey: config.validateRequestKey ?? null
    };
    const queued = {
      ...job,
      sandbox: null,
      approvalPolicy: "never",
      request: reviewRequest
    };
    const { payload } = enqueueBackgroundTask(cwd, queued, reviewRequest);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        profile: options.profile,
        maxFindings: options["max-findings"],
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "sandbox", "approval", "profile", "resume-id", "context"],
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
      // PR-2.2 (#124 / #145) — convenience aliases that imply both an
      // approval policy and a sandbox mode. handleTask resolves them
      // after argv parsing so they cannot conflict with explicit values.
      "full-access",
      "dangerously-skip-permissions",
      // PR-3.2 (#308) — explicit stdin marker so callers that pipe a
      // multi-KB prompt can disambiguate from positional args.
      "prompt-stdin",
      // PR-7.6 (#210) — request the Codex fast service tier for this
      // single invocation, equivalent to `-c service_tier=fast` in the
      // upstream codex CLI. Trade ~2x credits for ~1.5x speed.
      "fast"
    ],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // PR-7.7 (#213) — resolveModel/Effort/Sandbox respect the user-level
  // config defaults from ~/.config/codex-plugin-cc/config.json when the
  // CLI option is not supplied. CLI always wins.
  const model = resolveModel(options.model);
  const effort = resolveEffort(options.effort);
  let sandbox = resolveSandbox(options.sandbox);
  let approvalPolicy = normalizeApprovalPolicy(options.approval) ?? "never";
  // PR-2.2 (#124 / #145) — `--full-access` and `--dangerously-skip-permissions`
  // (Claude Code naming convention) are convenience aliases that set both
  // `--sandbox danger-full-access` and `--approval never`. When the user
  // supplied an explicit sandbox / approval, the explicit choice wins so
  // the flag never silently overrides a deliberate decision.
  const fullAccessAlias = Boolean(options["full-access"] || options["dangerously-skip-permissions"]);
  if (fullAccessAlias) {
    if (sandbox == null) {
      sandbox = "danger-full-access";
    }
    if (!options.approval) {
      approvalPolicy = "never";
    }
    process.stderr.write(
      "[codex-plugin-cc] WARNING: running without sandbox or approvals. " +
        "Only use --full-access / --dangerously-skip-permissions when the " +
        "surrounding machine is already isolated.\n"
    );
  }
  let prompt = readTaskPrompt(cwd, options, positionals);
  // PR-7.3 (#284) — --context <text> prepends a small context block to the
  // user prompt so callers can pass orientation (module, working area, etc.)
  // without inlining it into every Bash forward. Empty / whitespace-only
  // values are ignored. The context is wrapped in <context>…</context> so
  // it is structurally distinguishable from the user's task text.
  const explicitContext = options.context ? String(options.context).trim() : "";
  if (explicitContext) {
    prompt = `<context>\n${explicitContext}\n</context>\n\n${prompt}`;
  }

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  // PR-7.2 (#230) — --resume-id <threadId> resumes a specific previously
  // tracked Codex thread by its app-server id, bypassing the resolveLatest
  // heuristic (which finds the most recent thread for the workspace).
  // Mutually exclusive with --resume-last / --fresh because the user must
  // pick one resume strategy.
  const explicitResumeId = options["resume-id"] ? String(options["resume-id"]).trim() : null;
  if (explicitResumeId && (resumeLast || fresh)) {
    throw new Error("Choose either --resume-id <thread-id>, --resume / --resume-last, or --fresh.");
  }
  const write = Boolean(options.write);
  // PR-2.1 (#240 / #167 / #304) BREAKING — when the user did not pass
  // --sandbox explicitly, omit the field (effectiveSandbox = null) so the
  // app-server picks up `sandbox_mode` from ~/.codex/config.toml. The
  // legacy "default read-only, --write upgrades to workspace-write"
  // behavior overrode user config silently. Callers that need the legacy
  // behavior can either pass --sandbox or set CODEX_PLUGIN_SANDBOX_DEFAULT.
  //
  // writeCapable still needs to drive job-class metadata, but cannot rely
  // on knowing the final sandbox value when it is omitted. We treat the
  // task as write-capable when --write or an explicit non-read-only
  // sandbox is supplied; otherwise it inherits whatever the user
  // configured (read-only is the typical default).
  let effectiveSandbox = sandbox ?? null;
  const legacyDefault = String(process.env.CODEX_PLUGIN_SANDBOX_DEFAULT ?? "").trim();
  if (effectiveSandbox == null && write) {
    // Without an explicit sandbox and with --write, retain the v1.0.x
    // promotion to workspace-write for backwards compatibility on the
    // write path; review/read-only paths now inherit the user default.
    effectiveSandbox = legacyDefault || "workspace-write";
  } else if (effectiveSandbox == null && legacyDefault) {
    effectiveSandbox = legacyDefault;
  }
  const writeCapable = write || (effectiveSandbox != null && effectiveSandbox !== "read-only");
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = {
      ...buildTaskJob(workspaceRoot, taskMetadata, writeCapable),
      sandbox: effectiveSandbox,
      approvalPolicy
    };
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      sandbox,
      approvalPolicy,
      resumeLast,
      threadId: explicitResumeId,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = {
    ...buildTaskJob(workspaceRoot, taskMetadata, writeCapable),
    sandbox: effectiveSandbox,
    approvalPolicy
  };
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        profile: options.profile,
        fast: Boolean(options.fast),
        prompt,
        write,
        sandbox,
        approvalPolicy,
        resumeLast,
        threadId: explicitResumeId,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  // PR-3.4 (#279) — the task-worker now dispatches reviews when the
  // queued request was created by handleReviewCommand's background path.
  // Reviews carry `reviewName` (e.g. "Review" / "Adversarial Review") on
  // the stored request; tasks do not. This lets the same worker entry
  // point serve both queue types without duplicating runTrackedJob.
  const isReviewRun = typeof request.reviewName === "string" && request.reviewName.length > 0;
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      isReviewRun
        ? executeReviewRun({
            ...request,
            onProgress: progress
          })
        : executeTaskRun({
            ...request,
            onProgress: progress
          }),
    { logFile }
  );
}

function argvHasOption(argv, name) {
  const long = `--${name}`;
  return normalizeArgv(argv).some((token) => token === long || token.startsWith(`${long}=`));
}

async function handleAgent(argv) {
  const normalized = normalizeArgv(argv);
  const nextArgv = [];
  let waitRequested = false;
  let backgroundRequested = false;

  for (const token of normalized) {
    if (token === "--wait") {
      waitRequested = true;
      continue;
    }
    if (token === "--background") {
      backgroundRequested = true;
    }
    nextArgv.push(token);
  }

  if (!argvHasOption(normalized, "approval")) {
    nextArgv.unshift("on-request");
    nextArgv.unshift("--approval");
  }
  if (!argvHasOption(normalized, "sandbox") && !argvHasOption(normalized, "write")) {
    nextArgv.unshift("--write");
  }
  if (!waitRequested && !backgroundRequested) {
    nextArgv.unshift("--background");
  }

  await handleTask(nextArgv);
}

function matchJobReferenceLocal(jobs, reference) {
  if (!reference) {
    return jobs[0] ?? null;
  }
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }
  const matches = jobs.filter((job) => job.id.startsWith(reference));
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }
  return null;
}

function resolveTaskJobForContinue(workspaceRoot, reference) {
  const sessionId = getCurrentClaudeSessionId();
  let jobs = sortJobsNewestFirst(listJobs(workspaceRoot, { reap: true })).filter((job) => job.jobClass === "task");
  if (!reference && sessionId) {
    jobs = jobs.filter((job) => job.sessionId === sessionId);
  }
  const selected = matchJobReferenceLocal(jobs, reference);
  if (!selected) {
    throw new Error(reference ? `No Codex task job found for "${reference}".` : "No Codex task job found for this session.");
  }
  return selected;
}

async function handleContinue(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "job"],
    booleanOptions: ["json", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // PR-7.7 (#213) — same user-config defaults for /codex:continue. Sandbox
  // is not a continue option (the existing job's sandbox is reused), so
  // only model + effort flow through the resolvers here.
  const model = resolveModel(options.model);
  const effort = resolveEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, or piped stdin for continue.");
  }

  const selected = resolveTaskJobForContinue(workspaceRoot, options.job ?? null);
  const pendingApprovals = pendingApprovalsForJob(readStoredJob(workspaceRoot, selected.id) ?? selected);
  if (pendingApprovals.length > 0) {
    throw new Error(
      `Codex task ${selected.id} is waiting for approval. Resolve ${pendingApprovals[0].id} with /codex:approve or /codex:deny before continuing.`
    );
  }
  if ((selected.status === "queued" || selected.status === "running") && selected.threadId && selected.turnId) {
    const result = await steerAppServerTurn(cwd, {
      threadId: selected.threadId,
      turnId: selected.turnId,
      prompt
    });
    appendLogLine(selected.logFile, `Steered active turn ${selected.turnId}: ${shorten(prompt)}`);
    const payload = {
      jobId: selected.id,
      status: "steered",
      threadId: selected.threadId,
      turnId: result.turnId,
      prompt
    };
    outputCommandResult(payload, `Steered active Codex turn for ${selected.id}.\n`, options.json);
    return;
  }

  if (!selected.threadId) {
    throw new Error(`Codex task ${selected.id} does not have a thread id to continue.`);
  }

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast: true });
  const job = {
    ...buildTaskJob(workspaceRoot, taskMetadata, selected.write !== false),
    sandbox: selected.sandbox ?? null,
    approvalPolicy: selected.approvalPolicy ?? "never"
  };
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    write: selected.write !== false,
    sandbox: selected.sandbox ?? null,
    approvalPolicy: selected.approvalPolicy ?? "never",
    resumeLast: true,
    threadId: selected.threadId,
    jobId: job.id
  });

  if (options.background) {
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { json: options.json }
  );
}

function parseResponseJson(value) {
  if (value == null) {
    return null;
  }
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid --response-json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function handleApprovalDecision(argv, action) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "response-json"],
    booleanOptions: ["json", "session"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const approvalReference = positionals[0] ?? "";
  const decision = {
    action: action === "approve" && options.session ? "approve-session" : action,
    responseJson: parseResponseJson(options["response-json"])
  };
  const result = updateApprovalDecision(workspaceRoot, approvalReference, decision, {
    sessionId: getCurrentClaudeSessionId()
  });
  const payload = {
    action,
    jobId: result.jobId,
    approval: {
      id: result.approval.id,
      method: result.approval.method,
      status: result.approval.status,
      summary: result.approval.summary
    }
  };
  outputCommandResult(payload, renderApprovalDecisionResult(payload), options.json);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot, { reap: true })));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "dry-run"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });

  if (options["dry-run"]) {
    const payload = { dryRun: true, target: job };
    const rendered = [
      "# Codex Cancel (dry run)",
      "",
      `Would cancel ${job.id}.`,
      job.title ? `- Title: ${job.title}` : null,
      job.kindLabel ? `- Kind: ${job.kindLabel}` : null,
      job.summary ? `- Summary: ${job.summary}` : null,
      "",
      "Re-run without `--dry-run` to actually cancel."
    ]
      .filter(Boolean)
      .join("\n");
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Codex turn interrupt for ${turnId} on ${threadId}.`
        : `Codex turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const cancelledApprovals = normalizeApprovals(existing.pendingApprovals ?? job.pendingApprovals).map((approval) =>
    approval.status === "pending"
      ? {
          ...approval,
          status: "cancelled",
          decision: {
            action: "deny",
            decidedAt: completedAt,
            reason: "Job was cancelled before approval was resolved."
          },
          updatedAt: completedAt
        }
      : approval
  );
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user.",
    pendingApprovals: summarizePendingApprovals(cancelledApprovals),
    pendingApprovalCount: 0
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    pendingApprovals: cancelledApprovals,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    pendingApprovals: summarizePendingApprovals(cancelledApprovals),
    pendingApprovalCount: 0,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  // PR-9.1 — cancelled event. elapsedMs is best-effort; if the job never
  // recorded a startedAt (cancelled while still queued) it stays undefined
  // rather than zero so dashboards do not confuse the two.
  //
  // PR-9.1 audit finding #3 — when both `existing.traceId` and
  // `job.traceId` are absent (job cancelled before runTrackedJob's start
  // emit had a chance to attach one), synthesize a fresh trace id so the
  // event still satisfies the "every event has a traceId" invariant
  // documented in TROUBLESHOOTING.md. The synthesized id is single-use
  // (this event only) and intentionally not persisted back to the job
  // record — downstream correlation against a missing-from-the-start job
  // is impossible by construction.
  const startedAtMs = Date.parse(existing.startedAt ?? job.startedAt ?? "");
  emitEvent("cancelled", {
    traceId: existing.traceId ?? job.traceId ?? createTraceId(),
    jobId: job.id,
    jobClass: job.jobClass ?? job.kind ?? "task",
    phase: "cancelled",
    cwd: workspaceRoot,
    elapsedMs: Number.isFinite(startedAtMs) ? Date.parse(completedAt) - startedAtMs : undefined,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }
  // PR-2.1 / PR-8.6 — show the v2.0.0 BREAKING-default notice once at entry
  // for any subcommand that can hit the sandbox-default change. Setup,
  // status, result, cancel, etc. all go through this path and only print
  // the notice on its first invocation per process.
  maybeEmitV2FirstRunWarning();

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "agent":
      await handleAgent(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "continue":
      await handleContinue(argv);
      break;
    case "approve":
      handleApprovalDecision(argv, "approve");
      break;
    case "deny":
      handleApprovalDecision(argv, "deny");
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
