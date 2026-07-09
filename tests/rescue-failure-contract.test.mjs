import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = path.join(ROOT_DIR, "plugins", "opnd-codex", "agents", "codex-rescue.md");
const COMPANION = path.join(ROOT_DIR, "plugins", "opnd-codex", "scripts", "codex-companion.mjs");

const agentSource = fs.readFileSync(AGENT, "utf8");
const companionSource = fs.readFileSync(COMPANION, "utf8");

// #28 — `codex-rescue` 는 모든 실패를 한 문장으로 보고했다:
//   "the Bash call failed or was denied"
// 그래서 평범한 600초 Bash timeout 이 권한 거부로 읽혔다. 진짜 원인을 밝히는 데 네 번의
// 세션과 통제된 실험이 필요했다.

// ------------------------------------------------------------------ C2

test("the failure contract enumerates the distinct failure classes", () => {
  for (const cls of ["timeout", "permission-denied", "enoent", "nonzero-exit:<N>"]) {
    assert.ok(agentSource.includes(cls), `failure class \`${cls}\` must be spelled out`);
  }
});

test("the old lossy sentinel is gone", () => {
  assert.doesNotMatch(
    agentSource,
    /the Bash call failed or was denied/,
    "the single collapsed sentence must not survive"
  );
});

test("the contract tells the agent how to tell a timeout from a denial", () => {
  assert.match(agentSource, /Prefer `timeout` when the call ran for several minutes/);
  assert.match(agentSource, /rules out `permission-denied` and `enoent`/);
});

test("a non-zero exit must carry the actual stderr", () => {
  assert.match(agentSource, /first ~200 characters of stderr, verbatim/i);
});

// ------------------------------------------------------------------ C3

test("the #122 routing notice is explicitly exempted from the one-line failure rule", () => {
  assert.match(agentSource, /The notice survives failure/);
  assert.match(agentSource, /Emit the notice line first, then the failure line/);
});

// ------------------------------------------------------------------ C5

test("the agent is forbidden from answering without calling Bash", () => {
  assert.match(agentSource, /\*\*Always call `Bash` first\.\*\*/);
  assert.match(agentSource, /indistinguishable from a real Codex result/);
});

test("the fabrication prohibition is still intact", () => {
  assert.match(agentSource, /You MUST NOT, under any circumstance/);
  assert.match(agentSource, /a fabricated success is a correctness defect/);
});

// ------------------------------------------------------------------ C4

test("a foreground run announces its jobId before any long await", () => {
  // 그 줄은 `runTrackedJob` 이전에 나와야 한다. 아니면 죽은 Bash 호출은 그것을 보지 못한다.
  const fn = companionSource.match(/async function runForegroundCommand[\s\S]+?\n}/);
  assert.ok(fn, "runForegroundCommand found");
  const body = fn[0];

  const announceIndex = body.indexOf("jobId=${job.id}");
  const runIndex = body.indexOf("await runTrackedJob(");
  assert.ok(announceIndex > 0, "the jobId line exists");
  assert.ok(runIndex > 0, "runTrackedJob is called");
  assert.ok(announceIndex < runIndex, "the jobId is announced BEFORE the await that may be killed");
});

test("the jobId line names the recovery path", () => {
  assert.match(companionSource, /caps foreground calls at ~600s/);
  assert.match(companionSource, /--background or --resume/);
});

test("the jobId line is suppressed in --json mode", () => {
  const fn = companionSource.match(/async function runForegroundCommand[\s\S]+?\n}/)[0];
  assert.match(fn, /if \(!options\.json\) \{[\s\S]*jobId=\$\{job\.id\}/, "structured consumers keep clean stdout/stderr");
});

test("the agent's timeout guidance points at the jobId marker the companion emits", () => {
  // 양쪽 절반이 정확히 같은 prefix 를 써야 한다. 아니면 agent 는 찾으라고 지시받은 id 를
  // 결코 찾지 못한다.
  assert.match(agentSource, /\[codex-plugin-cc\] jobId=/);
  assert.match(companionSource, /\[codex-plugin-cc\] jobId=\$\{job\.id\}/);
});

// ------------------------------------------------------------------ C12

test("the worktree guard admits that dropping --background does not defeat the 600s cap", () => {
  assert.match(agentSource, /Its limit \(#28\)/);
  assert.match(agentSource, /dropping `--background` does not save it/);
  assert.match(agentSource, /Do not silently run a doomed foreground call/);
});

test("--require-broker is still mandatory (the #21 guard must not regress)", () => {
  assert.match(agentSource, /ALWAYS pass `--require-broker`/);
  assert.match(agentSource, /Never omit it/);
});
