/**
 * self-evolve.test.mjs — Phase 6 orchestrator unit test
 *
 * skipPersistence=true 로 state IO 격리.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selfEvolve,
  isoWeekLabel,
  buildWeeklyReport,
} from "../../plugins/opnd-codex/scripts/daily-evolve/self-evolve.mjs";
import { REVIEW_TYPE, DECISION } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/self-evolve-policy.mjs";

test("selfEvolve — fresh state + force=true → fired with entry/report", () => {
  const result = selfEvolve({
    reviewType: REVIEW_TYPE.WEEKLY_NORMAL,
    force: true,
    skipPersistence: true,
    nowIso: "2026-05-27T00:00:00Z",
  });
  assert.equal(result.fired, true);
  assert.ok(result.entry);
  assert.equal(result.entry.review_type, REVIEW_TYPE.WEEKLY_NORMAL);
  assert.equal(result.entry.decision, DECISION.PENDING);
  assert.equal(result.entry.self_review_depth, 0);
  assert.ok(typeof result.report === "string" && result.report.length > 0);
  assert.match(result.report, /Self-Evolve Weekly Report/);
});

test("selfEvolve — force=false + fresh state → fired (no prior review)", () => {
  const result = selfEvolve({
    skipPersistence: true,
    nowIso: "2026-05-27T00:00:00Z",
  });
  assert.equal(result.fired, true);
});

test("selfEvolve — review_type=monthly_self_change 정확 반영", () => {
  const result = selfEvolve({
    reviewType: REVIEW_TYPE.MONTHLY_SELF_CHANGE,
    force: true,
    skipPersistence: true,
    nowIso: "2026-05-27T00:00:00Z",
  });
  assert.equal(result.entry.review_type, REVIEW_TYPE.MONTHLY_SELF_CHANGE);
});

test("isoWeekLabel — Thursday-based ISO week", () => {
  // 2026-05-27 은 ISO week 22
  assert.equal(isoWeekLabel("2026-05-27T00:00:00Z"), "2026-W22");
  // 2026-01-01 은 W01
  assert.equal(isoWeekLabel("2026-01-01T00:00:00Z"), "2026-W01");
  // 2026-12-31 (목요일 가까운 경우)
  assert.ok(isoWeekLabel("2026-12-31T00:00:00Z").startsWith("2026-W"));
  // invalid → "?"
  assert.equal(isoWeekLabel("not-a-date"), "?");
});

test("buildWeeklyReport — 기본 sections 출력", () => {
  const entry = {
    review_id: "rev-1234",
    review_type: REVIEW_TYPE.WEEKLY_NORMAL,
    started_at: "2026-05-27T00:00:00Z",
    self_review_depth: 0,
    proposed_changes: [],
    decision: DECISION.PENDING,
  };
  const md = buildWeeklyReport({ entry, telemetry: [] });
  assert.match(md, /Self-Evolve Weekly Report/);
  assert.match(md, /review_id: `rev-1234`/);
  assert.match(md, /review_type: weekly_normal/);
  assert.match(md, /## Routine Telemetry/);
  assert.match(md, /no runs in last 2 years/);
  assert.match(md, /no proposals/);
  assert.match(md, /decision: `pending`/);
  assert.match(md, /## Loop Guard/);
});

test("buildWeeklyReport — telemetry 있으면 통계 출력", () => {
  const entry = {
    review_id: "rev-2",
    review_type: REVIEW_TYPE.WEEKLY_NORMAL,
    started_at: "2026-05-27T00:00:00Z",
    self_review_depth: 0,
    proposed_changes: [
      { target: "fp_threshold", old_value: "0.3", new_value: "0.25", evidence: "weekly fp_rate 0.15" },
    ],
    decision: DECISION.PENDING,
  };
  const telemetry = [
    { status: "success", duration_ms: 1000, cost_units_consumed: 5 },
    { status: "failure", duration_ms: 2000, cost_units_consumed: 3 },
    { status: "partial", duration_ms: 1500, cost_units_consumed: 4 },
  ];
  const md = buildWeeklyReport({ entry, telemetry });
  assert.match(md, /total runs: 3/);
  assert.match(md, /success \/ partial \/ failure: 1 \/ 1 \/ 1/);
  assert.match(md, /duration_ms median/);
  assert.match(md, /cost_units 누적: 12/);
  assert.match(md, /target: `fp_threshold`/);
  assert.match(md, /`0\.3` → `0\.25`/); // old_value → new_value 실제 format
  assert.match(md, /evidence: weekly fp_rate 0\.15/);
});

test("selfEvolve — empty proposed_changes (Phase 6 PoC stub) 명시", () => {
  const result = selfEvolve({
    force: true,
    skipPersistence: true,
    nowIso: "2026-05-27T00:00:00Z",
  });
  assert.deepEqual(result.entry.proposed_changes, []);
});

test("selfEvolve — guard allowed true (depth=0)", () => {
  const result = selfEvolve({
    force: true,
    skipPersistence: true,
    nowIso: "2026-05-27T00:00:00Z",
  });
  assert.ok(result.guard);
  assert.equal(result.guard.allowed, true);
});
