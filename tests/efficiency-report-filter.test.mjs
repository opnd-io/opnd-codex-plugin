import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";

import { isTestOriginEvent, readEvents, summarize } from "../plugins/opnd-codex/scripts/codex-efficiency-report.mjs";
import { makeTempDir } from "./helpers.mjs";

// O2 — 공유 telemetry ledger 에는 `CODEX_PLUGIN_DATA_DIR` 를 격리하지 않은 테스트
// 실행의 이벤트가 쌓인다. 이 필터 이전에는 리포트가 그것들을 프로덕션 트래픽으로 세어
// 모든 수치가 몇 배로 부풀었다.

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    ts: "2026-07-09T00:00:00.000Z",
    event: "completed",
    traceId: "t",
    jobId: "task-abc-def",
    jobClass: "task",
    cwd: "D:\\work\\real-project",
    ...overrides,
  };
}

test("isTestOriginEvent flags temp workspaces created by the test suite", () => {
  assert.equal(isTestOriginEvent(event({ cwd: "C:\\Temp\\codex-plugin-test-Ab12Cd" })), true);
  assert.equal(isTestOriginEvent(event({ cwd: "/tmp/codex-plugin-test-xyz" })), true);
  assert.equal(isTestOriginEvent(event({ cwd: "/tmp/codex-companion/telemetry" })), true);
});

test("isTestOriginEvent flags fixture job ids that leaked into the ledger", () => {
  assert.equal(isTestOriginEvent(event({ jobId: "task-test-sigterm" })), true);
  assert.equal(isTestOriginEvent(event({ jobId: "task-live" })), true);
  assert.equal(isTestOriginEvent(event({ jobId: "task-other" })), true);
});

test("isTestOriginEvent leaves real production events alone", () => {
  assert.equal(isTestOriginEvent(event()), false);
  assert.equal(isTestOriginEvent(event({ cwd: "D:\\work\\codex-plugin-cc" })), false);
  // 단지 "task-" 로 시작할 뿐인 진짜 job id 는 쓸려 나가면 안 된다.
  assert.equal(isTestOriginEvent(event({ jobId: "task-testing-harness" })), false);
  assert.equal(isTestOriginEvent(event({ jobId: "task-liveness" })), false);
});

test("isTestOriginEvent tolerates missing fields", () => {
  assert.equal(isTestOriginEvent({}), false);
  assert.equal(isTestOriginEvent(null), false);
});

test("summarize excludes test-origin events by default and reports how many it dropped", () => {
  const events = [
    event({ event: "started" }),
    event({ event: "completed" }),
    event({ event: "terminated", jobId: "task-test-sigterm" }),
    event({ event: "terminated", jobId: "task-test-sigterm" }),
    event({ event: "failed", cwd: "C:\\Temp\\codex-plugin-test-QQ" }),
  ];

  const report = summarize(events);
  assert.equal(report.totalEvents, 2, "only the two production rows are counted");
  assert.equal(report.testOriginEvents, 3);
  assert.equal(report.testOriginIncluded, false);
  assert.deepEqual(report.events, { completed: 1, started: 1 });
});

test("summarize can opt back into the raw ledger", () => {
  const events = [event({ event: "started" }), event({ event: "terminated", jobId: "task-test-sigterm" })];
  const report = summarize(events, { includeTestOrigin: true });
  assert.equal(report.totalEvents, 2);
  assert.equal(report.testOriginEvents, 1);
  assert.equal(report.testOriginIncluded, true);
});

test("summarize surfaces telemetry write failures so the totals are not read as complete", () => {
  const events = [event({ event: "started" }), event({ event: "telemetry_write_failed" })];
  const report = summarize(events);
  assert.equal(report.telemetryWriteFailures, 1);
});

test("summarize sums the DROPPED events, not just the number of markers", () => {
  // 마커 하나가 여러 유실 이벤트를 대표할 수 있다. 마커 개수를 세면 7건이 유실된 burst
  // 를 "1" 로 보고하는데, 이는 취지의 정반대다.
  const events = [
    event({ event: "started" }),
    event({ event: "telemetry_write_failed", extras: { droppedEvents: 7 } }),
    event({ event: "telemetry_write_failed", extras: { droppedEvents: 2 } })
  ];
  const report = summarize(events);
  assert.equal(report.telemetryWriteFailures, 2, "two markers");
  assert.equal(report.droppedEvents, 9, "nine lost events");
});

test("summarize tolerates a marker with no droppedEvents field", () => {
  const report = summarize([event({ event: "telemetry_write_failed" })]);
  assert.equal(report.telemetryWriteFailures, 1);
  assert.equal(report.droppedEvents, 0);
});

// writer 는 상한을 넘으면 events.jsonl 을 events.jsonl.1 로 회전시킨다. 현재 파일만
// 읽으면 마지막 회전 이전의 모든 것이 사라진다 — `telemetry_write_failed` 마커까지
// 포함해서. 그 마커가 존재하는 이유가 바로 그 undercount 를 막는 것이다.

function writeLedger(dir, name, events) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  return file;
}

test("readEvents includes the rotated segment, oldest first", () => {
  const dir = makeTempDir("codex-plugin-test-effrot-");
  const current = writeLedger(dir, "events.jsonl", [event({ jobId: "new-1" }), event({ jobId: "new-2" })]);
  writeLedger(dir, "events.jsonl.1", [event({ jobId: "old-1" })]);

  const events = readEvents(current);
  assert.deepEqual(
    events.map((e) => e.jobId),
    ["old-1", "new-1", "new-2"],
    "rotated events come first and are not dropped"
  );
});

test("a telemetry_write_failed marker that rotated out is still counted", () => {
  const dir = makeTempDir("codex-plugin-test-effrot-");
  const current = writeLedger(dir, "events.jsonl", [event({ event: "started" })]);
  writeLedger(dir, "events.jsonl.1", [event({ event: "telemetry_write_failed", extras: { droppedEvents: 12 } })]);

  const report = summarize(readEvents(current));
  assert.equal(report.telemetryWriteFailures, 1, "the marker survived rotation");
  assert.equal(report.droppedEvents, 12);
});

test("readEvents works when there is no rotated file", () => {
  const dir = makeTempDir("codex-plugin-test-effrot-");
  const current = writeLedger(dir, "events.jsonl", [event({ jobId: "only" })]);
  assert.deepEqual(
    readEvents(current).map((e) => e.jobId),
    ["only"]
  );
});

test("readEvents returns [] when neither file exists", () => {
  const dir = makeTempDir("codex-plugin-test-effrot-");
  assert.deepEqual(readEvents(path.join(dir, "events.jsonl")), []);
});
