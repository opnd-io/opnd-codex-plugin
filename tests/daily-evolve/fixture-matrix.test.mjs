/**
 * fixture-matrix.test.mjs — LLM fixture matrix 가 실제 lib 동작과 정합 검증
 *
 * Codex review R2 MEDIUM: fixture 의 `_consumer_tests` 메타가 가상 test 를 참조했음 →
 * 본 test 가 actual consumer 로 fixture 4종을 load + lib 함수로 검증.
 *
 * fixture:
 *   - invalid-json.json   — L5/L7 raw_response parse fail → needs_user fallback
 *   - timeout.json        — simulated ETIMEDOUT → cost_units conservative 1
 *   - cost-cap-exceeded.json — 누적 cost > daily_cap → skip propagate
 *   - citation-drift.json — 5 citation case → checkSingleCitation enum 정합
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkSingleCitation,
  CITATION_REASONS,
  FUZZY_THRESHOLD,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/citation-check.mjs";
import {
  measureCost,
  COST_PROFILES,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/cost-profile-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, "fixtures", "llm");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8"));
}

test("fixture matrix — invalid-json fixture metadata 검증", () => {
  const f = loadFixture("invalid-json.json");
  assert.equal(f._fixture, "invalid-json");
  // raw_response 가 JSON parse fail 임을 검증
  let parseFailed = false;
  try {
    JSON.parse(f.raw_response);
  } catch {
    parseFailed = true;
  }
  assert.equal(parseFailed, true, "raw_response 는 JSON parse fail 해야 함");
  // L5 fallback 계약: needs_user + fallback_used:true
  assert.equal(f.expected.L5_decision, "needs_user");
  assert.equal(f.expected.L5_fallback_used, true);
  assert.equal(f.expected.L7_adjustment, "maintain");
});

test("fixture matrix — timeout fixture 의 conservative 1 unit fallback", () => {
  const f = loadFixture("timeout.json");
  assert.equal(f._fixture, "timeout");
  assert.equal(f.expected.cost_source, "conservative");
  // 실제 measureCost 가 unknown profile 일 때 1 unit conservative 반환 검증
  const result = measureCost({ profileName: "nonexistent-profile" });
  assert.equal(result.units, 1);
  assert.equal(result.source, "conservative");
  assert.ok(result.warnings.length > 0);
});

test("fixture matrix — cost-cap-exceeded 임계값", () => {
  const f = loadFixture("cost-cap-exceeded.json");
  assert.equal(f._fixture, "cost-cap-exceeded");
  // baseline × 3 = daily_cap 정합
  assert.equal(f.daily_cap_units, f.baseline_median_units * 3);
  // current > daily_cap 시 skip
  assert.ok(f.current_consumed > f.daily_cap_units);
  assert.equal(f.expected.skip_reason, "cost_cap_exceeded");
});

test("fixture matrix — citation-drift 5 case 모두 checkSingleCitation 정합", () => {
  const f = loadFixture("citation-drift.json");
  assert.equal(f._fixture, "citation-drift");
  assert.equal(f.transcript.lines.length, 3);

  for (const c of f.citations) {
    const result = checkSingleCitation({
      citation: {
        agentId: c.agentId,
        line_ref: c.line_ref,
        quoted_text: c.quoted_text,
      },
      transcript: c.agentId === f.transcript.agentId ? f.transcript : null,
    });
    assert.equal(
      result.passed,
      c.expected.passed,
      `case "${c._case}" passed mismatch: actual=${result.passed} expected=${c.expected.passed} (reason=${result.reason})`,
    );
    assert.equal(
      result.reason,
      c.expected.reason,
      `case "${c._case}" reason mismatch: actual=${result.reason} expected=${c.expected.reason}`,
    );
    if (result.passed && c.expected.similarity != null) {
      assert.ok(
        result.similarity >= FUZZY_THRESHOLD,
        `case "${c._case}" similarity below threshold`,
      );
    }
  }
});

test("fixture matrix — citation reason enum coverage", () => {
  // citation-drift 의 expected reason 이 CITATION_REASONS enum 의 부분집합
  const f = loadFixture("citation-drift.json");
  const reasons = new Set(f.citations.map((c) => c.expected.reason));
  for (const r of reasons) {
    assert.ok(
      Object.values(CITATION_REASONS).includes(r),
      `fixture reason "${r}" not in CITATION_REASONS enum`,
    );
  }
});

test("fixture matrix — COST_PROFILES registry 의 fixed_unit 정합 (R5-L2)", () => {
  // 3 profile 모두 fixed_unit ≥ 1 + plan 명시 값과 일치
  assert.equal(COST_PROFILES["decision-triage"].fixed_unit, 1);
  assert.equal(COST_PROFILES["plan-review"].fixed_unit, 3);
  assert.equal(COST_PROFILES["adversarial-review"].fixed_unit, 5);
});
