#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { readHookStdinJsonAsync } from "./lib/fs.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

// PR-1.6 (#120 / #191) — sync fs.readFileSync(0) blocks the Stop hook on
// Windows when stdin is never closed by the parent and crashes with EAGAIN
// on parallel sessions sharing a non-blocking pipe. Switch to event-based
// async drain with a 5s fallback so both failure modes degrade to an
// empty-input run instead of stalling for the 900s hook timeout.
async function readHookInput() {
  return readHookStdinJsonAsync({ timeoutMs: 5000 });
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /opnd-codex:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /opnd-codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /opnd-codex:review --wait manually or bypass the gate."
  };
}

// PR-3.1 (#306 / #248 / #273) — separate infrastructure failures from
// real BLOCK decisions. The old code returned ok:false for every non-zero
// exit, every timeout, every parse error, and EVERY rate-limit response.
// main() then unconditionally emitted decision:"block", which Claude Code
// re-waked on, which re-spawned the gate, which re-hit the rate limit...
// burning the user's session token budget while no actual review ran.
//
// This commit classifies the outcome into three buckets:
//
//   (a) Codex emitted a structured ALLOW / BLOCK → return ok / block
//       per the user's policy (unchanged)
//   (b) Infrastructure failure (timeout, status≠0, empty payload, invalid
//       JSON, rate-limit / quota signatures) → return decision:"allow"
//       with a stderr warning so the user knows the gate skipped, but
//       the session can still end without a rewake loop
//   (c) Codex finished cleanly but parseStopReviewOutput returned an
//       "unexpected" shape → keep the existing block behavior so a real
//       BLOCK never leaks through
const RATE_LIMIT_SIGNATURES = [
  /\brate.?limit/i,
  /\b429\b/,
  /\busage\s+limit/i,
  /\bquota[ _]?exceeded/i,
  /rate[ _]?limited/i,
  /\bquota\b/i
];

function detectInfrastructureFailure(result) {
  const stderrText = String(result.stderr ?? "");
  const stdoutText = String(result.stdout ?? "");
  const combined = `${stderrText}\n${stdoutText}`;
  for (const pattern of RATE_LIMIT_SIGNATURES) {
    if (pattern.test(combined)) {
      return { type: "rate-limit", excerpt: combined.slice(0, 240) };
    }
  }
  if (result.error?.code === "ETIMEDOUT") {
    return { type: "timeout", excerpt: "stop-time review timed out after 15 minutes" };
  }
  // Empty stdout AND non-zero exit is the canonical "review never ran" shape.
  if ((result.status ?? 1) !== 0 && !stdoutText.trim()) {
    return { type: "non-zero-exit-empty", excerpt: stderrText.trim().slice(0, 240) };
  }
  return null;
}

function buildAllowSkip(reason) {
  return {
    ok: true,
    skipped: true,
    skipReason: reason
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  // PR-fix (analyze HIGH-1) — the stop-review prompt embeds
  // last_assistant_message, which can be arbitrarily large. Passing it as an
  // argv element trips the OS argv-size limit (E2BIG on POSIX, a silent
  // truncation/spawn failure on Windows), and the gate then skips with no
  // review ever running. Feed the prompt over stdin via --prompt-stdin so the
  // payload size is bounded only by the pipe, not by ARG_MAX.
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", "--prompt-stdin"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  const infra = detectInfrastructureFailure(result);
  if (infra) {
    return buildAllowSkip(`Stop-time review skipped (${infra.type}): ${infra.excerpt}`);
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /opnd-codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    // Invalid JSON after a clean exit is also an infrastructure failure
    // pattern (broker emitted partial output, MCP crashed mid-turn, etc.).
    // Treat as allow-skip so we never block on parse glitches alone.
    return buildAllowSkip(
      "Stop-time review returned invalid JSON. Allowing session end; re-run /opnd-codex:review --wait manually to inspect."
    );
  }
}

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot, { reap: true }), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /opnd-codex:status and use /opnd-codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (review.skipped) {
    // PR-3.1 — infrastructure failure path. Allow session end + warn so the
    // user sees what happened, instead of triggering a Claude rewake loop.
    logNote(review.skipReason);
    logNote(runningTaskNote);
    return;
  }
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
