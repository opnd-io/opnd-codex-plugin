import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidAgentId,
  similarity,
  checkSingleCitation,
  checkCitations,
  CITATION_REASONS,
  FUZZY_THRESHOLD,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/citation-check.mjs";

test("FUZZY_THRESHOLD = 0.8 (R3-M3)", () => {
  assert.equal(FUZZY_THRESHOLD, 0.8);
});

test("isValidAgentId — Codex agentId 형식 (8-32 alphanumeric)", () => {
  assert.equal(isValidAgentId("ab98b16aa54ed2503"), true);
  assert.equal(isValidAgentId("a5dc525ef112b5781"), true);
  assert.equal(isValidAgentId("ab"), false); // too short
  assert.equal(isValidAgentId("a".repeat(33)), false); // too long
  assert.equal(isValidAgentId("has-dash"), false);
  assert.equal(isValidAgentId(""), false);
  assert.equal(isValidAgentId(null), false);
});

test("similarity — identical strings = 1", () => {
  assert.equal(similarity("hello", "hello"), 1);
});

test("similarity — completely different = low", () => {
  const s = similarity("abc", "xyz");
  assert.ok(s < 0.5);
});

test("similarity — empty strings", () => {
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abc", ""), 0);
});

test("similarity — near-match ~0.9", () => {
  const s = similarity("hello world", "hello world!");
  assert.ok(s >= 0.9);
});

test("checkSingleCitation — exact match (UTF-8 100% R3-M3)", () => {
  const r = checkSingleCitation({
    citation: { agentId: "abc12345xyz", line_ref: 1, quoted_text: "Hello world" },
    transcript: { agentId: "abc12345xyz", lines: ["Hello world", "second"] },
  });
  assert.equal(r.passed, true);
  assert.equal(r.reason, CITATION_REASONS.EXACT_MATCH);
  assert.equal(r.similarity, 1);
});

test("checkSingleCitation — fuzzy match (≥ 0.8 — line drift 대응)", () => {
  const r = checkSingleCitation({
    citation: { agentId: "abc12345xyz", line_ref: 1, quoted_text: "Hello world!" },
    transcript: { agentId: "abc12345xyz", lines: ["Hello world"] },
  });
  assert.equal(r.passed, true);
  assert.equal(r.reason, CITATION_REASONS.FUZZY_MATCH);
  assert.ok(r.similarity >= FUZZY_THRESHOLD);
});

test("checkSingleCitation — fuzzy fail (< 0.8)", () => {
  const r = checkSingleCitation({
    citation: { agentId: "abc12345xyz", line_ref: 1, quoted_text: "Totally unrelated text here" },
    transcript: { agentId: "abc12345xyz", lines: ["Hello world"] },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, CITATION_REASONS.FUZZY_FAIL);
});

test("checkSingleCitation — invalid agentId reject", () => {
  const r = checkSingleCitation({
    citation: { agentId: "x", line_ref: 1, quoted_text: "y" },
    transcript: null,
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, CITATION_REASONS.AGENT_ID_INVALID);
});

test("checkSingleCitation — transcript agentId mismatch reject", () => {
  const r = checkSingleCitation({
    citation: { agentId: "abc12345xyz", line_ref: 1, quoted_text: "y" },
    transcript: { agentId: "differentid", lines: ["y"] },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, CITATION_REASONS.AGENT_ID_NOT_FOUND);
});

test("checkSingleCitation — line_ref out of range reject", () => {
  const r = checkSingleCitation({
    citation: { agentId: "abc12345xyz", line_ref: 99, quoted_text: "y" },
    transcript: { agentId: "abc12345xyz", lines: ["y"] },
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, CITATION_REASONS.LINE_REF_OUT_OF_RANGE);
});

test("checkCitations — multiple citations all-or-nothing report", () => {
  const r = checkCitations({
    citations: [
      { agentId: "abc12345xyz", line_ref: 1, quoted_text: "ok" },
      { agentId: "missingid007", line_ref: 1, quoted_text: "no transcript" },
    ],
    transcripts: {
      abc12345xyz: { agentId: "abc12345xyz", lines: ["ok"] },
    },
  });
  assert.equal(r.passed, false);
  assert.equal(r.results.length, 2);
  assert.equal(r.failures.length, 1);
});

test("checkCitations — 빈 citation array → passed (no-op)", () => {
  const r = checkCitations({ citations: [], transcripts: {} });
  assert.equal(r.passed, true);
  assert.equal(r.failures.length, 0);
});
