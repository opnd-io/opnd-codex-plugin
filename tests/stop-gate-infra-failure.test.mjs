import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  detectInfrastructureFailure,
  evaluateStopReviewResult,
  parseStopReviewOutput,
  readRecognizedDecision
} from "../plugins/opnd-codex/scripts/stop-review-gate-hook.mjs";
import { setConfig } from "../plugins/opnd-codex/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

const HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins/opnd-codex/scripts/stop-review-gate-hook.mjs"
);

// C1 — `runStopReview` 는 `maxBuffer` 없이 리뷰 자식을 spawn 했다. `task --json` payload
// (모델의 `rawOutput` 전문을 싣는다) 가 Node 기본값 1 MB 를 넘는 순간 자식이 죽었다:
// `status: null`, `signal: SIGTERM`, `error.code: ENOBUFS`, stdout 잘림.
// `detectInfrastructureFailure` 는 `ETIMEDOUT` 만 보고 빈 stdout 을 요구했으므로 null 을
// 반환했고, 호출자는 `status !== 0` 으로 흘러 `decision: "block"` 이 됐다.
//
// 그것이 바로 PR-3.1 이 막으려던 rewake 루프이며, PR-3.1 이 고려하지 않은 경로로 도달했다.

function fakeResult(overrides = {}) {
  return { status: 0, signal: null, error: undefined, stdout: "", stderr: "", ...overrides };
}

function jsonPayload(rawOutput) {
  return JSON.stringify({ rawOutput });
}

// ------------------------------------------------- 플랫폼 동작 자체

test("spawnSync really does report a maxBuffer overflow as an error + signal, not an exit code", () => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });

  assert.equal(result.status, null, "no exit code — the child was killed");
  assert.ok(result.error, "an error object is present");
  assert.ok(result.signal, "and a signal");
  // `code` 문자열은 Node 버전마다 다르다 (24.x 는 ENOBUFS, 과거에는
  // ERR_CHILD_PROCESS_STDIO_MAXBUFFER). 분류기가 그것을 비교하면 안 되는 이유다.
  assert.ok(result.stdout.length > 0, "stdout is non-empty but truncated");
});

test("raising maxBuffer lets the same payload through intact", () => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.length, 2 * 1024 * 1024);
});

// ------------------------------------------------- 회귀

test("a maxBuffer overflow is an infrastructure failure, not a BLOCK", () => {
  const result = fakeResult({
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync node ENOBUFS"), { code: "ENOBUFS" }),
    stdout: '{"rawOutput":"...truncated mid-sen'
  });

  const infra = detectInfrastructureFailure(result);
  assert.ok(infra, "classified as infrastructure");
  assert.match(infra.type, /^spawn-error:ENOBUFS$/);

  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, true, "session is allowed to end");
  assert.equal(review.skipped, true);
  assert.match(review.skipReason, /Stop-time review skipped/);
});

test("the classifier keys off the error object, not its code string", () => {
  // 미래의 Node 가 ENOBUFS 를 개명해도 구멍이 조용히 다시 열려서는 안 된다.
  for (const code of ["ENOBUFS", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "SOME_FUTURE_CODE", undefined]) {
    const result = fakeResult({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("boom"), code ? { code } : {}),
      stdout: '{"rawOutput":"trunc'
    });
    assert.equal(evaluateStopReviewResult(result).ok, true, `code=${code} must allow-skip`);
  }
});

test("an external signal kill with partial output is an infrastructure failure", () => {
  const result = fakeResult({
    status: null,
    signal: "SIGKILL",
    stdout: '{"rawOutput":"BLO',
    stderr: ""
  });
  const infra = detectInfrastructureFailure(result);
  assert.equal(infra.type, "signal-kill:SIGKILL");
  assert.equal(evaluateStopReviewResult(result).ok, true);
});

// ------------------------------------------------- 파싱 우선 순서

