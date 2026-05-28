/**
 * state-migrator.mjs — schema migration runner (fail-closed)
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § state Schema Migration 정책 (R3-H4)
 *   - § R4-H2 unknown fileType + missing migration + downgrade fail-closed throw
 *   - § R5-M2 throw → digest failures 경로 (caller 가 catch 책임)
 *
 * 모든 state JSON 에 `schema_version: integer` 필수.
 *   - 일치 → pass-through
 *   - 낮음 → MIGRATIONS chain (v1→v2→...) 적용
 *   - 높음 → fail-closed throw (downgrade 차단)
 *   - unknown fileType / missing migration entry → throw + routine abort
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Corrupt JSON backup 등 fs IO 는 orchestrator (env-probe / digest-writer 등) 가 catch
 * 후 처리. 본 lib 은 migrate() 결과만 반환하거나 throw.
 *
 * Node 내장 의존성 없음 (zero npm).
 */

/**
 * MIGRATIONS — { fileType: { targetVersion: migrateFn(prevData) } }
 *
 * 신규 schema_version 추가 시 본 table + LATEST 동시 update.
 * 각 migrate 함수는 pure: prevData → nextData (mutation 없이 새 객체 반환).
 */
export const MIGRATIONS = Object.freeze({
  "daily-evolve-pr-cache": Object.freeze({
    1: (v) => v, // initial — no migration needed
  }),
  "daily-evolve-cost-baseline": Object.freeze({
    1: (v) => v,
  }),
  "daily-evolve-self-evolve-log": Object.freeze({
    1: (v) => v,
  }),
  "daily-evolve-env-probe": Object.freeze({
    1: (v) => v,
  }),
  "daily-evolve-runs": Object.freeze({
    1: (v) => v,
  }),
});

/** LATEST — 각 fileType 의 현재 최신 schema_version. */
export const LATEST = Object.freeze({
  "daily-evolve-pr-cache": 1,
  "daily-evolve-cost-baseline": 1,
  "daily-evolve-self-evolve-log": 1,
  "daily-evolve-env-probe": 1,
  "daily-evolve-runs": 1,
});

/** Failure reason enum (R5-M2 — digest failures 섹션에 surface). */
export const FAILURE_REASONS = Object.freeze({
  UNKNOWN_FILETYPE: "unknown_filetype",
  MISSING_MIGRATION: "missing_migration",
  DOWNGRADE_BLOCKED: "downgrade_blocked",
  CORRUPT_JSON: "corrupt_json", // caller (orchestrator) 가 사용 — 본 lib throw 외
  MISSING_SCHEMA_VERSION: "missing_schema_version",
});

/**
 * Custom error class — caller 가 catch 후 failure_reason enum 으로 routing.
 */
export class MigrationError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = "MigrationError";
    this.reason = reason;
    this.details = details;
  }
}

/**
 * Migrate data to LATEST schema_version. Pure (mutation 없음).
 *
 * Fail-closed:
 *  - unknown fileType → throw MigrationError(UNKNOWN_FILETYPE)
 *  - data.schema_version 부재 → throw MigrationError(MISSING_SCHEMA_VERSION)
 *  - downgrade (data.schema_version > LATEST) → throw MigrationError(DOWNGRADED_BLOCKED)
 *  - missing migration entry → throw MigrationError(MISSING_MIGRATION)
 *
 * @param {string} fileType
 * @param {object} data
 * @returns {object} migrated data (LATEST schema_version)
 * @throws {MigrationError}
 */
export function migrate(fileType, data) {
  if (!(fileType in MIGRATIONS) || !(fileType in LATEST)) {
    throw new MigrationError(
      FAILURE_REASONS.UNKNOWN_FILETYPE,
      `state-migrator: unknown fileType "${fileType}" — routine abort. ` +
        `No backup created (avoid silent corruption).`,
      { fileType },
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new MigrationError(
      FAILURE_REASONS.CORRUPT_JSON,
      `state-migrator: data is not a plain object — orchestrator 가 corrupt JSON backup 처리 필요`,
      { fileType, data },
    );
  }

  if (!Number.isInteger(data.schema_version)) {
    throw new MigrationError(
      FAILURE_REASONS.MISSING_SCHEMA_VERSION,
      `state-migrator: data.schema_version 부재 또는 non-integer (fileType="${fileType}")`,
      { fileType, found: data.schema_version },
    );
  }

  const target = LATEST[fileType];

  if (data.schema_version > target) {
    throw new MigrationError(
      FAILURE_REASONS.DOWNGRADE_BLOCKED,
      `state-migrator: downgrade blocked (file v${data.schema_version} > LATEST v${target}) — ` +
        `사용자 수동 schema 업그레이드 후 재실행 필요`,
      { fileType, fileVersion: data.schema_version, latestVersion: target },
    );
  }

  if (data.schema_version === target) {
    return data; // pass-through (no migration needed)
  }

  let current = data;
  for (let v = data.schema_version; v < target; v++) {
    const nextVersion = v + 1;
    const migrateFn = MIGRATIONS[fileType][nextVersion];
    if (typeof migrateFn !== "function") {
      throw new MigrationError(
        FAILURE_REASONS.MISSING_MIGRATION,
        `state-migrator: missing migration ${fileType} v${v}→v${nextVersion} — routine abort. ` +
          `Manual intervention required.`,
        { fileType, fromVersion: v, toVersion: nextVersion },
      );
    }
    current = migrateFn(current);
    if (!current || typeof current !== "object" || current.schema_version !== nextVersion) {
      throw new MigrationError(
        FAILURE_REASONS.MISSING_MIGRATION,
        `state-migrator: migration function ${fileType} v${v}→v${nextVersion} did not set ` +
          `schema_version=${nextVersion} in output — implementation bug`,
        { fileType, fromVersion: v, toVersion: nextVersion },
      );
    }
  }
  return current;
}
