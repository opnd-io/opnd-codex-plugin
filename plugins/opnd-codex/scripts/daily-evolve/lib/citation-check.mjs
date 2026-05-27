/**
 * citation-check.mjs — L4 digest 의 Codex finding 인용 검증
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § L4 Citation Check 구현 spec (R3-M3)
 *   - § R4-M? citation accuracy 검증 강화
 *
 * 검증 단계 (pure):
 *   1. agentId 형식 검증 (16-char hex 또는 alphanumeric registry id)
 *   2. line_ref 의 transcript 라인이 byte-level (UTF-8, 100%) 일치
 *   3. line drift 시 (transcript 변경됨): fuzzy match ≥ 80% 면 warning + pass,
 *      미만이면 fail
 *
 * fail-closed: 검증 실패 citation 은 digest-writer 가 strip + warning surface.
 *
 * Transcript text 는 caller (orchestrator/digest-writer) 가 fs read 후 lib 에 inject.
 * lib dependency rule (R2-L2) 정합 — 본 모듈은 pure.
 *
 * Node 내장 의존성 없음 (zero npm).
 */

/** Fuzzy match threshold — 본 값 미만 시 fail. */
export const FUZZY_THRESHOLD = 0.8;

/**
 * Levenshtein DP 입력 길이 cap (Codex review MEDIUM — O(n*m) CPU 폭증 방어).
 * 둘 중 하나라도 본 값 초과 시 fuzzy match skip + automatic fail (drift 분류).
 */
export const SIMILARITY_LENGTH_CAP = 10_000;

/** AgentId format pattern — Codex registry id. 16-char hex 또는 alphanumeric. */
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9]{8,32}$/;

/** Citation reason enum — digest-writer 가 warning 분류에 사용. */
export const CITATION_REASONS = Object.freeze({
  AGENT_ID_INVALID: "agent_id_invalid",
  AGENT_ID_NOT_FOUND: "agent_id_not_found",
  LINE_REF_OUT_OF_RANGE: "line_ref_out_of_range",
  EXACT_MATCH: "exact_match",
  FUZZY_MATCH: "fuzzy_match",
  FUZZY_FAIL: "fuzzy_fail",
  TRANSCRIPT_MISSING: "transcript_missing",
});

/**
 * Validate agentId format. Pure.
 *
 * @param {string} agentId
 * @returns {boolean}
 */
export function isValidAgentId(agentId) {
  return typeof agentId === "string" && AGENT_ID_PATTERN.test(agentId);
}

/**
 * Compute simple Levenshtein-based similarity ratio. Pure.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1 similarity (1 = identical)
 */
export function similarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  // Codex review MEDIUM — 긴 문자열 O(n*m) CPU 폭증 방어. cap 초과 시 0 반환 → caller 가 fail 처리.
  if (a.length > SIMILARITY_LENGTH_CAP || b.length > SIMILARITY_LENGTH_CAP) return 0;
  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return 1 - distance / maxLen;
}

/** Levenshtein distance (iterative DP, O(n*m) space O(min(n,m))). Pure. */
function levenshtein(a, b) {
  if (a === b) return 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let prev = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  let curr = new Array(shorter.length + 1);
  for (let i = 1; i <= longer.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= shorter.length; j++) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[shorter.length];
}

/**
 * Validate single citation against transcript text. Pure.
 *
 * @param {{
 *   citation: {
 *     agentId: string,
 *     line_ref: number,
 *     quoted_text: string
 *   },
 *   transcript: {
 *     agentId: string,
 *     lines: string[]
 *   } | null
 * }} input
 * @returns {{ passed: boolean, reason: string, similarity?: number }}
 */
export function checkSingleCitation({ citation, transcript } = {}) {
  if (!citation || typeof citation !== "object") {
    return { passed: false, reason: CITATION_REASONS.AGENT_ID_INVALID };
  }

  if (!isValidAgentId(citation.agentId)) {
    return { passed: false, reason: CITATION_REASONS.AGENT_ID_INVALID };
  }

  if (!transcript || typeof transcript !== "object") {
    return { passed: false, reason: CITATION_REASONS.TRANSCRIPT_MISSING };
  }

  if (transcript.agentId !== citation.agentId) {
    return { passed: false, reason: CITATION_REASONS.AGENT_ID_NOT_FOUND };
  }

  if (!Array.isArray(transcript.lines)) {
    return { passed: false, reason: CITATION_REASONS.TRANSCRIPT_MISSING };
  }

  const lineIdx = Number.isInteger(citation.line_ref) ? citation.line_ref - 1 : -1;
  if (lineIdx < 0 || lineIdx >= transcript.lines.length) {
    return { passed: false, reason: CITATION_REASONS.LINE_REF_OUT_OF_RANGE };
  }

  const actualLine = transcript.lines[lineIdx];
  const quoted = citation.quoted_text ?? "";

  // 1. Exact byte-level match (UTF-8 100%)
  if (actualLine === quoted) {
    return { passed: true, reason: CITATION_REASONS.EXACT_MATCH, similarity: 1 };
  }

  // 2. Fuzzy match — line drift 대응
  const sim = similarity(actualLine, quoted);
  if (sim >= FUZZY_THRESHOLD) {
    return { passed: true, reason: CITATION_REASONS.FUZZY_MATCH, similarity: sim };
  }

  return { passed: false, reason: CITATION_REASONS.FUZZY_FAIL, similarity: sim };
}

/**
 * Validate array of citations against transcripts map. Pure.
 *
 * @param {{
 *   citations: Array<{ agentId, line_ref, quoted_text }>,
 *   transcripts: Record<string, { agentId, lines }>  // keyed by agentId
 * }} input
 * @returns {{
 *   passed: boolean,
 *   results: Array<{ citation, passed, reason, similarity?: number }>,
 *   failures: Array<{ citation, reason }>
 * }}
 */
export function checkCitations({ citations, transcripts } = {}) {
  if (!Array.isArray(citations)) {
    return { passed: true, results: [], failures: [] };
  }
  const transcriptMap = transcripts && typeof transcripts === "object" ? transcripts : {};
  const results = [];
  const failures = [];
  for (const citation of citations) {
    const transcript = transcriptMap[citation?.agentId] ?? null;
    const result = checkSingleCitation({ citation, transcript });
    results.push({ citation, ...result });
    if (!result.passed) {
      failures.push({ citation, reason: result.reason });
    }
  }
  return {
    passed: failures.length === 0,
    results,
    failures,
  };
}
