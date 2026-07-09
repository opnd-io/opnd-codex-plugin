import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  __resetTelemetryFailureState,
  classifyErrorClass,
  emitEvent,
  resolveRotatedTelemetryFile,
  resolveTelemetryFile,
  resolveTelemetryMaxBytes,
  rotateTelemetryIfNeeded,
  __telemetryWriteFailureCount,
  TELEMETRY_MAX_BYTES
} from "../plugins/opnd-codex/scripts/lib/telemetry.mjs";
// 종료 시 스윕(O3)이 회수하도록 helper 를 통해 등록한다.
import { makeTempDir } from "./helpers.mjs";

function freshDataDir() {
  return makeTempDir("codex-plugin-test-tel-");
}

function envFor(dataDir, extra = {}) {
  return { CODEX_PLUGIN_DATA_DIR: dataDir, ...extra };
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------- O6

test("classifyErrorClass separates caller mistakes from runtime failures", () => {
  assert.equal(
    classifyErrorClass("No previous Codex task thread was found for this repository. Start a new one."),
    "input"
  );
  assert.equal(
    classifyErrorClass("Provide a prompt, --prompt-file <path>, --prompt-stdin, piped stdin, or use --resume-last"),
    "input"
  );
  assert.equal(classifyErrorClass("Task task-abc is still running. Use /opnd-codex:status to poll."), "input");
});

test("classifyErrorClass buckets the observed production failure messages", () => {
  assert.equal(classifyErrorClass("No live Codex broker is available for this workspace"), "broker");
  assert.equal(classifyErrorClass("Shared Codex broker is busy."), "broker");
  assert.equal(classifyErrorClass("Your access token could not be refreshed because your refresh token was already used"), "auth");
  assert.equal(classifyErrorClass("authentication expired; run codex login"), "auth");
  assert.equal(classifyErrorClass("You have hit your usage limit."), "rate-limit");
  assert.equal(classifyErrorClass("Selected model is at capacity. Please retry."), "rate-limit");
  assert.equal(classifyErrorClass("Codex app-server error: Reconnecting... 2/5"), "network");
  assert.equal(classifyErrorClass("stop-time review timed out after 15 minutes"), "timeout");
});

test("a JSON parse error that merely contains the letters 'quota' is not a rate limit", () => {
  // `quota` 에 단어 경계가 없었고, rate-limit 규칙이 parse 규칙보다 먼저 평가되어
  // "malformed quotation" 이 rate-limit 으로 분류됐다. 같은 레포의 형제 classifier 인
  // stop-review-gate-hook.mjs 는 이미 `\bquota\b` 를 쓰고 있었다.
  assert.equal(classifyErrorClass('Unexpected token " — malformed quotation in response'), "parse");
  assert.equal(classifyErrorClass("invalid json: bad quotation mark"), "parse");
  // 그리고 진짜 quota 메시지는 여전히 분류된다.
  assert.equal(classifyErrorClass("quota exceeded"), "rate-limit");
  assert.equal(classifyErrorClass("Your quota is used up"), "rate-limit");
});

test("classifyErrorClass falls back to 'other' rather than guessing", () => {
  assert.equal(classifyErrorClass("something entirely unexpected"), "other");
  assert.equal(classifyErrorClass(""), "other");
  assert.equal(classifyErrorClass(undefined), "other");
});

test("classifyErrorClass prefers the more specific bucket when two could match", () => {
  // "is still running" 은 느슨하게 보면 runtime 조건으로도 읽히지만, 실행 자체가
  // 시작되지 않았으므로 input 규칙을 먼저 둔다.
  assert.equal(classifyErrorClass("Task task-x is still running. Use /opnd-codex:cancel"), "input");
  // timeout 을 함께 언급하는 broker 메시지는 여전히 broker 문제다.
  assert.equal(classifyErrorClass("No live Codex broker is available (last probe timed out)"), "broker");
});

// ---------------------------------------------------------------- O7

test("rotateTelemetryIfNeeded is a no-op below the cap and rotates above it", () => {
  const dataDir = freshDataDir();
  const env = envFor(dataDir, { CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "512" });
  const file = resolveTelemetryFile(env);
  const rotated = resolveRotatedTelemetryFile(env);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x".repeat(100), "utf8");
  assert.equal(rotateTelemetryIfNeeded(env), false, "under cap → no rotation");
  assert.equal(fs.existsSync(rotated), false);

  fs.writeFileSync(file, "x".repeat(600), "utf8");
  assert.equal(rotateTelemetryIfNeeded(env), true, "over cap → rotates");
  assert.equal(fs.existsSync(rotated), true);
  assert.equal(fs.existsSync(file), false, "current file is moved aside, not copied");
});

test("rotateTelemetryIfNeeded tolerates a missing ledger", () => {
  const env = envFor(freshDataDir());
  assert.equal(rotateTelemetryIfNeeded(env), false);
});

test("rotateTelemetryIfNeeded replaces a previous rotated file rather than growing forever", () => {
  const dataDir = freshDataDir();
  const env = envFor(dataDir, { CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "64" });
  const file = resolveTelemetryFile(env);
  const rotated = resolveRotatedTelemetryFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, "first".padEnd(100, "!"), "utf8");
  rotateTelemetryIfNeeded(env);
  fs.writeFileSync(file, "second".padEnd(100, "!"), "utf8");
  rotateTelemetryIfNeeded(env);

  assert.match(fs.readFileSync(rotated, "utf8"), /^second/, "rotated file holds the most recent segment");
  assert.equal(fs.existsSync(`${rotated}.1`), false, "no unbounded chain of rotated files");
});

