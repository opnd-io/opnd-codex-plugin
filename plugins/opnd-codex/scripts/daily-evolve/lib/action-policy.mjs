/**
 * action-policy.mjs — Phase 4 L5 협의 heuristic stub + PR cache schema
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Component 5 (Action Executor + Codex pair 협의)
 *   - § Phase 4 — autonomous-safe → L5 협의 → PR/needs-user/skip 분기
 *   - § L5/L7 Machine-Readable Contract — L5 response schema
 *   - § R2-H3 dedupe key + 7d cache
 *
 * autonomous-safe 분류 (triage L3) 후에도 즉시 PR 자동 X. 항상 L5 협의 1단계 추가:
 *   (a) pr_draft 즉시 생성 — 명백한 안전 변경 (stale TODO 삭제, 문서 typo 등)
 *   (b) needs_user surface — Codex 도 결정 미루기 권장 → digest 결정 박스
 *   (c) skip — Codex 가 변경 가치 없다고 판단 (단 user_surface_value 가 high/medium 이면 digest backlog 으로 surface)
 *
 * Phase 4 PoC = heuristic stub (signal_type / verdict 기반).
 * Actual Codex pair 호출은 Phase 4.5+ — `/opnd-codex:pair --output-profile decision-triage`.
 *
 * Pure module — filesystem / network 호출 금지 (R2-L2). state IO 는 orchestrator (action-executor).
 * Node 내장 의존성 없음 (zero npm).
 */

import { SIGNAL_TYPES, VERDICTS } from "./verdict-schema.mjs";

/** L5 decision enum (L5 contract). */
export const L5_DECISIONS = Object.freeze({
  PR_DRAFT: "pr_draft",
  NEEDS_USER: "needs_user",
  SKIP: "skip",
});

/** user_surface_value enum. */
export const L5_SURFACE_VALUES = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NONE: "none",
});

/** PR cache schema. state/daily-evolve-pr-cache.json. */
export const PR_CACHE_SCHEMA_VERSION = 1;

/** Cache entry 보존 기간 (Plan R2-H3 — 7d dedupe cache). */
export const CACHE_TTL_DAYS = 7;

/** 동시 open PR draft cap (Plan R3-H3). */
export const PR_CONCURRENT_CAP = 5;

/**
 * L5 heuristic stub — Phase 4 PoC. signal_type + verdict 기반 분류.
 *
 *   - TODO_STALE (≥30d) → pr_draft 후보 (단순 stale TODO 삭제 변경)
 *   - UNRELEASED_GAP → needs_user (선언 ↔ 실 구현 불일치 — 사용자 결정 필요)
 *   - TELEMETRY_UX (failure cluster) → needs_user (UX 개선은 user 판단)
 *   - MEMORY_DRIFT → needs_user (사용자 합의 vs plugin 동작 — user check 필수)
 *   - FORK_IMPORT_CANDIDATE → needs_user (import 결정은 user 영역)
 *   - upstream-issue/pr 의 FIXED + autonomous_safe → skip (no action)
 *   - 그 외 → skip + user_surface_value=low
 *
 * @param {object} record - triaged record (triage="autonomous_safe" 가정)
 * @returns {{ decision: string, rationale: string, user_surface_value: string, cost_units: number, fallback_used: boolean }}
 */