test("a complete BLOCK written before a signal kill still blocks", () => {
  // 순서 제약: 자식이 실제로 다 써낸 결정이 권위를 갖는다. `signal` 로 먼저 분류하면
  // 진짜 BLOCK 이 allow-skip 으로 빠져나가는데, 이는 반대 방향의 실패이고 훨씬 나쁘다.
  const result = fakeResult({
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("killed"), { code: "ENOBUFS" }),
    stdout: jsonPayload("BLOCK: tests are failing")
  });

  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, false, "a finished BLOCK is honored");
  assert.equal(review.skipped, undefined, "not treated as a skip");
  assert.match(review.reason, /tests are failing/);
});

test("a complete ALLOW written before a signal kill still allows (and is not a skip)", () => {
  const result = fakeResult({
    status: null,
    signal: "SIGTERM",
    stdout: jsonPayload("ALLOW: looks good")
  });
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, true);
  assert.equal(review.skipped, undefined, "a real ALLOW is a decision, not a skipped gate");
});

test("a BLOCK whose review text mentions 'quota' is not mistaken for a rate limit", () => {
  const result = fakeResult({
    status: 0,
    stdout: jsonPayload("BLOCK: the quota check in billing.ts is inverted")
  });
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, false, "the decision wins over the rate-limit signature scan");
  assert.match(review.reason, /quota check in billing\.ts/);
});

test("an unrecognized shape after a clean exit still blocks (bucket c preserved)", () => {
  const result = fakeResult({ status: 0, stdout: jsonPayload("I think it is probably fine?") });
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, false);
  assert.match(review.reason, /unexpected answer/);
  assert.equal(review.skipped, undefined, "not an allow-skip");
});

test("an unrecognized shape after a signal kill is an infrastructure failure, not a block", () => {
  const result = fakeResult({
    status: null,
    signal: "SIGTERM",
    stdout: jsonPayload("I think it is probably fine?")
  });
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, true, "we cannot trust prose from a killed child");
  assert.equal(review.skipped, true);
});

// ------------------------------------------------- 기존 버킷 유지 확인

test("rate-limit output allow-skips", () => {
  const result = fakeResult({ status: 1, stderr: "429 rate limit exceeded" });
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, true);
  assert.equal(review.skipped, true);
});

test("a timeout allow-skips with the dedicated message", () => {
  const result = fakeResult({
    status: null,
    error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
  });
  assert.equal(detectInfrastructureFailure(result).type, "timeout");
  assert.equal(evaluateStopReviewResult(result).ok, true);
});

test("non-zero exit with empty stdout allow-skips", () => {
  const result = fakeResult({ status: 1, stdout: "", stderr: "codex: command not found" });
  assert.equal(detectInfrastructureFailure(result).type, "non-zero-exit-empty");
  assert.equal(evaluateStopReviewResult(result).ok, true);
});

test("invalid JSON after a clean exit allow-skips", () => {
  const result = fakeResult({ status: 0, stdout: "not json at all" });
  assert.equal(detectInfrastructureFailure(result), null);
  const review = evaluateStopReviewResult(result);
  assert.equal(review.ok, true);
  assert.match(review.skipReason, /invalid JSON/);
});

test("a clean ALLOW allows and a clean BLOCK blocks", () => {
  assert.equal(evaluateStopReviewResult(fakeResult({ stdout: jsonPayload("ALLOW: ok") })).ok, true);
  assert.equal(evaluateStopReviewResult(fakeResult({ stdout: jsonPayload("BLOCK: nope") })).ok, false);
});

// ------------------------------------------------- 헬퍼

test("readRecognizedDecision only accepts the two shapes the prompt asks for", () => {
  assert.equal(readRecognizedDecision("")?.ok, undefined);
  assert.equal(readRecognizedDecision("garbage"), null);
  assert.equal(readRecognizedDecision(jsonPayload("")), null, "empty rawOutput is not a decision");
  assert.equal(readRecognizedDecision(jsonPayload("maybe")), null, "prose is not a decision");
  assert.equal(readRecognizedDecision(jsonPayload("ALLOW: fine")).ok, true);
  assert.equal(readRecognizedDecision(jsonPayload("BLOCK: bad")).ok, false);
});