test("a rotation that cannot rename leaves the existing rotated segment intact", () => {
  // 회전은 rename 전에 `rmSync(rotated)` 를 했었다. 두 writer 가 모두 그 지점에 도달할
  // 수 있다: A 가 rename 한 뒤 B 가 A 의 갓 회전된 세그먼트를 unlink 하고, 자기 rename 은
  // 실패한다(원본이 이미 사라짐). B 는 아무 이유 없이 A 의 데이터를 파괴했다.
  // `renameSync` 는 목적지를 원자적으로 대체하므로 unlink 가 있어선 안 된다.
  const dataDir = freshDataDir();
  const env = envFor(dataDir, { CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "8" });
  const file = resolveTelemetryFile(env);
  const rotated = resolveRotatedTelemetryFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(rotated, "PRECIOUS-EARLIER-SEGMENT", "utf8");
  // 현재 파일이 아예 없다: `statSync` 가 throw 하고 회전은 아무것도 건드리기 전에
  // 빠져나온다. 회전 세그먼트는 살아남아야 한다.
  assert.equal(rotateTelemetryIfNeeded(env), false);
  assert.equal(fs.readFileSync(rotated, "utf8"), "PRECIOUS-EARLIER-SEGMENT", "not unlinked speculatively");

  // 이제 상한을 넘는 현재 파일이 있다: rename 이 목적지를 대체한다.
  fs.writeFileSync(file, "NEWER-SEGMENT-THAT-EXCEEDS-THE-CAP", "utf8");
  assert.equal(rotateTelemetryIfNeeded(env), true);
  assert.equal(fs.readFileSync(rotated, "utf8"), "NEWER-SEGMENT-THAT-EXCEEDS-THE-CAP");
  assert.equal(fs.existsSync(file), false);
});

test("emitEvent rotates in-line so the ledger never outgrows the readers' window", () => {
  const dataDir = freshDataDir();
  const env = envFor(dataDir, { CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "300" });
  const file = resolveTelemetryFile(env);

  for (let i = 0; i < 12; i += 1) {
    emitEvent("progress", { traceId: "t", jobId: `job-${i}` }, { env });
  }

  assert.ok(fs.statSync(file).size < 300 + 400, "current ledger stays near the cap");
  assert.equal(fs.existsSync(resolveRotatedTelemetryFile(env)), true, "older events preserved in .1");
});

test("resolveTelemetryMaxBytes honors the env override and rejects nonsense", () => {
  assert.equal(resolveTelemetryMaxBytes({}), TELEMETRY_MAX_BYTES);
  assert.equal(resolveTelemetryMaxBytes({ CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "1024" }), 1024);
  assert.equal(resolveTelemetryMaxBytes({ CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "0" }), TELEMETRY_MAX_BYTES);
  assert.equal(resolveTelemetryMaxBytes({ CODEX_PLUGIN_TELEMETRY_MAX_BYTES: "abc" }), TELEMETRY_MAX_BYTES);
});

// ---------------------------------------------------------------- O9

