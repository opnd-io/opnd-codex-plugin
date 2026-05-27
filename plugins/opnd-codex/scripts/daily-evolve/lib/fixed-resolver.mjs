/**
 * fixed-resolver.mjs — FIXED 3-evidence resolver (Phase 0 diff-analyzer 통합)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Codex Critique R2-M7 (FIXED 좁힌 룰 — 2-evidence)
 *   - § R3-M2 (FIXED 검출 알고리즘 — 3-evidence + reject pattern)
 *
 * FIXED 분류 룰:
 *   CHANGELOG evidence (필수) + 다음 중 1+:
 *     1. touched implementation path
 *     2. test assertion
 *     3. linked PR merge
 *   "planned / documented / known issue / will fix" 패턴 reject.
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Evidence checker 는 caller (orchestrator/diff-analyzer) 가 실제 IO 후 boolean 으로 inject.
 *
 * Node 내장 의존성도 없음 (zero npm).
 */

import { VERDICTS } from "./verdict-schema.mjs";

/**
 * Reject pattern — CHANGELOG 매칭 본문에 다음 키워드 포함 시 FIXED 분류 거부.
 * case-insensitive. word boundary 으로 false positive 제어.
 */
export const REJECT_PATTERNS = Object.freeze([
  /\bplanned\b/i,
  /\bdocumented\b/i,
  /\bknown\s+issue\b/i,
  /\bknown\s+limitation\b/i,        // Codex review LOW
  /\bwill\s+fix\b/i,
  /\bwill\s+be\s+fixed\b/i,         // Codex review LOW
  /\bto\s+be\s+fixed\b/i,
  /\bin\s+progress\b/i,
  /\bfuture\s+release\b/i,          // Codex review LOW
  /\bnext\s+release\b/i,            // adjacent gap
]);

/**
 * Reject 매칭 검사 — pure.
 *
 * @param {string} changelogMatch - CHANGELOG 의 매칭 본문 (issue ref 주변 텍스트)
 * @returns {string | null} 매칭된 reject pattern source, 없으면 null
 */
export function findRejectMatch(changelogMatch) {
  if (typeof changelogMatch !== "string") return null;
  for (const re of REJECT_PATTERNS) {
    if (re.test(changelogMatch)) {
      return re.source;
    }
  }
  return null;
}

/**
 * FIXED resolver — 3-evidence + reject 룰.
 *
 * Evidence 는 caller 가 실제 IO 후 boolean 으로 inject. lib 은 pure.
 *
 * @param {{
 *   changelogMatch: string,            // CHANGELOG 매칭 본문 (issue ref 주변)
 *   evidence: {
 *     touchedPath:    boolean,         // issue body 키워드 → fork 코드 path grep 매칭 ≥ 1
 *     testAssertion:  boolean,         // CHANGELOG 인용 commit 의 test diff hunk 에 assert/expect 추가
 *     linkedPRMerge:  boolean          // gh api repos/openai/codex-plugin-cc/pulls/NNN merged=true + ancestor 확인
 *   }
 * }} input
 * @returns {{ verdict: string, reason?: string, evidence?: object, rejectPattern?: string }}
 */
export function resolveFixed({ changelogMatch, evidence } = {}) {
  // 1. CHANGELOG evidence 부재 — caller 가 미리 거름. 본 함수 진입은 CHANGELOG 매칭 있음 전제.
  if (typeof changelogMatch !== "string" || changelogMatch.length === 0) {
    return {
      verdict: VERDICTS.PARTIAL,
      reason: "changelog evidence absent (caller precondition violated)",
    };
  }

  // 2. Reject 패턴 검사 — "planned/documented/known issue/..." 매칭 시 PARTIAL 강등
  const rejectPattern = findRejectMatch(changelogMatch);
  if (rejectPattern !== null) {
    return {
      verdict: VERDICTS.PARTIAL,
      reason: "reject pattern matched",
      rejectPattern,
    };
  }

  // 3. 추가 evidence (3 중 1+) 검사
  const ev = evidence ?? {};
  const evResults = {
    touchedPath: ev.touchedPath === true,
    testAssertion: ev.testAssertion === true,
    linkedPRMerge: ev.linkedPRMerge === true,
  };
  const anyEvidence = evResults.touchedPath || evResults.testAssertion || evResults.linkedPRMerge;

  if (anyEvidence) {
    return {
      verdict: VERDICTS.FIXED,
      evidence: evResults,
    };
  }

  return {
    verdict: VERDICTS.PARTIAL,
    reason: "no additional evidence (need touchedPath / testAssertion / linkedPRMerge)",
    evidence: evResults,
  };
}
