/**
 * triage-metric.test.mjs — lib/triage-metric.mjs unit test (Phase 1)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countDecisions,
  countManualActions,
  estimateReadingMinutes,
  buildMetricHeader,
  formatMetricHeader,
  DECISION_KEYS,
  TRIAGE_BUDGET_MINUTES,
  WORDS_PER_MINUTE,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/triage-metric.mjs";

test("countDecisions — 3분류 각 + 미분류 제외", () => {
  const records = [
    { triage: "autonomous_safe" },
    { triage: "autonomous_safe" },
    { triage: "needs_user" },
    { triage: "needs_claude_judgment" },
    { triage: "unknown" }, // 미분류 — 제외
    {}, // triage 부재
  ];
  const result = countDecisions(records);
  assert.deepEqual(result, {
    autonomous_safe: 2,
    needs_user: 1,
    needs_claude_judgment: 1,
  });
});

test("countDecisions — null / 비배열 입력은 0 default", () => {
  assert.deepEqual(countDecisions(null), {
    autonomous_safe: 0,
    needs_user: 0,
    needs_claude_judgment: 0,
  });
  assert.deepEqual(countDecisions("string"), {
    autonomous_safe: 0,
    needs_user: 0,
    needs_claude_judgment: 0,
  });
});

test("countManualActions — needs_user 만 카운트", () => {
  assert.equal(
    countManualActions([
      { triage: "needs_user" },
      { triage: "needs_user" },
      { triage: "autonomous_safe" },
    ]),
    2,
  );
  assert.equal(countManualActions([]), 0);
  assert.equal(countManualActions(null), 0);
});

test("estimateReadingMinutes — 영문 + 한글 mixed", () => {
  // 200 영문 word ≈ 1분 (WORDS_PER_MINUTE)
  const eng = Array(200).fill("word").join(" ");
  assert.equal(estimateReadingMinutes(eng), 1);

  // 200 한글 char ≈ 1분
  const kor = "한".repeat(200);
  assert.equal(estimateReadingMinutes(kor), 1);

  // mixed = 합
  const mixed = `${Array(100).fill("word").join(" ")} ${"한".repeat(100)}`;
  assert.equal(estimateReadingMinutes(mixed), 1);

  // 빈 입력 → 0
  assert.equal(estimateReadingMinutes(""), 0);
  assert.equal(estimateReadingMinutes(null), 0);

  // 매우 짧은 input → min 1
  assert.equal(estimateReadingMinutes("hi"), 1);
});

test("buildMetricHeader — exceeds_budget true/false", () => {
  // 짧은 markdown — budget 안
  const short = buildMetricHeader({
    records: [{ triage: "needs_user" }],
    markdown: "안녕하세요 짧은 내용입니다",
  });
  assert.equal(short.exceeds_budget, false);
  assert.equal(short.manual_actions_required, 1);
  assert.equal(short.triage_budget_minutes, TRIAGE_BUDGET_MINUTES);

  // 매우 긴 markdown — 30분 초과
  const longMarkdown = Array(WORDS_PER_MINUTE * (TRIAGE_BUDGET_MINUTES + 5))
    .fill("word")
    .join(" ");
  const long = buildMetricHeader({ records: [], markdown: longMarkdown });
  assert.equal(long.exceeds_budget, true);
  assert.ok(long.estimated_reading_minutes > TRIAGE_BUDGET_MINUTES);
});

test("formatMetricHeader — markdown table 출력", () => {
  const metric = {
    decision_count: { autonomous_safe: 5, needs_user: 3, needs_claude_judgment: 1 },
    estimated_reading_minutes: 15,
    manual_actions_required: 3,
    triage_budget_minutes: 30,
    exceeds_budget: false,
  };
  const md = formatMetricHeader(metric);
  assert.match(md, /\| metric \| value \|/);
  assert.match(md, /\| autonomous_safe \| 5 \|/);
  assert.match(md, /\| needs_user \| 3 \|/);
  assert.match(md, /\| needs_claude_judgment \| 1 \|/);
  assert.match(md, /\| manual_actions_required \| 3 \|/);
  assert.match(md, /\| estimated_reading_minutes \| 15 \/ 30 \|/);
  assert.doesNotMatch(md, /exceeds_budget/);
});

test("formatMetricHeader — exceeds_budget 시 ⚠ 행 추가", () => {
  const metric = buildMetricHeader({
    records: [],
    markdown: Array(10000).fill("word").join(" "),
  });
  const md = formatMetricHeader(metric);
  assert.match(md, /⚠ exceeds_budget \| true/);
});

test("DECISION_KEYS — 3 enum 일치", () => {
  assert.deepEqual([...DECISION_KEYS], [
    "autonomous_safe",
    "needs_user",
    "needs_claude_judgment",
  ]);
});
