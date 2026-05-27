/**
 * self-evolve-policy.test.mjs — lib/self-evolve-policy.mjs unit test (Phase 6)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isActionable,
  fpRate,
  buildAttributionWindow,
  shouldRollback,
  checkLoopGuard,
  shouldFireWeekly,
  buildReviewEntry,
  REVIEW_TYPE,
  DECISION,
  CHANGE_TARGETS,
  MAX_SELF_REVIEW_DEPTH,
  BASELINE_WINDOW_DAYS,
  POST_WINDOW_DAYS,
  ROLLBACK_FP_MULTIPLIER,
  MIN_ACTIONABLE_FOR_ATTRIBUTION,
  WEEKLY_TRIGGER_DAYS,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/self-evolve-policy.mjs";

test("isActionable — needs_claude_judgment 제외", () => {
  assert.equal(isActionable({ triage: "needs_claude_judgment" }), false);
});

test("isActionable — autonomous_safe true", () => {
  assert.equal(isActionable({ triage: "autonomous_safe" }), true);
});

test("isActionable — needs_user + l5.user_surface_value high/medium → true, low/none → false", () => {
  assert.equal(isActionable({ triage: "needs_user", l5: { user_surface_value: "high" } }), true);
  assert.equal(isActionable({ triage: "needs_user", l5: { user_surface_value: "medium" } }), true);
  assert.equal(isActionable({ triage: "needs_user", l5: { user_surface_value: "low" } }), false);
  assert.equal(isActionable({ triage: "needs_user", l5: { user_surface_value: "none" } }), false);
});

test("isActionable — null / 부재 안전", () => {
  assert.equal(isActionable(null), false);
  assert.equal(isActionable({}), false);
});

test("fpRate — rejected / total actionable", () => {
  const records = [
    { triage: "autonomous_safe", user_decision: "rejected" },
    { triage: "autonomous_safe", user_decision: "accepted" },
    { triage: "autonomous_safe" }, // no decision
    { triage: "needs_claude_judgment", user_decision: "rejected" }, // excluded
  ];
  // actionable=3, rejected=1 → 1/3
  assert.ok(Math.abs(fpRate(records) - 1 / 3) < 0.001);
});

test("fpRate — 빈 배열 0", () => {
  assert.equal(fpRate([]), 0);
  assert.equal(fpRate(null), 0);
});

test("buildAttributionWindow — effective_at NULL or decision != accepted → eligible false", () => {
  const now = "2026-05-27T00:00:00Z";
  assert.equal(buildAttributionWindow({ effective_at: null, decision: "accepted" }, now).eligible, false);
  assert.equal(buildAttributionWindow({ effective_at: "2026-05-20T00:00:00Z", decision: "pending" }, now).eligible, false);
  assert.equal(buildAttributionWindow({ effective_at: "2026-05-20T00:00:00Z", decision: "rejected" }, now).eligible, false);
});

test("buildAttributionWindow — post_window 부족 (7d 미경과)", () => {
  const now = "2026-05-27T00:00:00Z";
  // 5d 전 merge — post_window 부족
  const r = buildAttributionWindow({ effective_at: "2026-05-22T00:00:00Z", decision: "accepted" }, now);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /post_window 부족/);
});

test("buildAttributionWindow — 7d 경과 + accepted → eligible + windows 정확", () => {
  const now = "2026-05-27T00:00:00Z";
  // 10d 전 merge — eligible
  const r = buildAttributionWindow({ effective_at: "2026-05-17T00:00:00Z", decision: "accepted" }, now);
  assert.equal(r.eligible, true);
  // baseline = effective_at - 14d ~ effective_at
  assert.equal(r.baseline_window[0], "2026-05-03T00:00:00.000Z");
  assert.equal(r.baseline_window[1], "2026-05-17T00:00:00.000Z");
  // post = effective_at ~ effective_at + 7d
  assert.equal(r.post_window[0], "2026-05-17T00:00:00.000Z");
  assert.equal(r.post_window[1], "2026-05-24T00:00:00.000Z");
});

test("shouldRollback — actionable 부족 → 보류", () => {
  const result = shouldRollback({
    baseline_fp: 0.1,
    post_fp: 0.5,
    baseline_actionable: 5,
    post_actionable: 15,
  });
  assert.equal(result.rollback, false);
  assert.match(result.reason, /actionable count 부족/);
});

test("shouldRollback — post_fp ≥ baseline × 1.5 → rollback", () => {
  const result = shouldRollback({
    baseline_fp: 0.2,
    post_fp: 0.31, // 0.2 × 1.5 = 0.3
    baseline_actionable: 20,
    post_actionable: 15,
  });
  assert.equal(result.rollback, true);
});

test("shouldRollback — boundary 약간 초과 (float precision 회피)", () => {
  // IEEE 754 float 손실로 정확 동등 비교 어려움. 약간 초과 값으로 trigger 검증.
  const result = shouldRollback({
    baseline_fp: 0.2,
    post_fp: 0.301, // 0.2 × 1.5 = 0.30000004 — 0.301 은 명확히 초과
    baseline_actionable: 20,
    post_actionable: 15,
  });
  assert.equal(result.rollback, true);
});

test("shouldRollback — post_fp < threshold → 통과", () => {
  const result = shouldRollback({
    baseline_fp: 0.2,
    post_fp: 0.25,
    baseline_actionable: 20,
    post_actionable: 15,
  });
  assert.equal(result.rollback, false);
});

test("checkLoopGuard — depth ≤ 1 allowed", () => {
  assert.equal(checkLoopGuard({ self_review_depth: 0 }).allowed, true);
  assert.equal(checkLoopGuard({ self_review_depth: 1 }).allowed, true);
});

test("checkLoopGuard — depth > MAX 차단", () => {
  const r = checkLoopGuard({ self_review_depth: 2 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /self_review_depth=2/);
});

test("checkLoopGuard — recursive meta-review STOP", () => {
  const r = checkLoopGuard({
    self_review_depth: 1,
    proposed_changes: [{ target: CHANGE_TARGETS.SELF_EVOLVE_FREQUENCY }],
  });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /recursive meta-review/);
});

test("shouldFireWeekly — log 비어 있으면 fire", () => {
  assert.equal(shouldFireWeekly({ entries: [] }, "2026-05-27T00:00:00Z").fire, true);
  assert.equal(shouldFireWeekly(null, "2026-05-27T00:00:00Z").fire, true);
});

test("shouldFireWeekly — 마지막 review ≥ 7d → fire", () => {
  const log = {
    entries: [{
      review_type: REVIEW_TYPE.WEEKLY_NORMAL,
      started_at: "2026-05-20T00:00:00Z", // 7d 전
    }],
  };
  const r = shouldFireWeekly(log, "2026-05-27T00:00:00Z");
  assert.equal(r.fire, true);
});

test("shouldFireWeekly — 마지막 review < 7d → wait", () => {
  const log = {
    entries: [{
      review_type: REVIEW_TYPE.WEEKLY_NORMAL,
      started_at: "2026-05-25T00:00:00Z", // 2d 전
    }],
  };
  const r = shouldFireWeekly(log, "2026-05-27T00:00:00Z");
  assert.equal(r.fire, false);
});

test("buildReviewEntry — schema 일치", () => {
  const e = buildReviewEntry({
    review_type: REVIEW_TYPE.MONTHLY_SELF_CHANGE,
    started_at: "2026-05-27T00:00:00Z",
  });
  assert.equal(e.review_type, REVIEW_TYPE.MONTHLY_SELF_CHANGE);
  assert.equal(e.decision, DECISION.PENDING);
  assert.equal(e.self_review_depth, 0);
  assert.equal(e.ended_at, null);
  assert.equal(e.effective_at, null);
  assert.ok(e.review_id);
});

test("constants — 14d/7d/1.5×/10 actionable/MAX_DEPTH=1", () => {
  assert.equal(BASELINE_WINDOW_DAYS, 14);
  assert.equal(POST_WINDOW_DAYS, 7);
  assert.equal(ROLLBACK_FP_MULTIPLIER, 1.5);
  assert.equal(MIN_ACTIONABLE_FOR_ATTRIBUTION, 10);
  assert.equal(MAX_SELF_REVIEW_DEPTH, 1);
  assert.equal(WEEKLY_TRIGGER_DAYS, 7);
});
