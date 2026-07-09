#!/usr/bin/env node

import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { readHookStdinJsonAsync } from "./lib/fs.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { createTraceId, emitEvent } from "./lib/telemetry.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
// C1 — `spawnSync` 의 stdout 버퍼 기본값은 1 MB 다. `task --json` payload 는
// `rawOutput`(모델의 최종 메시지 전문)을 싣고 있어 그것을 넘길 수 있다. 넘기면 Node 가
// 자식을 죽이고 `error.code` 를 세우며(Node 24 는 ENOBUFS, 구버전은
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER) `status` 를 null 로 둔 채 stdout 을 자른다 —
// 아래 분류기가 정책 BLOCK 으로 오인하던 모양이다. 대용량 캡처에 repo 가 쓰는 버퍼와
// 같은 값으로 맞춘다.
const STOP_REVIEW_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
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

// `recognized` 는 prompt 가 실제로 요구하는 두 가지 모양을 표시한다. 그 외(비어 있거나
// 자유 서술)는 우리가 조치할 수 없는 모양이고, 호출자는 그것을 권위 있는 결정으로
// 취급해서는 안 된다.
export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      recognized: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /opnd-codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, recognized: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      recognized: true,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    recognized: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /opnd-codex:review --wait manually or bypass the gate."
  };
}

// C1 — 분류하기 전에 파싱한다. 완전한 `BLOCK:` 줄을 쓴 *뒤* 죽은 자식(혹은 리뷰 본문에
// 우연히 "quota" 라는 단어가 들어간 자식)은 이미 답을 말한 것이고, signal 은 부수적이다.
// stdout 에 인식된 결정이 실려 있지 않으면 null 을 반환하므로 모호한 경우는 여전히
// 인프라 분류기가 소유한다.
export function readRecognizedDecision(stdout) {
  const text = String(stdout ?? "");
  if (!text.trim()) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null; // 잘렸거나 뒤섞였다 — 답이 아니다.
  }
  const parsed = parseStopReviewOutput(payload?.rawOutput);
  return parsed.recognized ? parsed : null;
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

export function detectInfrastructureFailure(result) {
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
  // C1 — 그 밖의 `error` 객체는 자식이 자기 방식대로 끝나지 못했다는 뜻이다: 버퍼 넘침
  // (ENOBUFS / ERR_CHILD_PROCESS_STDIO_MAXBUFFER), 바이너리 부재(ENOENT), spawn 거부
  // (EACCES). 특정 `code` 문자열이 아니라 객체의 *존재* 를 검사한다 — 같은 조건에도 code
  // 는 Node 버전마다 다르고, 여기서 문자열을 비교한 것이 maxBuffer 경우를 아래 BLOCK
  // 분기로 새어 들어가게 한 원인이다.
  if (result.error) {
    const code = result.error.code ?? "unknown";
    const message = result.error.message ?? String(result.error);
    return { type: `spawn-error:${code}`, excerpt: message.slice(0, 240) };
  }
  // signal 로 죽었다 (외부 OOM, taskkill, maxBuffer 가드의 SIGTERM). `stdout` 이 비어
  // 있지 않을 수 있으나 스트림 도중에 잘린 것이라 답이 아니다. kill 이전에 쓰인 *완전한*
  // 결정은 이미 readRecognizedDecision() 이 위로 반환했다.
  if (result.signal) {
    // signal kill 은 대개 stderr 를 전혀 남기지 않고, 빈 excerpt 는 무엇이 리뷰를 죽였는지
    // 운영자에게 아무것도 알려주지 않는다. 아는 것만이라도 말한다.
    const detail = stderrText.trim().slice(0, 200);
    const captured = `stdout ${stdoutText.length}B, stderr ${stderrText.length}B`;
    return {
      type: `signal-kill:${result.signal}`,
      excerpt: detail ? `${detail} (${captured})` : `no output captured (${captured})`
    };
  }
  // Empty stdout AND non-zero exit is the canonical "review never ran" shape.
  if ((result.status ?? 1) !== 0 && !stdoutText.trim()) {
    return { type: "non-zero-exit-empty", excerpt: stderrText.trim().slice(0, 240) };
  }
  return null;
}

