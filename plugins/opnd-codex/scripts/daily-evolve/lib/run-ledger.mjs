/**
 * run-ledger.mjs — Run Status Ledger schema + pure helpers
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Run Status Ledger (R3-M6)
 *   - § R4-M4 atomic write + yearly rotation (started_at UTC slice 기준)
 *   - § R5-M5 파일명 `state/daily-evolve-runs-YYYY.json` 통일
 *
 * 파일명: state/daily-evolve-runs-YYYY.json (연도별 분할, append-only).
 * 실제 fs write (atomic rename) 는 orchestrator (companion entry / digest-writer) 가
 * 본 lib 의 helper 결과를 사용해 처리. lib 자체는 pure (R2-L2 dep rule 정합).
 *
 * Node 내장 의존성 없음 (zero npm).
 */

/** Status enum — entry.status 필드 허용 값. */
export const RUN_STATUS = Object.freeze({
  RUNNING: "running",
  SUCCESS: "success",
  FAILURE: "failure",
  PARTIAL: "partial",
});

export const RUN_STATUS_LIST = Object.freeze(Object.values(RUN_STATUS));

/** Phase reached enum — 0~6 (Phase 0 PoC 부터 Phase 6 self-evolve 까지). */
export const PHASE_REACHED_RANGE = Object.freeze({ MIN: 0, MAX: 6 });

/** Decision count schema field 키. */
export const DECISION_KEYS = Object.freeze([
  "autonomous_safe",
  "needs_user",
  "needs_claude_judgment",
]);

/**
 * 빈 ledger 초기값 (새 연도 파일 생성 시 사용).
 *
 * @param {number} year
 * @returns {{ schema_version: 1, year: number, runs: any[] }}
 */
export function emptyLedger(year) {
  return { schema_version: 1, year, runs: [] };
}

/**
 * started_at (ISO 8601 UTC string) 으로부터 yearly 파일명 결정. Pure.
 *
 * **Caller invariant** (Codex review LOW): startedAt 은 UTC `Z` suffix ISO 8601 형식.
 * offset 포함 (`+09:00`) 형식 입력 시 본 함수는 첫 4 글자만 slice 하여 잘못된 연도 산출 가능 —
 * caller (run ledger orchestrator) 가 사전 normalize 또는 검증 책임.
 *
 * @param {string} startedAt - ISO 8601 UTC string (e.g., "2026-05-27T05:19:03.043Z")
 * @returns {string} `state/daily-evolve-runs-YYYY.json`
 */
export function yearlyFilePath(startedAt) {
  if (typeof startedAt !== "string" || startedAt.length < 4) {
    throw new Error("yearlyFilePath: startedAt must be ISO 8601 UTC string");
  }
  const year = startedAt.slice(0, 4);
  if (!/^\d{4}$/.test(year)) {
    throw new Error(`yearlyFilePath: invalid year in "${startedAt}"`);
  }
  return `state/daily-evolve-runs-${year}.json`;
}

/**
 * Build a new run entry skeleton. Pure.
 *
 * @param {{
 *   run_id: string,
 *   started_at: string,
 *   phase_reached?: number,
 *   digest_file?: string
 * }} init
 * @returns {object} run entry (status="running", ended_at=null)
 */
export function buildEntry({ run_id, started_at, phase_reached = 0, digest_file = null } = {}) {
  return {
    run_id,
    started_at,
    ended_at: null,
    duration_ms: null,
    status: RUN_STATUS.RUNNING,
    phase_reached,
    actionable_count: 0,
    decision_count: { autonomous_safe: 0, needs_user: 0, needs_claude_judgment: 0 },
    cost_units_consumed: 0,
    failure_reason: null,
    digest_file,
  };
}

/**
 * Finalize an entry — status / ended_at / duration_ms set. Pure (새 객체 반환).
 *
 * @param {object} entry - in-flight entry (status="running")
 * @param {{
 *   status: string,
 *   ended_at: string,
 *   phase_reached?: number,
 *   actionable_count?: number,
 *   decision_count?: object,
 *   cost_units_consumed?: number,
 *   failure_reason?: string | null
 * }} patch
 * @returns {object} finalized entry
 */
