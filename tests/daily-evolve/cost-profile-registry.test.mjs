import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COST_PROFILES,
  PROFILE_SCHEMA,
  validateProfile,
  validateRegistry,
  measureCost,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/cost-profile-registry.mjs";

test("COST_PROFILES — 3종 등록 (decision-triage / plan-review / adversarial-review)", () => {
  assert.ok("decision-triage" in COST_PROFILES);
  assert.ok("plan-review" in COST_PROFILES);
  assert.ok("adversarial-review" in COST_PROFILES);
});

test("COST_PROFILES — fixed_unit 환산표 (1/3/5)", () => {
  assert.equal(COST_PROFILES["decision-triage"].fixed_unit, 1);
  assert.equal(COST_PROFILES["plan-review"].fixed_unit, 3);
  assert.equal(COST_PROFILES["adversarial-review"].fixed_unit, 5);
});

test("PROFILE_SCHEMA — 5개 required field (R5-L2)", () => {
  assert.deepEqual(
    [...PROFILE_SCHEMA.required].sort(),
    ["description", "fixed_unit", "input_token_baseline", "name", "output_token_baseline"].sort(),
  );
});

test("validateProfile — 정상 profile 통과", () => {
  const r = validateProfile(COST_PROFILES["decision-triage"]);
  assert.equal(r.ok, true);
});

test("validateProfile — 필수 field 누락 reject", () => {
  const r = validateProfile({ name: "x", fixed_unit: 1, description: "y" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("input_token_baseline")));
  assert.ok(r.errors.some((e) => e.includes("output_token_baseline")));
});

test("validateProfile — fixed_unit < 1 reject", () => {
  const r = validateProfile({
    name: "x",
    fixed_unit: 0,
    description: "y",
    input_token_baseline: 100,
    output_token_baseline: 100,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("fixed_unit")));
});

test("validateRegistry — 전체 registry 통과 (R4-M2)", () => {
  const r = validateRegistry();
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test("measureCost — usage 우선순위 (R4-M2)", () => {
  const r = measureCost({
    profileName: "plan-review",
    usage: { input_tokens: 2000, output_tokens: 500 },
  });
  assert.equal(r.source, "usage");
  // max(1, ceil(2000/2000) + ceil(500/500)) = max(1, 1+1) = 2
  assert.equal(r.units, 2);
});

test("measureCost — 0-token edge case max(1, ...) (R5-L1)", () => {
  const r = measureCost({
    profileName: "decision-triage",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(r.units, 1, "R5-L1: 0-token 호출도 min 1 unit 보장");
});

test("measureCost — usage 부재 시 profile fallback", () => {
  const r = measureCost({ profileName: "adversarial-review" });
  assert.equal(r.source, "profile");
  assert.equal(r.units, 5);
});

test("measureCost — usage 의 input/output 부재 (object 만 있음) 시 profile fallback + warning", () => {
  const r = measureCost({
    profileName: "decision-triage",
    usage: { some_other_field: 42 },
  });
  assert.equal(r.source, "profile");
  assert.equal(r.units, 1);
  assert.ok(r.warnings.length > 0);
});

test("measureCost — profile 미등록 시 conservative 1 unit + warning", () => {
  const r = measureCost({ profileName: "unknown-profile" });
  assert.equal(r.source, "conservative");
  assert.equal(r.units, 1);
  assert.ok(r.warnings.length > 0);
  assert.match(r.warnings[0], /미등록/);
});