/**
 * `spawnSync` 결과를 PR-3.1 의 세 버킷 중 하나로 분류한다.
 *
 * 실제 15분짜리 Codex turn 대신 합성 결과로 분류를 검증할 수 있도록 export 한다.
 */
export function evaluateStopReviewResult(result) {
  // (a′) 완전하고 인식된 결정이 항상 이긴다 — signal kill 보다도.
  const decision = readRecognizedDecision(result.stdout);
  if (decision) {
    return decision;
  }

  // (b) 인프라 실패: 세션 종료를 허용하고 stderr 로 경고한다.
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
    // (c) 정상 종료 + 인식되지 않은 모양: 계속 block 한다. 진짜 BLOCK 이 allow 로 새어
    // 나가지 않도록.
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    // 정상 종료 후의 invalid JSON 도 인프라 실패 패턴이다 (broker 가 부분 출력을 냈거나,
    // MCP 가 turn 도중 죽는 등). 파싱 결함만으로 block 하지 않도록 allow-skip 으로 본다.
    return buildAllowSkip(
      "Stop-time review returned invalid JSON. Allowing session end; re-run /opnd-codex:review --wait manually to inspect."
    );
  }
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
    timeout: STOP_REVIEW_TIMEOUT_MS,
    maxBuffer: STOP_REVIEW_MAX_BUFFER_BYTES
  });

  return evaluateStopReviewResult(result);
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
    //
    // 경고는 아무도 보관하지 않는 stderr 한 줄이다. `codex` 설치가 깨진 상태에서 fail-open
    // 하는 gate 는 *모든* 세션 종료에서 skip 하는데, 지금까지 흔적은 그 줄뿐이었다: ledger
    // 에는 정상 세션이 기록되고, 운영자는 조용히 멈춘 enforcement 를 보고 있었다. skip 을
    // 기록한다.
    emitEvent("progress", {
      traceId: createTraceId(),
      phase: "stop_review_skipped",
      cwd: workspaceRoot,
      skipReason: review.skipReason
    });
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

/**
 * 우리가 import 된 모듈이 아니라 프로세스 진입점인가?
 *
 * 이 가드 덕분에 위 분류기를 source-regex assertion 으로 고정하는 대신 직접 검증할 수
 * 있다. 동시에 이 파일에서 가장 위험한 줄이다: 잘못 false 를 반환하면 Stop hook 이 출력
 * 없이 exit 0 하고 리뷰 gate 가 조용히 멈춘다. 아무도 눈치채지 못한다.
 *
 * 맨 `import.meta.url === pathToFileURL(argv[1]).href` 는 같은 파일에 대해서도 달라질 수
 * 있는 두 문자열을 비교한다 — symlink 된 plugin root, 8.3 단축 경로, UNC 경로, 대소문자가
 * 다른 드라이브 문자. 해석된 real path 비교로 폴백하면 그 모두가 하나로 접힌다.
 */
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    if (import.meta.url === pathToFileURL(entry).href) {
      return true;
    }
  } catch {
    // 경로가 아닌 argv[1] (`-e`, `--`) 은 그냥 우리가 아니다.
  }
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const invoked = fs.realpathSync(entry);
    return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch (error) {
    // "진입점이 아니다" 와 "판단할 수 없었다" 는 다른 답이고, 후자는 리뷰 gate 를 조용히
    // 비활성화한다. 그렇다고 말한다 — 아니면 출력 없이 exit 0 하는 hook 은 실행 후 allow 한
    // hook 과 구별되지 않는다.
    try {
      process.stderr.write(
        `[stop-gate] could not confirm this file is the process entry point (${error?.message ?? error}). ` +
          `The stop-time review gate did not run.\n`
      );
    } catch {
      // stderr 가 깨졌다. 더 할 수 있는 것이 없다.
    }
    return false;
  }
}

if (invokedAsScript()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
