#!/usr/bin/env node
/**
 * codex-triage.mjs — Phase 1 Codex L3 Triage Orchestrator
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 3 (Codex Triage Orchestrator)
 *   - § Phase 1 — Codex L3 통합
 *   - § L5/L7 Machine-Readable Contract (cost_units 단위)
 *   - § CLAUDE.md § User Decision Triage Protocol — N≥3 fan-out 시 Codex 1차 triage
 *
 * 입력: diff-analyzer.mjs 의 analyzed.records
 * 출력: 각 record 에 `triage` 필드 추가 (autonomous_safe / needs_user / needs_claude_judgment)
 *
 * 흐름:
 *   1. N < 3 → skip triage (모두 needs_user fallback, CLAUDE.md 룰)
 *   2. cost cap check (state/daily-evolve-cost-baseline.json)
 *      - exceeded → 모두 needs_user + skip_reason: cost_cap_exceeded
 *   3. Codex CLI available + 사용자 override 없으면 → Codex pair 호출 (Phase 1.5+)
 *      - Phase 1 PoC: heuristic stub (verdict 기반 분류)
 *   4. cost 누적 → cost-baseline append (lazy state create — 사용자 default #5)
 *
 * Side effect 허용 (orchestrator): filesystem read/write + subprocess (Codex CLI).
 * lib (triage-metric / cost-cap / cost-profile-registry) 는 pure.
 *
 * UTC ISO. zero npm. node 내장 + (선택) Codex CLI subprocess.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { VERDICTS } from "./lib/verdict-schema.mjs";
import {
  computeCap,
  appendBaseline,
  isCapExceeded,
  SKIP_REASONS,
  INITIAL_BASELINE_UNITS,
} from "./lib/cost-cap.mjs";
import { measureCost, COST_PROFILES } from "./lib/cost-profile-registry.mjs";
import { migrate, FAILURE_REASONS, MigrationError } from "./lib/state-migrator.mjs";

const COST_BASELINE_PATH = "state/daily-evolve-cost-baseline.json";
const FAN_OUT_THRESHOLD = 3;
const TRIAGE_DECISIONS = Object.freeze({
  AUTONOMOUS_SAFE: "autonomous_safe",
  NEEDS_USER: "needs_user",
  NEEDS_CLAUDE_JUDGMENT: "needs_claude_judgment",
});

/**
 * Heuristic triage stub — Phase 1 PoC. actual Codex 호출은 Phase 1.5+.
 *
 * 분류 룰 (verdict 기반):
 *   - FIXED        → autonomous_safe (no action)
 *   - WONTFIX      → autonomous_safe (drop)
 *   - PARTIAL      → needs_user (편입 여부 사용자 결정)
 *   - NOT-FIXED    → needs_user (백로그 편입 결정 + 우선순위)
 *   - QUESTION     → needs_claude_judgment (Claude 자체 처리 영역)
 *
 * @param {object} record
 * @returns {string} TRIAGE_DECISIONS value
 */
export function heuristicTriage(record) {
  switch (record?.verdict) {
    case VERDICTS.FIXED:
    case VERDICTS.WONTFIX:
      return TRIAGE_DECISIONS.AUTONOMOUS_SAFE;
    case VERDICTS.QUESTION:
      return TRIAGE_DECISIONS.NEEDS_CLAUDE_JUDGMENT;
    case VERDICTS.PARTIAL:
    case VERDICTS.NOT_FIXED:
    default:
      return TRIAGE_DECISIONS.NEEDS_USER;
  }
}

/**
 * Load cost baselines state. Lazy create (사용자 default #5 — state lazy create).
 * Schema migration 자동 (state-migrator).
 *
 * @param {string} repoRoot
 * @returns {{ schema_version: 1, baselines: Array<{ts, units}> }}
 */
export function loadBaselines(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, COST_BASELINE_PATH);
  if (!fs.existsSync(file)) {
    return { schema_version: 1, baselines: [] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // corrupt JSON — backup + new file (R3-H4)
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* best-effort backup */
    }
    process.stderr.write(
      `[codex-triage] cost-baseline corrupt — backup ${backup}, starting fresh\n`,
    );
    return { schema_version: 1, baselines: [] };
  }
  try {
    return migrate("daily-evolve-cost-baseline", data);
  } catch (err) {
    if (err instanceof MigrationError) {
      process.stderr.write(`[codex-triage] state migration error: ${err.message}\n`);
    }
    throw err;
  }
}

