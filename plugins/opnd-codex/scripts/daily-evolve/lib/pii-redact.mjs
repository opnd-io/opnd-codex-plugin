/**
 * pii-redact.mjs — Phase 3 PII mask (memory diff 등에서 외부 surface 전 적용)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 위험 요소 — Memory PII 노출
 *   - § Phase 3.1 — `lib/pii-redact.mjs` mask 룰
 *
 * Mask 대상 (digest 출력 / PR body 등 외부 surface):
 *   - Email (RFC 5322 simplified)
 *   - GitHub PAT / Codex API token (`ghp_*` / `gho_*` / `sk-*` / 40+ hex)
 *   - 절대경로 (Windows `C:\...` / POSIX `/Users/...` / `/home/...`)
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2 lib dep rule).
 * Node 내장 의존성 없음 (zero npm).
 */

/** Email pattern (RFC 5322 simplified — local + @ + domain). */
export const EMAIL_PATTERN = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

/** GitHub Personal Access Token / Codex API key patterns. */
export const TOKEN_PATTERNS = Object.freeze([
  /\bghp_[A-Za-z0-9]{36,}\b/g, // GitHub PAT classic
  /\bgho_[A-Za-z0-9]{36,}\b/g, // GitHub OAuth
  /\bghs_[A-Za-z0-9]{36,}\b/g, // GitHub server-to-server
  /\bghu_[A-Za-z0-9]{36,}\b/g, // GitHub user-to-server
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Codex API key
  /\bxox[bps]-[A-Za-z0-9-]{10,}\b/g, // Slack token
  /\b[A-Fa-f0-9]{40}\b/g, // 40-hex (Git SHA — 단 token 도 hex 40 가능. 보수적 mask)
]);

/** Absolute path patterns (POSIX + Windows). */
export const ABSOLUTE_PATH_PATTERNS = Object.freeze([
  // Windows: `C:\...` 또는 `C:/...`
  /\b[A-Z]:[\\/]Users[\\/][^\s"'`<>]+/gi,
  /\b[A-Z]:[\\/]home[\\/][^\s"'`<>]+/gi,
  // POSIX: /Users/USERNAME/... or /home/USERNAME/...
  /\/Users\/[^\s"'`<>/]+(?:\/[^\s"'`<>]*)?/g,
  /\/home\/[^\s"'`<>/]+(?:\/[^\s"'`<>]*)?/g,
  // macOS: /tmp/[username]
  /\/tmp\/(?:[a-z]+[a-z0-9-]*\/)+/gi,
]);

/** Replacement markers (consistent for grep). */
export const REDACT_MARKERS = Object.freeze({
  EMAIL: "<email>",
  TOKEN: "<token>",
  ABSOLUTE_PATH: "<path>",
});

/**
 * Email mask. Pure.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactEmails(text) {
  if (typeof text !== "string") return text;
  return text.replace(EMAIL_PATTERN, REDACT_MARKERS.EMAIL);
}

/**
 * Token mask. Pure. 모든 TOKEN_PATTERNS 순차 적용.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactTokens(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, REDACT_MARKERS.TOKEN);
  }
  return out;
}

/**
 * Absolute path mask. Pure.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactAbsolutePaths(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    out = out.replace(re, REDACT_MARKERS.ABSOLUTE_PATH);
  }
  return out;
}

/**
 * Apply all PII masks. Pure.
 *
 * @param {string} text
 * @returns {{ redacted: string, hits: { email: number, token: number, path: number } }}
 */
export function redactAll(text) {
  if (typeof text !== "string") return { redacted: text, hits: { email: 0, token: 0, path: 0 } };
  const emailCount = (text.match(EMAIL_PATTERN) ?? []).length;
  let tokenCount = 0;
  for (const re of TOKEN_PATTERNS) {
    tokenCount += (text.match(re) ?? []).length;
  }
  let pathCount = 0;
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    pathCount += (text.match(re) ?? []).length;
  }
  const redacted = redactAbsolutePaths(redactTokens(redactEmails(text)));
  return { redacted, hits: { email: emailCount, token: tokenCount, path: pathCount } };
}

/**
 * Check whether text contains PII. Pure (no replacement).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function containsPii(text) {
  if (typeof text !== "string") return false;
  if (EMAIL_PATTERN.test(text)) {
    EMAIL_PATTERN.lastIndex = 0;
    return true;
  }
  for (const re of TOKEN_PATTERNS) {
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  for (const re of ABSOLUTE_PATH_PATTERNS) {
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}
