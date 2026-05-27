/**
 * cost-profile-registry.mjs — Codex pair profile cost_units registry + usage measurement
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § L5/L7 Machine-Readable Contract — cost_units 단위 정의 (R3-H3)
 *   - § R4-M2 profile registry + usage fallback priority
 *   - § R5-L1 actual_unit = max(1, ceil(...)) — 0-token edge case 보호
 *   - § R5-L2 Registry schema 필드 정의
 *
 * 1 cost_unit = 1 normalized_cost_point = 1 short Codex turn
 *             (input ≤ 2000 tokens + output ≤ 500 tokens)
 *
 * Pure module — filesystem / network / LLM 호출 금지 (lib dependency rule R2-L2).
 * Node 내장 의존성 없음 (zero npm).
 */

/**
 * Profile registry — Codex output profile 별 cost_unit fallback + token baseline.
 * 신규 profile 추가 시 본 registry update + test 추가 필수 (R4-M2).
 */
export const COST_PROFILES = Object.freeze({
  "decision-triage": Object.freeze({
    name: "decision-triage",
    fixed_unit: 1,
    description: "short triage turn (1.3/0.7/유지 또는 PR/needs-user/skip 분기)",
    input_token_baseline: 2000,
    output_token_baseline: 500,
  }),
  "plan-review": Object.freeze({
    name: "plan-review",
    fixed_unit: 3,
    description: "plan critique — substrate-level finding 분석",
    input_token_baseline: 6000,
    output_token_baseline: 1500,
  }),
  "adversarial-review": Object.freeze({
    name: "adversarial-review",
    fixed_unit: 5,
    description: "adversarial deep critique — 미탐색 영역 발굴",
    input_token_baseline: 10000,
    output_token_baseline: 2500,
  }),
});

/** Registry validation schema (Phase 0.12 test 대상). */
export const PROFILE_SCHEMA = Object.freeze({
  required: ["name", "fixed_unit", "description", "input_token_baseline", "output_token_baseline"],
  types: {
    name: "string",
    fixed_unit: "integer-ge-1",
    description: "string",
    input_token_baseline: "integer-ge-0",
    output_token_baseline: "integer-ge-0",
  },
});

/**
 * Validate single profile against PROFILE_SCHEMA. Pure.
 *
 * @param {object} profile
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== "object") {
    return { ok: false, errors: ["profile must be an object"] };
  }
  for (const field of PROFILE_SCHEMA.required) {
    if (!(field in profile)) {
      errors.push(`missing required field: "${field}"`);
    }
  }
  for (const [field, type] of Object.entries(PROFILE_SCHEMA.types)) {
    if (!(field in profile)) continue;
    const val = profile[field];
    if (type === "string" && typeof val !== "string") {
      errors.push(`field "${field}" must be string`);
    } else if (type === "integer-ge-1") {
      if (!Number.isInteger(val) || val < 1) {
        errors.push(`field "${field}" must be integer ≥ 1`);
      }
    } else if (type === "integer-ge-0") {
      if (!Number.isInteger(val) || val < 0) {
        errors.push(`field "${field}" must be integer ≥ 0`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate entire registry — all profiles must pass PROFILE_SCHEMA. Pure.
 *
 * @returns {{ ok: boolean, failures: Array<{ profile: string, errors: string[] }> }}
 */
export function validateRegistry() {
  const failures = [];
  for (const [name, profile] of Object.entries(COST_PROFILES)) {
    const result = validateProfile(profile);
    if (!result.ok) {
      failures.push({ profile: name, errors: result.errors });
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Measure cost_units for a single Codex turn — usage 우선순위 (R4-M2):
 *   1. Codex response 의 `usage.input_tokens` + `usage.output_tokens` 직접 사용
 *      → actual = max(1, ceil((input/2000) + (output/500)))  // R5-L1 0-token 보호
 *   2. usage 부재 시: profile registry 의 fixed_unit fallback
 *   3. profile 미등록 시: 1 unit conservative + warning marker
 *
 * Pure — warning 은 반환 객체에 `warnings` array 로 surface (caller 가 log 결정).
 *
 * @param {{ profileName: string, usage?: { input_tokens?: number, output_tokens?: number } }} input
 * @returns {{ units: number, source: "usage" | "profile" | "conservative", warnings: string[] }}
 */
export function measureCost({ profileName, usage } = {}) {
  const warnings = [];

  // 우선순위 1: response usage
  if (usage && typeof usage === "object") {
    const input = Number.isFinite(usage.input_tokens) ? usage.input_tokens : NaN;
    const output = Number.isFinite(usage.output_tokens) ? usage.output_tokens : NaN;
    if (Number.isFinite(input) && Number.isFinite(output)) {
      // Codex review R2 MEDIUM — plan 공식은 `ceil((input/2000) + (output/500))` 단일 ceil.
      // 분리 ceil 하면 small input+output 혼합 시 2배 과금. R5-L1 — 0-token 호출 시 min 1.
      const raw = Math.ceil(input / 2000 + output / 500);
      const units = Math.max(1, raw);
      return { units, source: "usage", warnings };
    }
    warnings.push("usage object present but input_tokens / output_tokens 부재 — profile fallback 사용");
  }

  // 우선순위 2: profile registry fallback
  if (profileName && COST_PROFILES[profileName]) {
    return {
      units: COST_PROFILES[profileName].fixed_unit,
      source: "profile",
      warnings,
    };
  }

  // 우선순위 3: conservative 1 unit + warning
  warnings.push(
    `profile "${profileName}" 미등록 — conservative 1 unit 적용 (registry update 필요)`,
  );
  return { units: 1, source: "conservative", warnings };
}