export function heuristicL5(record) {
  if (!record || typeof record !== "object") {
    return {
      decision: L5_DECISIONS.NEEDS_USER,
      rationale: "L5 invalid input — fail-closed needs_user",
      user_surface_value: L5_SURFACE_VALUES.LOW,
      cost_units: 1,
      fallback_used: true,
    };
  }
  const sig = record.signal_type;
  const verdict = record.verdict;

  if (sig === SIGNAL_TYPES.TODO_STALE && record.age_days >= 30) {
    return {
      decision: L5_DECISIONS.PR_DRAFT,
      rationale: `stale TODO ≥30d (age=${record.age_days}d, ${record.file}:${record.line}) — 단순 정리 PR draft 후보`,
      user_surface_value: L5_SURFACE_VALUES.MEDIUM,
      cost_units: 1,
      fallback_used: false,
    };
  }
  if (sig === SIGNAL_TYPES.UNRELEASED_GAP) {
    return {
      decision: L5_DECISIONS.NEEDS_USER,
      rationale: `CHANGELOG 선언 (\`${record.ref}\`) ↔ 실 구현 불일치 — 사용자 의도 확인 필요`,
      user_surface_value: L5_SURFACE_VALUES.MEDIUM,
      cost_units: 1,
      fallback_used: false,
    };
  }
  if (sig === SIGNAL_TYPES.TELEMETRY_UX) {
    return {
      decision: L5_DECISIONS.NEEDS_USER,
      rationale: `UX failure cluster (${record.cluster_size}건) — 개선 방향 사용자 결정`,
      user_surface_value: L5_SURFACE_VALUES.HIGH,
      cost_units: 1,
      fallback_used: false,
    };
  }
  if (sig === SIGNAL_TYPES.MEMORY_DRIFT) {
    return {
      decision: L5_DECISIONS.NEEDS_USER,
      rationale: `memory feedback (${record.project}/${record.memory_file}) ↔ plugin 동작 cross-check 필요`,
      user_surface_value: L5_SURFACE_VALUES.HIGH,
      cost_units: 1,
      fallback_used: false,
    };
  }
  if (sig === SIGNAL_TYPES.FORK_IMPORT_CANDIDATE) {
    return {
      decision: L5_DECISIONS.NEEDS_USER,
      rationale: `fork import-candidate (${record.fork}, score=${record.adjusted_score ?? record.baseline_score ?? "?"}) — import 결정 user 영역`,
      user_surface_value: L5_SURFACE_VALUES.MEDIUM,
      cost_units: 1,
      fallback_used: false,
    };
  }
  if ((sig === SIGNAL_TYPES.UPSTREAM_ISSUE || sig === SIGNAL_TYPES.UPSTREAM_PR) && verdict === VERDICTS.FIXED) {
    return {
      decision: L5_DECISIONS.SKIP,
      rationale: `${verdict} + already in fork — no action needed`,
      user_surface_value: L5_SURFACE_VALUES.NONE,
      cost_units: 1,
      fallback_used: false,
    };
  }
  return {
    decision: L5_DECISIONS.SKIP,
    rationale: "no matching policy (Phase 4 PoC stub) — Phase 4.5+ Codex pair 호출 시 강화",
    user_surface_value: L5_SURFACE_VALUES.LOW,
    cost_units: 1,
    fallback_used: false,
  };
}

/**
 * Cache entry 가 7d 안 인지 (live). Pure.
 *
 * @param {object} entry - cache entry { ts, dedupe_key }
 * @param {string} nowIso - reference now (testable)
 * @returns {boolean}
 */
export function isLive(entry, nowIso = new Date().toISOString()) {
  if (!entry || typeof entry.ts !== "string") return false;
  const ts = Date.parse(entry.ts);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false;
  const ageDays = (now - ts) / (24 * 60 * 60 * 1000);
  return ageDays < CACHE_TTL_DAYS;
}

/**
 * Cache prune — 7d 지난 entry 제거. Pure (새 array 반환).
 *
 * @param {object[]} entries
 * @param {string} nowIso
 * @returns {object[]}
 */
export function pruneCache(entries, nowIso = new Date().toISOString()) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((e) => isLive(e, nowIso));
}

/**
 * Build PR body markdown — R3-M2 schema:
 *   - verdict + signal_type
 *   - L5 의견 (decision / rationale / user_surface_value)
 *   - 증거 (paths, refs, evidence_checked)
 *   - rollback 가이드
 *   - dedupe_key
 *
 * @param {{ record, l5, dedupe_key }} input
 * @returns {string} markdown
 */
export function buildPRBody({ record, l5, dedupe_key } = {}) {
  if (!record) return "";
  const lines = [
    `## daily-evolve autonomous PR draft`,
    "",
    `> 생성: ${new Date().toISOString()} (Phase 4 PoC — Codex pair L5 heuristic stub)`,
    "",
    `## record`,
    `- verdict: ${record.verdict}`,
    `- signal_type: ${record.signal_type}`,
    `- title: ${record.title ?? record.issue_title ?? "?"}`,
  ];
  if (record.file) lines.push(`- file: ${record.file}${record.line ? ":" + record.line : ""}`);
  if (record.ref) lines.push(`- ref: ${record.ref}`);
  if (record.fork) lines.push(`- fork: ${record.fork} (${record.fork_url ?? "n/a"})`);
  lines.push("");
  lines.push(`## L5 의견 (Codex 협의 결과)`);
  lines.push(`- decision: \`${l5?.decision ?? "?"}\``);
  lines.push(`- rationale: ${l5?.rationale ?? "?"}`);
  lines.push(`- user_surface_value: ${l5?.user_surface_value ?? "?"}`);
  lines.push(`- cost_units: ${l5?.cost_units ?? "?"}${l5?.fallback_used ? " (fallback_used)" : ""}`);
  lines.push("");
  lines.push(`## dedupe_key`);
  lines.push(`\`${dedupe_key ?? "?"}\``);
  lines.push("");
  lines.push(`## rollback 가이드`);
  lines.push(`- 본 PR 은 \`draft\` 상태 + \`auto-merge\` label 부재 — review 통과 시만 merge`);
  lines.push(`- merge 후 7d 안 routine FP rate baseline × 1.5 초과 시 Phase 6 self-evolve 가 자동 rollback PR draft 생성`);
  lines.push(`- 수동 rollback: \`git revert <merge-commit-sha>\``);
  return lines.join("\n");
}