export function finalizeEntry(entry, patch) {
  if (!entry || typeof entry !== "object") {
    throw new Error("finalizeEntry: entry must be an object");
  }
  if (!patch || typeof patch !== "object") {
    throw new Error("finalizeEntry: patch must be an object");
  }
  if (!RUN_STATUS_LIST.includes(patch.status)) {
    throw new Error(`finalizeEntry: status "${patch.status}" not in [${RUN_STATUS_LIST.join(", ")}]`);
  }
  const startedMs = Date.parse(entry.started_at);
  const endedMs = Date.parse(patch.ended_at);
  const duration_ms =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? endedMs - startedMs : null;
  return {
    ...entry,
    status: patch.status,
    ended_at: patch.ended_at,
    duration_ms,
    phase_reached: patch.phase_reached ?? entry.phase_reached,
    actionable_count: patch.actionable_count ?? entry.actionable_count,
    decision_count: patch.decision_count ?? entry.decision_count,
    cost_units_consumed: patch.cost_units_consumed ?? entry.cost_units_consumed,
    failure_reason: patch.failure_reason ?? entry.failure_reason,
  };
}

/**
 * Validate entry against ledger schema. Pure.
 *
 * @param {object} entry
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object") {
    return { ok: false, errors: ["entry must be an object"] };
  }
  if (typeof entry.run_id !== "string" || entry.run_id.length === 0) {
    errors.push("run_id must be non-empty string");
  }
  if (typeof entry.started_at !== "string") {
    errors.push("started_at must be ISO 8601 UTC string");
  }
  if (!RUN_STATUS_LIST.includes(entry.status)) {
    errors.push(`status "${entry.status}" not in [${RUN_STATUS_LIST.join(", ")}]`);
  }
  if (
    !Number.isInteger(entry.phase_reached) ||
    entry.phase_reached < PHASE_REACHED_RANGE.MIN ||
    entry.phase_reached > PHASE_REACHED_RANGE.MAX
  ) {
    errors.push(
      `phase_reached must be integer in [${PHASE_REACHED_RANGE.MIN}, ${PHASE_REACHED_RANGE.MAX}]`,
    );
  }
  if (!Number.isInteger(entry.actionable_count) || entry.actionable_count < 0) {
    errors.push("actionable_count must be non-negative integer");
  }
  if (
    !entry.decision_count ||
    typeof entry.decision_count !== "object" ||
    DECISION_KEYS.some((k) => !Number.isInteger(entry.decision_count[k]))
  ) {
    errors.push(`decision_count must contain integers for keys [${DECISION_KEYS.join(", ")}]`);
  }
  if (!Number.isInteger(entry.cost_units_consumed) || entry.cost_units_consumed < 0) {
    errors.push("cost_units_consumed must be non-negative integer");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Query last N runs from a ledger object (descending by started_at). Pure.
 *
 * @param {{ runs: object[] }} ledger
 * @param {number} n
 * @returns {object[]} last N runs (newest first)
 */
export function queryLastN(ledger, n) {
  if (!ledger || !Array.isArray(ledger.runs)) return [];
  if (!Number.isInteger(n) || n < 1) return [];
  const sorted = [...ledger.runs].sort((a, b) =>
    (b.started_at ?? "").localeCompare(a.started_at ?? ""),
  );
  return sorted.slice(0, n);
}

/**
 * Merge multiple yearly ledgers — Phase 6 가 last 2 연도 머지 시 사용. Pure.
 *
 * @param {Array<{ runs: object[] }>} ledgers
 * @returns {object[]} merged runs (newest first)
 */
export function mergeLedgers(ledgers) {
  if (!Array.isArray(ledgers)) return [];
  const all = [];
  for (const l of ledgers) {
    if (l && Array.isArray(l.runs)) {
      for (const r of l.runs) all.push(r);
    }
  }
  return all.sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
}

/**
 * Append entry to ledger (immutable — 새 ledger 객체 반환). Pure.
 *
 * Caller (orchestrator) 가 본 함수 결과를 fs.writeFileSync(tmp) + fs.renameSync(file)
 * 으로 atomic 하게 write. 본 lib 은 fs IO 없음.
 *
 * @param {{ schema_version: 1, year: number, runs: object[] }} ledger
 * @param {object} entry
 * @returns {{ schema_version: 1, year: number, runs: object[] }} new ledger
 */
export function appendEntry(ledger, entry) {
  if (!ledger || typeof ledger !== "object") {
    throw new Error("appendEntry: ledger must be an object");
  }
  return {
    ...ledger,
    runs: [...(ledger.runs ?? []), entry],
  };
}
