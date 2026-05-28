/**
 * dedupe-key.mjs — PR dedupe key 생성 (Phase 4 action-executor 용)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 5 (Action Executor)
 *   - § Codex Critique R1-HIGH-3 (dedupe key 미정의)
 *   - § R2-M1 normalized_title 알고리즘
 *   - § R3-M1 semver prerelease + CJK / emoji 강화
 *
 * dedupe_key = sha256(signal_type + normalized_title + sorted_paths + verdict)
 *
 * 동일 dedupe_key 항목이 7d cache (state/daily-evolve-pr-cache.json) 안에 있으면
 * action-executor 가 PR 생성 skip (rename PR / same-root-cause PR 중복 차단).
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Node 내장 `node:crypto` 만 사용 (zero npm).
 */

import { createHash } from "node:crypto";

/**
 * Title 정규화 — collision policy 는 plan 의 testcase 참조.
 *
 * 단계:
 *  1. lowercase
 *  2. Unicode NFKC normalize
 *  3. CJK punctuation (U+3000~U+303F, U+FF00~U+FFEF) → 공백
 *  4. Emoji strip (Unicode Emoji property)
 *  5. 나머지 punctuation strip (한글 + 영숫자 + 공백만 보존)
 *  6. PR/Issue 번호 (`#NNN`, `PR NNN`, `issue NNN`) strip
 *  7. Semver + prerelease + build (`v2.0.0-rc.1+build.42`) strip
 *  8. whitespace collapse + trim
 *
 * @param {string} title
 * @returns {string} normalized title
 */
export function normalizeTitle(title) {
  if (typeof title !== "string") {
    return "";
  }
  return (
    title
      .toLowerCase()
      .normalize("NFKC")
      // 1. CJK punctuation → 공백 (R3-M1)
      .replace(/[　-〿＀-￯]/g, " ")
      // 2. Emoji strip (R3-M1) — Extended_Pictographic 사용 (ASCII digit 0-9 보존).
      // \p{Emoji} 는 keycap base 로 0-9 / # / * 도 매칭하므로 부적합.
      .replace(/\p{Extended_Pictographic}/gu, "")
      // 3. PR/Issue 번호 strip — "pr 340", "issue 42", "issue #42", "#338" 모두 매칭.
      // `\b#` 는 `#` 가 \W 라 boundary 매칭 실패 → lookbehind 사용.
      .replace(/(?<![a-z0-9])(?:(?:pr|issue)\s*#?\s*|#\s*)\d+\b/g, "")
      // 4. Semver + prerelease + build strip — `.` 제거 전에 먼저 매칭 (R3-M1)
      .replace(/\bv?\d+\.\d+\.\d+(?:-[0-9a-z.]+)?(?:\+[0-9a-z.]+)?\b/g, "")
      // 5. 잔여 `#` 단독 strip (PR/Issue 번호 매칭 못한 케이스)
      .replace(/#/g, "")
      // 6. 나머지 punctuation strip (한글 + 영숫자 + 공백만)
      .replace(/[^\w\s가-힣]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Affected paths 정규화 — Windows `\` → POSIX `/` 통일 후 정렬.
 * 빈 배열 / null / undefined 입력은 빈 배열로 처리.
 *
 * @param {string[]} paths
 * @returns {string[]} sorted normalized paths
 */
export function normalizePaths(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths
    .filter((p) => typeof p === "string" && p.length > 0)
    .map((p) => p.replace(/\\/g, "/"))
    .sort();
}

/**
 * dedupe_key 생성 — plan 의 sha256(signal_type + normalized_title + sorted_paths + verdict).
 *
 * 입력의 어느 필드라도 falsy 면 빈 문자열로 처리. 단 모든 필드가 빈 경우엔 그래도 결정적 hash 반환.
 *
 * @param {{ signal_type: string, title: string, affected_paths: string[], verdict: string }} input
 * @returns {string} 64-char hex sha256
 */
export function computeDedupeKey({ signal_type, title, affected_paths, verdict } = {}) {
  const normalizedTitle = normalizeTitle(title ?? "");
  const sortedPaths = normalizePaths(affected_paths);
  const parts = [
    signal_type ?? "",
    normalizedTitle,
    sortedPaths.join("|"),
    verdict ?? "",
  ];
  const composite = parts.join("\x1f"); // ASCII unit separator — 일반 텍스트 미사용
  return createHash("sha256").update(composite, "utf8").digest("hex");
}