test("parseStopReviewOutput marks which answers it actually recognized", () => {
  assert.equal(parseStopReviewOutput("ALLOW: x").recognized, true);
  assert.equal(parseStopReviewOutput("BLOCK: y").recognized, true);
  assert.equal(parseStopReviewOutput("").recognized, false);
  assert.equal(parseStopReviewOutput("hmm").recognized, false);
});

test("importing the hook module does not execute it", () => {
  // 위 테스트들을 가능하게 하는 것이 `import.meta.url === argv[1]` 가드다. 이것이
  // 회귀하면 이 파일의 모든 테스트가 진짜 hook 을 실행하게 된다.
  assert.ok(true, "reaching this line means main() did not take over the process");
});

test("the script guard survives a symlinked plugin root", () => {
  // Node 는 메인 모듈의 `import.meta.url` 을 REAL path 로 해석하지만 `argv[1]` 은 호출자가
  // 입력한 그대로 둔다. ~/.claude/plugins 에 설치된 플러그인처럼 디렉터리 링크를 통해 hook
  // 을 호출하면 맨 URL 문자열 비교는 false 가 된다: Stop hook 이 exit 0 하고 실행되지 않는다.
  const real = makeTempDir();
  const probe = path.join(real, "probe.mjs");
  fs.writeFileSync(
    probe,
    [
      'import fs from "node:fs";',
      'import { fileURLToPath, pathToFileURL } from "node:url";',
      "const entry = process.argv[1];",
      "let urlOnly = false;",
      "try { urlOnly = Boolean(entry) && import.meta.url === pathToFileURL(entry).href; } catch {}",
      "let withRealpath = urlOnly;",
      "if (!withRealpath) { try {",
      "  const self = fs.realpathSync(fileURLToPath(import.meta.url));",
      "  const invoked = fs.realpathSync(entry);",
      '  withRealpath = process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;',
      "} catch {} }",
      "process.stdout.write(JSON.stringify({ urlOnly, withRealpath }));"
    ].join("\n"),
    "utf8"
  );

  const link = path.join(os.tmpdir(), `codex-plugin-test-guardlink-${process.pid}`);
  fs.rmSync(link, { recursive: true, force: true });
  try {
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return; // 개발자 모드 없는 비권한 Windows — assert 할 것이 없다
  }

  try {
    const result = spawnSync(process.execPath, [path.join(link, "probe.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const { urlOnly, withRealpath } = JSON.parse(result.stdout);

    assert.equal(urlOnly, false, "the naive URL comparison fails here — this is the trap");
    assert.equal(withRealpath, true, "the realpath fallback is what keeps the hook alive");
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
  }
});

test("but spawning the hook as a script DOES execute main()", () => {
  // 그 가드의 나머지 절반이자 위험한 절반. `import.meta.url` 이 `pathToFileURL(argv[1])` 와
  // 더 이상 일치하지 않게 되면 — 드라이브 문자 대소문자 차이, symlink 된 plugin root, 진입
  // URL 을 다시 쓰는 loader — Stop hook 은 조용한 no-op 이 된다: exit 0, 출력 없음, 리뷰
  // gate 미실행. 스위트의 다른 무엇도 눈치채지 못한다.
  //
  // gate 를 켜고 PATH 에서 codex 를 뺀다: 그러면 main() 이 Codex 가 설정되지 않았다고
  // 항의해야 한다. 그 줄은 main() 에서만 나올 수 있다.
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  setConfig(workspaceRoot, "stopReviewGate", true);

  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: workspaceRoot,
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: workspaceRoot, CODEX_PLUGIN_TELEMETRY_DISABLED: "1", PATH: "" },
    timeout: 30000
  });

  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  assert.match(
    result.stderr ?? "",
    /Codex is not set up for the review gate/,
    "main() did not run — the script guard is broken and the Stop hook is a silent no-op"
  );
});
