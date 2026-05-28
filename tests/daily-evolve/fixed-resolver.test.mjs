import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REJECT_PATTERNS,
  findRejectMatch,
  resolveFixed,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/fixed-resolver.mjs";

test("REJECT_PATTERNS — planned/documented/known issue/will fix 매칭 (R2-M7)", () => {
  assert.ok(REJECT_PATTERNS.length >= 4);
});

test("findRejectMatch — 'planned' 매칭", () => {
  assert.match(findRejectMatch("This is planned for v3."), /planned/);
});

test("findRejectMatch — 'known issue' 매칭 (case-insensitive)", () => {
  assert.match(findRejectMatch("Known Issue — workaround exists"), /known/i);
});

test("findRejectMatch — no match 시 null", () => {
  assert.equal(findRejectMatch("Fixed by PR #340 — broker race resolved"), null);
});

test("findRejectMatch — non-string input null", () => {
  assert.equal(findRejectMatch(null), null);
  assert.equal(findRejectMatch(42), null);
});

test("resolveFixed — FIXED: changelog + touchedPath evidence (R3-M2)", () => {
  const r = resolveFixed({
    changelogMatch: "Fixed in PR #340 — broker race",
    evidence: { touchedPath: true, testAssertion: false, linkedPRMerge: false },
  });
  assert.equal(r.verdict, "FIXED");
  assert.equal(r.evidence.touchedPath, true);
});

test("resolveFixed — FIXED: changelog + testAssertion evidence", () => {
  const r = resolveFixed({
    changelogMatch: "Closed by PR #341",
    evidence: { touchedPath: false, testAssertion: true, linkedPRMerge: false },
  });
  assert.equal(r.verdict, "FIXED");
});

test("resolveFixed — FIXED: changelog + linkedPRMerge evidence", () => {
  const r = resolveFixed({
    changelogMatch: "Resolved in PR #345",
    evidence: { touchedPath: false, testAssertion: false, linkedPRMerge: true },
  });
  assert.equal(r.verdict, "FIXED");
});

test("resolveFixed — PARTIAL: changelog 있으나 0 evidence (commit message 단독 reject)", () => {
  // R3-M2: commit message 만으로는 FIXED 안 됨. evidence 모두 false → PARTIAL
  const r = resolveFixed({
    changelogMatch: "PR #340 commit message reference only",
    evidence: { touchedPath: false, testAssertion: false, linkedPRMerge: false },
  });
  assert.equal(r.verdict, "PARTIAL");
  assert.match(r.reason, /no additional evidence/);
});

test("resolveFixed — PARTIAL: reject pattern 'planned' 매칭 시 강등", () => {
  const r = resolveFixed({
    changelogMatch: "This change is planned for next release",
    evidence: { touchedPath: true, testAssertion: true, linkedPRMerge: true }, // evidence 모두 있어도 reject
  });
  assert.equal(r.verdict, "PARTIAL");
  assert.equal(r.reason, "reject pattern matched");
  assert.match(r.rejectPattern, /planned/);
});

test("resolveFixed — PARTIAL: 'known issue' reject", () => {
  const r = resolveFixed({
    changelogMatch: "Known issue — workaround",
    evidence: { touchedPath: true },
  });
  assert.equal(r.verdict, "PARTIAL");
  assert.match(r.rejectPattern, /known/);
});

test("resolveFixed — caller precondition violation: empty changelogMatch", () => {
  const r = resolveFixed({ changelogMatch: "", evidence: { touchedPath: true } });
  assert.equal(r.verdict, "PARTIAL");
  assert.match(r.reason, /changelog evidence absent/);
});