test("a failed write is counted and then recorded once a write succeeds again", () => {
  __resetTelemetryFailureState();
  const dataDir = freshDataDir();
  const env = envFor(dataDir);
  const file = resolveTelemetryFile(env);

  // telemetry *파일 경로* 를 디렉토리로 만들어, mkdirSync(dir) 은 성공하되
  // appendFileSync 는 실패하게 한다.
  fs.mkdirSync(file, { recursive: true });

  const originalWrite = process.stderr.write.bind(process.stderr);
  let warned = "";
  process.stderr.write = (chunk) => {
    warned += String(chunk);
    return true;
  };
  try {
    assert.equal(emitEvent("started", { traceId: "t", jobId: "j1" }, { env }), false, "write fails");
    assert.equal(__telemetryWriteFailureCount(), 1);
    assert.match(warned, /\[codex-telemetry\] write failed/);
    assert.match(warned, /undercount/, "the warning says why it matters");
  } finally {
    process.stderr.write = originalWrite;
  }

  // 경로를 복구하고 다시 emit 한다: 손실이 stream 에 기록되어야 한다.
  fs.rmSync(file, { recursive: true, force: true });
  assert.equal(emitEvent("started", { traceId: "t", jobId: "j2" }, { env }), true);
  assert.equal(__telemetryWriteFailureCount(), 0, "counter drains once recorded");

  const events = readLines(file);
  const marker = events.find((e) => e.event === "telemetry_write_failed");
  assert.ok(marker, "loss is visible in the ledger, not just on stderr");
  assert.equal(marker.extras.droppedEvents, 1);
  assert.ok(
    events.some((e) => e.event === "started" && e.jobId === "j2"),
    "the successful event is still written"
  );
  __resetTelemetryFailureState();
});

test("consecutive failed writes accumulate and are reported as one marker", () => {
  // 주의: 이 테스트는 `if (!recorded) deferredWriteFailures += lost` 복원 분기를
  // 실행하지 않는다. `flushDeferredWriteFailures` 는 emitEvent 의 성공 경로에서만 돌고,
  // 그것이 쓰는 마커는 방금 primary append 를 받아들인 바로 그 파일로 간다 — 즉 public
  // API 로는 primary 가 성공하는 동안 마커 write 만 실패시킬 수 없다. 그 분기는 방어용이다.
  // 여기서 고정하는 것은 도달 가능한 부분이다: 손실이 호출 간에 누적되어, 마지막 시도분
  // 하나로 리셋되지 않고 전체 개수를 담은 단일 마커로 기록된다.
  __resetTelemetryFailureState();
  const dataDir = freshDataDir();
  const env = envFor(dataDir);
  const file = resolveTelemetryFile(env);

  fs.mkdirSync(file, { recursive: true }); // 모든 append 를 실패시킨다

  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    // 이벤트 3건 유실.
    emitEvent("started", { traceId: "t", jobId: "a" }, { env });
    emitEvent("started", { traceId: "t", jobId: "b" }, { env });
    emitEvent("started", { traceId: "t", jobId: "c" }, { env });
    assert.equal(__telemetryWriteFailureCount(), 3);

    // 마커 write 도 실패한다. 카운트는 1로 리셋되지 않고 살아남아야 한다.
    fs.rmSync(file, { recursive: true, force: true });
    fs.mkdirSync(file, { recursive: true });
    emitEvent("started", { traceId: "t", jobId: "d" }, { env });
    assert.ok(
      __telemetryWriteFailureCount() >= 4,
      `expected the 3 lost events to be retained (plus the new failure), got ${__telemetryWriteFailureCount()}`
    );
  } finally {
    process.stderr.write = originalWrite;
  }

  // 이제 write 를 성공시킨다: 손실 전체가 마커 하나에 실린다.
  fs.rmSync(file, { recursive: true, force: true });
  assert.equal(emitEvent("started", { traceId: "t", jobId: "e" }, { env }), true);

  const marker = readLines(file).find((e) => e.event === "telemetry_write_failed");
  assert.ok(marker, "the loss is recorded");
  assert.ok(marker.extras.droppedEvents >= 4, `reported ${marker.extras.droppedEvents} dropped events`);
  assert.equal(__telemetryWriteFailureCount(), 0);
  __resetTelemetryFailureState();
});

test("emitEvent stays a no-op when telemetry is disabled, even with pending failures", () => {
  __resetTelemetryFailureState();
  const env = envFor(freshDataDir(), { CODEX_PLUGIN_TELEMETRY_DISABLED: "1" });
  assert.equal(emitEvent("started", { traceId: "t" }, { env }), false);
  assert.equal(__telemetryWriteFailureCount(), 0, "disabled is not a failure");
  __resetTelemetryFailureState();
});
