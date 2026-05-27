/**
 * codex-triage.test.mjs — Phase 1 codex-triage.mjs orchestrator unit test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  triage,
  heuristicTriage,
  TRIAGE_DECISIONS,
  FAN_OUT_THRESHOLD,
} from "../../plugins/opnd-codex/scripts/daily-evolve/codex-triage.mjs";
import { VERDICTS } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/verdict-schema.mjs";
import { SKIP_REASONS } from "../../plugins/opnd-codex/scripts/daily-evolve/lib/cost-cap.mjs";

test("heuristicTriage — verdict 별 3분류", () => {
  assert.equal(
    heuristicTriage({ verdict: VERDICTS.FIXED }),
    TRIAGE_DECISIONS.AUTONOMOUS_SAFE,
  );
  assert.equal(
    heuristicTriage({ verdict: VERDICTS.WONTFIX }),
    TRIAGE_DECISIONS.AUTONOMOUS_SAFE,
  );
  assert.equal(
    heuristicTriage({ verdict: VERDICTS.QUESTION }),
    TRIAGE_DECISIONS.NEEDS_CLAUDE_JUDGMENT,
  );
  assert.equal(
    heuristicTriage({ verdict: VERDICTS.PARTIAL }),
    TRIAGE_DECISIONS.NEEDS_USER,
  );
  assert.equal(
    heuristicTriage({ verdict: VERDICTS.NOT_FIXED }),
    TRIAGE_DECISIONS.NEEDS_USER,
  );
  assert.equal(
    heuristicTriage({ verdict: "unknown" }),
    TRIAGE_DECISIONS.NEEDS_USER,
  );
});

test("triage — N < FAN_OUT_THRESHOLD 시 skip (scope_excluded)", () => {
  const analyzed = {
    records: [
      { verdict: VERDICTS.NOT_FIXED, issue_ref: "#1" },
      { verdict: VERDICTS.PARTIAL, issue_ref: "#2" },
    ],
  };
  const result = triage(analyzed, { skipPersistence: true });
  assert.equal(result.triage_summary.skipped, true);
  assert.equal(result.triage_summary.skip_reason, SKIP_REASONS.SCOPE_EXCLUDED);
  assert.equal(result.triage_summary.fan_out, 2);
  assert.equal(result.triage_summary.codex_called, false);
  // 모두 needs_user fallback
  for (const r of result.records) {
    assert.equal(r.triage, TRIAGE_DECISIONS.NEEDS_USER);
  }
});

test("triage — N ≥ FAN_OUT_THRESHOLD 시 heuristic 적용", () => {
  const analyzed = {
    records: [
      { verdict: VERDICTS.NOT_FIXED, issue_ref: "#1" },
      { verdict: VERDICTS.FIXED, issue_ref: "#2" },
      { verdict: VERDICTS.QUESTION, issue_ref: "#3" },
    ],
  };
  const result = triage(analyzed, { skipPersistence: true });
  assert.equal(result.triage_summary.skipped, false);
  assert.equal(result.triage_summary.fan_out, 3);
  assert.equal(result.records[0].triage, TRIAGE_DECISIONS.NEEDS_USER);
  assert.equal(result.records[1].triage, TRIAGE_DECISIONS.AUTONOMOUS_SAFE);
  assert.equal(result.records[2].triage, TRIAGE_DECISIONS.NEEDS_CLAUDE_JUDGMENT);
});

test("triage — fan_out 정확히 FAN_OUT_THRESHOLD (boundary)", () => {
  // 3 = threshold, 통과
  const result = triage(
    {
      records: Array.from({ length: FAN_OUT_THRESHOLD }, (_, i) => ({
        verdict: VERDICTS.NOT_FIXED,
        issue_ref: `#${i + 1}`,
      })),
    },
    { skipPersistence: true },
  );
  assert.equal(result.triage_summary.skipped, false);
});

test("triage — 빈 records → fan_out 0 + skip", () => {
  const result = triage({ records: [] }, { skipPersistence: true });
  assert.equal(result.triage_summary.fan_out, 0);
  assert.equal(result.triage_summary.skipped, true);
  assert.equal(result.records.length, 0);
});

test("triage — non-array records 안전 처리", () => {
  const result = triage({ records: "not array" }, { skipPersistence: true });
  assert.equal(result.triage_summary.fan_out, 0);
  assert.equal(result.triage_summary.skipped, true);
});

test("triage_summary schema — 모든 필드 존재", () => {
  const result = triage({ records: [] }, { skipPersistence: true });
  const s = result.triage_summary;
  assert.ok("fan_out" in s);
  assert.ok("skipped" in s);
  assert.ok("skip_reason" in s);
  assert.ok("codex_called" in s);
  assert.ok("cost_units" in s);
  assert.ok("cost_source" in s);
  assert.ok("cap" in s);
  assert.ok("baseline_median" in s);
});
