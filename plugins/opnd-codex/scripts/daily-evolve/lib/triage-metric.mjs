/**
 * triage-metric.mjs — daily digest 의 cognitive load metric (Phase 1)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 4 (Daily Digest Writer) — cognitive metadata
 *   - § Codex Critique R2-M5 (cognitive load metric measurable)
 *   - § L3 Codex Triage 결과의 3분류 (autonomous_safe / needs_user / needs_claude_judgment)
 *
 * Digest header 에 명시:
 *   - decision_count        : 3분류 별 항목 수
 *   - estimated_reading_min : digest md 길이 → 분 단위 reading time
 *   - manual_actions_required : needs_user 항목 수 (직접 결정 필요)
 *
 * Defining constraint (forcing function): 사용자 ≤30분 morning triage cognitive load 보호.
 * 본 metric 이 30분 초과 가능성 alert 의 base.
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Node 내장 의존성 없음 (zero npm).
 */

/** Average reading speed (한국어 + 영어 혼합 기술 markdown). */
export const WORDS_PER_MINUTE = 200;

/** Decision keys — triage 결과 3분류. */
export const DECISION_KEYS = Object.freeze([
  "autonomous_safe",
  "needs_user",
  "needs_claude_judgment",
]);

/** 사용자 morning triage budget — defining constraint 의 30분. */
export const TRIAGE_BUDGET_MINUTES = 30;

/** Manual actions decision budget — 30분 안 가능한 결정 수 cap. Phase 0.5 fix.
 *  분당 2 결정 가정 (1.5x WORDS_PER_MINUTE 단순 모델보다 보수적). */
export const MANUAL_ACTIONS_BUDGET = 60;

/**
 * Decision count 집계. 각 record 의 `triage` 필드를 본다 (Codex L3 결과 후).
 * triage 부재 record 는 모두 autonomous_safe 도 needs_user 도 아닌 영역 → 계산 제외.
 *
 * @param {Array<{ triage?: "autonomous_safe" | "needs_user" | "needs_claude_judgment" }>} records
 * @returns {{ autonomous_safe: number, needs_user: number, needs_claude_judgment: number }}
 */
export function countDecisions(records) {
  const counts = { autonomous_safe: 0, needs_user: 0, needs_claude_judgment: 0 };
  if (!Array.isArray(records)) return counts;
  for (const r of records) {
    const t = r?.triage;
    if (t && t in counts) counts[t] += 1;
  }
  return counts;
}

/**
 * Digest markdown body 의 word count → reading minutes.
 * Pure heuristic — CJK 한 글자 = 1 word 로 단순화 (technical doc 기준).
 *
 * @param {string} markdown
 * @returns {number} reading minutes (integer, min 1)
 */
export function estimateReadingMinutes(markdown) {
  if (typeof markdown !== "string" || markdown.length === 0) return 0;
  // 영문 word: \b 단위, CJK: char 단위
  const ascii = (markdown.match(/[\w']+/g) ?? []).length;
  const cjk = (markdown.match(/[가-힣一-龯ぁ-んァ-ヶ]/g) ?? []).length;
  const words = ascii + cjk;
  return Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
}

/**
 * Manual action count — needs_user 항목 수.
 * Decision triage 의 needs_user 가 사용자 직접 결정 영역 (CLAUDE.md § User Decision Triage Protocol).
 */
export function countManualActions(records) {
  if (!Array.isArray(records)) return 0;
  return records.filter((r) => r?.triage === "needs_user").length;
}

/**
 * Aggregate metric — digest header 에 한 번에 출력할 metadata object.
 *
 * @param {{ records: object[], markdown: string }} input
 * @returns {{
 *   decision_count: object,
 *   estimated_reading_minutes: number,
 *   manual_actions_required: number,
 *   triage_budget_minutes: number,
 *   exceeds_budget: boolean
 * }}
 */
export function buildMetricHeader({ records, markdown } = {}) {
  const decision_count = countDecisions(records);
  const estimated_reading_minutes = estimateReadingMinutes(markdown);
  const manual_actions_required = countManualActions(records);
  // Phase 0.5 fix — exceeds_budget 가 reading_minutes 만 보던 mismatch 해결.
  // manual_actions_required 가 MANUAL_ACTIONS_BUDGET 초과해도 alert.
  const exceedsReading = estimated_reading_minutes > TRIAGE_BUDGET_MINUTES;
  const exceedsActions = manual_actions_required > MANUAL_ACTIONS_BUDGET;
  return {
    decision_count,
    estimated_reading_minutes,
    manual_actions_required,
    triage_budget_minutes: TRIAGE_BUDGET_MINUTES,
    manual_actions_budget: MANUAL_ACTIONS_BUDGET,
    exceeds_budget: exceedsReading || exceedsActions,
    exceeds_reading_budget: exceedsReading,
    exceeds_actions_budget: exceedsActions,
  };
}

/**
 * Format metric header → markdown table (digest 의 첫 섹션에 insert).
 *
 * @param {object} metric - buildMetricHeader 결과
 * @returns {string} markdown
 */
export function formatMetricHeader(metric) {
  if (!metric) return "";
  const dc = metric.decision_count ?? {};
  const lines = [
    "| metric | value |",
    "|---|---|",
    `| autonomous_safe | ${dc.autonomous_safe ?? 0} |`,
    `| needs_user | ${dc.needs_user ?? 0} |`,
    `| needs_claude_judgment | ${dc.needs_claude_judgment ?? 0} |`,
    `| manual_actions_required | ${metric.manual_actions_required ?? 0} |`,
    `| estimated_reading_minutes | ${metric.estimated_reading_minutes ?? 0} / ${metric.triage_budget_minutes ?? TRIAGE_BUDGET_MINUTES} |`,
  ];
  if (metric.exceeds_reading_budget) {
    lines.push(`| ⚠ exceeds_reading_budget | true — reading ${metric.estimated_reading_minutes}m > ${metric.triage_budget_minutes}m |`);
  }
  if (metric.exceeds_actions_budget) {
    lines.push(`| ⚠ exceeds_actions_budget | true — manual ${metric.manual_actions_required} > ${metric.manual_actions_budget ?? MANUAL_ACTIONS_BUDGET} (분당 2 결정 모델 초과) |`);
  }
  return lines.join("\n");
}
