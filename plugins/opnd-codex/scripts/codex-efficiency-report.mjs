#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// 회전 세그먼트 이름의 단일 SoT — writer 가 소유한다.
import { TELEMETRY_ROTATED_SUFFIX } from "./lib/telemetry.mjs";

// #338 — codex-namespaced var first (see session-lifecycle-hook.mjs), then the
// generic CLAUDE_PLUGIN_DATA (hook context), then the tmpdir fallback.
const pluginData =
  process.env.CODEX_PLUGIN_DATA_DIR ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.tmpdir(), "codex-companion");
const telemetryFile = path.join(pluginData, "telemetry", "events.jsonl");

// telemetry 를 격리하지 않은 테스트 실행은 공유 ledger 에 그대로 append 된다.
// 그 결과 ledger 의 과반이 합성 데이터가 됐고(`task-test-sigterm` 같은 fixture job id
// 가 수십 개의 `terminated` 이벤트를 emit), 아래 모든 수치가 부풀었다. 그 행들을
// 걸러내고, 합계에 조용히 섞는 대신 몇 건을 뺐는지 보고한다.
const TEST_CWD_RE = /codex-plugin-test|[\\/]codex-companion[\\/]/i;
const TEST_JOB_ID_RE = /^(task-test-|task-live$|task-other$)/;

export function isTestOriginEvent(event) {
  if (TEST_CWD_RE.test(String(event?.cwd ?? ""))) {
    return true;
  }
  return TEST_JOB_ID_RE.test(String(event?.jobId ?? ""));
}

function readOneFile(filePath) {
  try {
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// writer 는 `events.jsonl` 이 상한을 넘으면 `events.jsonl.1` 로 회전시킨다.
// 현재 파일만 읽으면 마지막 회전 이전의 모든 것이 조용히 사라진다 — 이 리포트가
// 표면화하려는 `telemetry_write_failed` 마커까지 포함해서. 그 마커를 추가한 목적이
// 바로 그 undercount 를 막는 것이었다.
// 회전본을 먼저 읽어 이벤트가 시간순을 유지하게 한다.
export function readEvents(filePath, rotatedPath = `${filePath}${TELEMETRY_ROTATED_SUFFIX}`) {
  return [...readOneFile(rotatedPath), ...readOneFile(filePath)];
}

export function summarize(allEvents, options = {}) {
  const includeTestOrigin = options.includeTestOrigin === true;
  const testOriginEvents = allEvents.filter(isTestOriginEvent).length;
  const events = includeTestOrigin ? allEvents : allEvents.filter((event) => !isTestOriginEvent(event));

  const byEvent = new Map();
  const byProfile = new Map();
  const failures = new Map();
  let telemetryWriteFailures = 0;
  let droppedEvents = 0;
  for (const event of events) {
    byEvent.set(event.event, (byEvent.get(event.event) ?? 0) + 1);
    const profile = event.extras?.outputProfile ?? "none";
    byProfile.set(profile, (byProfile.get(profile) ?? 0) + 1);
    const failureClass = event.extras?.failureClass ?? event.errorClass ?? null;
    if (failureClass) {
      failures.set(failureClass, (failures.get(failureClass) ?? 0) + 1);
    }
    if (event.event === "telemetry_write_failed") {
      telemetryWriteFailures += 1;
      // 마커 하나가 여러 유실 이벤트를 대표할 수 있다. 개수가 핵심이다.
      droppedEvents += Number(event.extras?.droppedEvents) || 0;
    }
  }
  return {
    telemetryFile,
    totalEvents: events.length,
    testOriginEvents,
    testOriginIncluded: includeTestOrigin,
    telemetryWriteFailures,
    droppedEvents,
    events: Object.fromEntries([...byEvent.entries()].sort()),
    outputProfiles: Object.fromEntries([...byProfile.entries()].sort()),
    failures: Object.fromEntries([...failures.entries()].sort())
  };
}

function main() {
  const json = process.argv.includes("--json");
  const includeTestOrigin = process.argv.includes("--include-test-origin");
  const report = summarize(readEvents(telemetryFile), { includeTestOrigin });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const lines = [
    "# Codex Efficiency Report",
    "",
    `Telemetry: ${report.telemetryFile}`,
    `Events: ${report.totalEvents}${report.testOriginIncluded ? " (test-origin included)" : ""}`
  ];
  if (report.testOriginEvents > 0) {
    lines.push(
      report.testOriginIncluded
        ? `Test-origin events: ${report.testOriginEvents} (counted — pass no flag to exclude)`
        : `Test-origin events excluded: ${report.testOriginEvents} (re-run with --include-test-origin to count them)`
    );
  }
  if (report.telemetryWriteFailures > 0) {
    lines.push(
      `WARNING: ${report.droppedEvents} event(s) were dropped across ${report.telemetryWriteFailures} ` +
        `telemetry write failure(s) — the numbers below undercount by at least that much.`
    );
  }
  lines.push(
    "",
    `By event: ${JSON.stringify(report.events)}`,
    `By output profile: ${JSON.stringify(report.outputProfiles)}`,
    `Failures: ${JSON.stringify(report.failures)}`
  );
  process.stdout.write(lines.join("\n") + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
