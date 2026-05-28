/**
 * verdict-schema.mjs — daily-evolve pipeline 의 (verdict, signal_type) 2-축 enum + JSON schema.
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 2 (Diff/Gap Analyzer)
 *   - § Codex Critique R2-M6 (verdict 와 signal_type 분리)
 *   - § R3-M6 schema migration (verdict-only 항목 default signal_type)
 *
 * 한 항목은 항상 (verdict, signal_type) pair 로 분류된다.
 *   - verdict     = 해결 상태 축 (research.md 의 5-verdict 재사용)
 *   - signal_type = 신호 출처 축 (R2-M6 신규)
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Node 내장 의존성도 없음 (zero npm 룰).
 */

/** 해결 상태 축. research.md 의 5-verdict 그대로 재사용. */
export const VERDICTS = Object.freeze({
  FIXED: "FIXED",
  PARTIAL: "PARTIAL",
  NOT_FIXED: "NOT-FIXED",
  WONTFIX: "WONTFIX",
  QUESTION: "QUESTION",
});

export const VERDICT_LIST = Object.freeze(Object.values(VERDICTS));

/** 신호 출처 축. R2-M6 신규 — 7-source 각각 별도 signal_type. */
export const SIGNAL_TYPES = Object.freeze({
  UPSTREAM_ISSUE: "upstream-issue",
  UPSTREAM_PR: "upstream-pr",
  FORK_IMPORT_CANDIDATE: "fork-import-candidate",
  TELEMETRY_UX: "telemetry-ux",
  MEMORY_DRIFT: "memory-drift",
  TODO_STALE: "todo-stale",
  UNRELEASED_GAP: "unreleased-gap",
});

export const SIGNAL_TYPE_LIST = Object.freeze(Object.values(SIGNAL_TYPES));

/**
 * R3-M6 migration default: research.md 의 verdict 만 있는 항목 (signal_type 부재) 은
 * `upstream-issue` 으로 자동 부여. diff-analyzer.mjs 의 schema migration 경로에서 사용.
 */
export const DEFAULT_SIGNAL_TYPE_FOR_MIGRATION = SIGNAL_TYPES.UPSTREAM_ISSUE;

/**
 * JSON Schema (draft-07) for a single (verdict, signal_type) pair record.
 * digest-writer 또는 action-executor 가 record 직렬화 / 역직렬화 시 사용.
 */
export const RECORD_SCHEMA = Object.freeze({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["verdict", "signal_type"],
  additionalProperties: true,
  properties: {
    verdict: { type: "string", enum: [...VERDICT_LIST] },
    signal_type: { type: "string", enum: [...SIGNAL_TYPE_LIST] },
  },
});

/**
 * Validate (verdict, signal_type) pair. Pure — no IO.
 *
 * @param {object} record - object with `verdict` and `signal_type` keys
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["record must be a plain object"] };
  }
  if (!VERDICT_LIST.includes(record.verdict)) {
    errors.push(
      `verdict "${record.verdict}" not in [${VERDICT_LIST.join(", ")}]`,
    );
  }
  if (!SIGNAL_TYPE_LIST.includes(record.signal_type)) {
    errors.push(
      `signal_type "${record.signal_type}" not in [${SIGNAL_TYPE_LIST.join(", ")}]`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Apply migration default — verdict 만 있고 signal_type 부재인 record 에
 * DEFAULT_SIGNAL_TYPE_FOR_MIGRATION 부여. 이미 signal_type 있으면 변경 X.
 *
 * Pure — record 복사본 반환 (원본 mutation 없음).
 *
 * @param {object} record
 * @returns {object} migrated record
 */
export function applyMigrationDefault(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return record;
  }
  if (record.signal_type != null) {
    return record;
  }
  return { ...record, signal_type: DEFAULT_SIGNAL_TYPE_FOR_MIGRATION };
}
