/**
 * env-probe.test.mjs — lib/env-probe.mjs unit test (Phase 5.0)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideSchedulerStatus,
  kstNineToLocalCron,
  validateProbe,
  buildProbeResult,
  hasDstRisk,
  SCHEDULER_STATUS,
  SCHEDULER_STATUS_LIST,
  KST_OFFSET_MINUTES,
  ENV_PROBE_SCHEMA_VERSION,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/env-probe.mjs";

test("decideSchedulerStatus — MCP 미설치 → MCP_UNAVAILABLE", () => {
  assert.equal(
    decideSchedulerStatus({ mcp_installed: false, mcp_cron_api_docs_found: false, cron_tz_supported: null }),
    SCHEDULER_STATUS.MCP_UNAVAILABLE,
  );
});

test("decideSchedulerStatus — CRON_TZ 지원 → UTC_AWARE", () => {
  assert.equal(
    decideSchedulerStatus({ mcp_installed: true, mcp_cron_api_docs_found: true, cron_tz_supported: true }),
    SCHEDULER_STATUS.UTC_AWARE,
  );
});

test("decideSchedulerStatus — local TZ only → LOCAL_TZ_ONLY", () => {
  assert.equal(
    decideSchedulerStatus({ mcp_installed: true, mcp_cron_api_docs_found: true, cron_tz_supported: false }),
    SCHEDULER_STATUS.LOCAL_TZ_ONLY,
  );
});

test("decideSchedulerStatus — 불명확 → UNKNOWN", () => {
  assert.equal(
    decideSchedulerStatus({ mcp_installed: true, mcp_cron_api_docs_found: false, cron_tz_supported: null }),
    SCHEDULER_STATUS.UNKNOWN,
  );
  assert.equal(
    decideSchedulerStatus({ mcp_installed: true, mcp_cron_api_docs_found: true, cron_tz_supported: null }),
    SCHEDULER_STATUS.UNKNOWN,
  );
});

test("kstNineToLocalCron — Asia/Seoul (+540 min) → '0 9 * * *'", () => {
  const result = kstNineToLocalCron(KST_OFFSET_MINUTES);
  assert.equal(result.hour, 9);
  assert.equal(result.minute, 0);
  assert.equal(result.cron, "0 9 * * *");
});

test("kstNineToLocalCron — UTC (0) → '0 0 * * *'", () => {
  const result = kstNineToLocalCron(0);
  assert.equal(result.hour, 0);
  assert.equal(result.minute, 0);
  assert.equal(result.cron, "0 0 * * *");
});

test("kstNineToLocalCron — America/Los_Angeles (-480) → '0 16 * * *' (전날 KST 09:00)", () => {
  const result = kstNineToLocalCron(-480);
  // (0 - 480 + 1440) mod 1440 = 960 min = 16:00
  assert.equal(result.hour, 16);
  assert.equal(result.minute, 0);
  assert.equal(result.cron, "0 16 * * *");
});

test("kstNineToLocalCron — 30분 offset (India +330) → '30 5 * * *'", () => {
  const result = kstNineToLocalCron(330);
  assert.equal(result.hour, 5);
  assert.equal(result.minute, 30);
});

test("kstNineToLocalCron — invalid offset → default UTC", () => {
  const result = kstNineToLocalCron(NaN);
  assert.equal(result.cron, "0 0 * * *");
});

test("validateProbe — 정상 schema 통과", () => {
  const probe = buildProbeResult({
    mcp_installed: true,
    mcp_cron_api_docs_found: true,
    cron_tz_supported: true,
    user_machine_tz: "Asia/Seoul",
    machine_offset_minutes: 540,
  });
  const result = validateProbe(probe);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateProbe — invalid schema_version / enum / tz", () => {
  assert.equal(validateProbe(null).ok, false);
  assert.equal(validateProbe({}).ok, false);
  assert.equal(
    validateProbe({ schema_version: 99, scheduler_status: "UTC_AWARE", user_machine_tz: "x", machine_offset_minutes: 0 }).ok,
    false,
  );
  assert.equal(
    validateProbe({ schema_version: 1, scheduler_status: "BAD", user_machine_tz: "x", machine_offset_minutes: 0 }).ok,
    false,
  );
});

test("buildProbeResult — fallback_required 자동 (MCP_UNAVAILABLE / UNKNOWN)", () => {
  const p1 = buildProbeResult({
    mcp_installed: false,
    user_machine_tz: "UTC",
    machine_offset_minutes: 0,
  });
  assert.equal(p1.scheduler_status, SCHEDULER_STATUS.MCP_UNAVAILABLE);
  assert.equal(p1.probe_details.fallback_required, true);

  const p2 = buildProbeResult({
    mcp_installed: true,
    mcp_cron_api_docs_found: false,
    cron_tz_supported: null,
    user_machine_tz: "Asia/Seoul",
    machine_offset_minutes: 540,
  });
  assert.equal(p2.scheduler_status, SCHEDULER_STATUS.UNKNOWN);
  assert.equal(p2.probe_details.fallback_required, true);
});

test("buildProbeResult — UTC_AWARE 시 fallback_required=false", () => {
  const p = buildProbeResult({
    mcp_installed: true,
    mcp_cron_api_docs_found: true,
    cron_tz_supported: true,
    user_machine_tz: "Asia/Seoul",
    machine_offset_minutes: 540,
  });
  assert.equal(p.probe_details.fallback_required, false);
});

test("hasDstRisk — America/Europe DST true / Asia/Seoul DST false", () => {
  assert.equal(hasDstRisk("America/New_York"), true);
  assert.equal(hasDstRisk("America/Los_Angeles"), true);
  assert.equal(hasDstRisk("Europe/Berlin"), true);
  assert.equal(hasDstRisk("Pacific/Auckland"), true);
  // No DST
  assert.equal(hasDstRisk("Asia/Seoul"), false);
  assert.equal(hasDstRisk("Asia/Tokyo"), false);
  assert.equal(hasDstRisk("UTC"), false);
  assert.equal(hasDstRisk("Australia/Brisbane"), false);
  assert.equal(hasDstRisk(null), false);
});

test("SCHEDULER_STATUS_LIST — 4 enum 일치", () => {
  assert.deepEqual([...SCHEDULER_STATUS_LIST], [
    "UTC_AWARE",
    "LOCAL_TZ_ONLY",
    "MCP_UNAVAILABLE",
    "UNKNOWN",
  ]);
});

test("KST_OFFSET_MINUTES === 540", () => {
  assert.equal(KST_OFFSET_MINUTES, 540);
});

test("ENV_PROBE_SCHEMA_VERSION === 1", () => {
  assert.equal(ENV_PROBE_SCHEMA_VERSION, 1);
});