/**
 * Save cost baselines (atomic — temp + rename). Side effect.
 */
export function saveBaselines(state, repoRoot = process.cwd()) {
  const file = path.join(repoRoot, COST_BASELINE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Main triage entrypoint. Returns records with `triage` field appended +
 * skip_reason / cost_summary 메타.
 *
 * @param {object} analyzed - diff-analyzer output { records: [], ... }
 * @param {object} opts - { repoRoot, skipPersistence, profileName }
 * @returns {{
 *   records: object[],
 *   triage_summary: {
 *     fan_out: number,
 *     skipped: boolean,
 *     skip_reason: string | null,
 *     codex_called: boolean,
 *     cost_units: number,
 *     cost_source: string,
 *     cap: number,
 *     baseline_median: number
 *   }
 * }}
 */
export function triage(analyzed, opts = {}) {
  const records = Array.isArray(analyzed?.records) ? analyzed.records : [];
  const fanOut = records.length;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const profileName = opts.profileName ?? "decision-triage";

  // 1. N < 3 fan-out → skip Codex (CLAUDE.md 룰)
  if (fanOut < FAN_OUT_THRESHOLD) {
    return {
      records: records.map((r) => ({ ...r, triage: TRIAGE_DECISIONS.NEEDS_USER })),
      triage_summary: {
        fan_out: fanOut,
        skipped: true,
        skip_reason: SKIP_REASONS.SCOPE_EXCLUDED,
        skip_detail: `fan_out=${fanOut} < threshold=${FAN_OUT_THRESHOLD}`,
        codex_called: false,
        cost_units: 0,
        cost_source: "n/a",
        cap: 0,
        baseline_median: 0,
      },
    };
  }

  // 2. Cost cap check — baselines load + heuristic stub cost 산정
  const state = opts.skipPersistence ? { schema_version: 1, baselines: [] } : loadBaselines(repoRoot);

  // Phase 1 PoC: heuristic stub 이라 cost = profile fixed_unit. Phase 1.5+ actual Codex 호출 시
  // measureCost(usage) 직접 사용.
  const costResult = measureCost({ profileName });
  const cap = isCapExceeded({ currentUnits: costResult.units, baselines: state.baselines });

  if (cap.exceeded) {
    return {
      records: records.map((r) => ({ ...r, triage: TRIAGE_DECISIONS.NEEDS_USER })),
      triage_summary: {
        fan_out: fanOut,
        skipped: true,
        skip_reason: SKIP_REASONS.COST_CAP_EXCEEDED,
        skip_detail: `current=${cap.current} > cap=${cap.cap} (median × ${cap.cap / cap.baseline_median})`,
        codex_called: false,
        cost_units: 0,
        cost_source: costResult.source,
        cap: cap.cap,
        baseline_median: cap.baseline_median,
      },
    };
  }

  // 3. Triage 실행 — Phase 1 PoC 는 heuristic stub. Phase 1.5+ actual Codex 호출.
  const triagedRecords = records.map((r) => ({ ...r, triage: heuristicTriage(r) }));

  // 4. cost-baseline append (lazy state create — 사용자 default #5)
  if (!opts.skipPersistence) {
    const updated = appendBaseline(state.baselines, {
      ts: new Date().toISOString(),
      units: costResult.units,
    });
    saveBaselines({ schema_version: 1, baselines: updated }, repoRoot);
  }

  return {
    records: triagedRecords,
    triage_summary: {
      fan_out: fanOut,
      skipped: false,
      skip_reason: null,
      codex_called: false, // Phase 1 PoC stub (Phase 1.5+ actual Codex 호출 시 true)
      cost_units: costResult.units,
      cost_source: costResult.source,
      cap: cap.cap,
      baseline_median: cap.baseline_median,
    },
  };
}

export { TRIAGE_DECISIONS, FAN_OUT_THRESHOLD };

// CLI entry — `node codex-triage.mjs <analyzed.json>`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const inFile = process.argv[2];
  if (!inFile) {
    process.stderr.write("usage: codex-triage.mjs <analyzed.json>\n");
    process.exit(1);
  }
  const analyzed = JSON.parse(fs.readFileSync(inFile, "utf8"));
  const result = triage(analyzed);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
