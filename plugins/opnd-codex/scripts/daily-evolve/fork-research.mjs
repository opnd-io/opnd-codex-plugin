#!/usr/bin/env node
/**
 * fork-research.mjs — Phase 2 Active Fork Research orchestrator
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Active Forks Research 메커니즘
 *   - § Phase 2 — Active Fork Research + L7 Codex 가중치 조정
 *   - § R2-H1/H2, R3-M2, R3-L1
 *
 * 흐름:
 *   1. gh api .../forks (per_page=100)
 *   2. 각 fork 의 metadata (license / archived / stars / ahead_by 등) — 추가 API 호출 cost 통제
 *   3. License whitelist filter (Apache-2.0 / MIT / BSD-2/3)
 *   4. Active 정의 check (lib/fork-ranking.mjs isActive)
 *   5. Top N=10 candidate baseline score 계산 + L7 heuristic stub adjustment
 *   6. Top N=5 final 선정 → IMPORT-CANDIDATE record 변환
 *
 * API call budget ≤ 19/run (plan §HIGH-2):
 *   - forks list: 1
 *   - per fork compare: 1 × 5 = 5
 *   - per fork tarball (선택): orchestrator 가 cost 측정 후 결정
 *   - LICENSE check: forks list 응답에 license 포함, 추가 호출 0
 *   - ETag cache miss 보정: ≤ 3
 *   - 합계 ≤ 19
 *
 * Side effect 허용 (orchestrator): network (gh api) + filesystem (raw cache).
 * lib (fork-ranking / fork-tarball / cost-cap / cost-profile-registry) 는 pure.
 *
 * UTC ISO. zero npm. node 내장 + gh CLI subprocess.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  isActive,
  isLicenseCompatible,
  computeBaselineScore,
  applyL7Adjustment,
  selectTopN,
  TOP_N_CANDIDATES,
  TOP_N_FINAL,
  TOP_N_AUSTERITY,
} from "./lib/fork-ranking.mjs";
import { measureCost } from "./lib/cost-profile-registry.mjs";
import { SIGNAL_TYPES, VERDICTS } from "./lib/verdict-schema.mjs";

const UPSTREAM = "openai/codex-plugin-cc";
// API budget: 사용자 요청으로 default unlimited (Infinity). gh API rate limit
// (5000/h authenticated) 안 100 forks × 1 compare = 100 calls 매우 안전.
// 단 env var 로 명시 cap 가능 — production 환경 또는 큰 fork 수 (예: 1000+) 에서 안전망.
// 이전 default = 19 (Plan §R1 HIGH-2 보호용) — 사용자 평가 후 unlimited 로 완화.
const API_BUDGET_PER_RUN = Number.isFinite(Number(process.env.CODEX_PLUGIN_FORK_API_BUDGET))
  ? Number(process.env.CODEX_PLUGIN_FORK_API_BUDGET)
  : Infinity;
const FORK_TARBALL_MAX_BYTES = 100 * 1024 * 1024; // 100MB, plan §위험 요소
const L7_COST_BUDGET_RATIO = 0.30; // austerity trigger: 30% of daily budget

/**
 * gh api subprocess wrapper. 실패는 null + warning.
 *
 * @param {string[]} args - gh api args
 * @returns {object | null}
 */
function ghApi(args, options = {}) {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(`[fork-research] gh api ${args.join(" ")} failed: ${result.stderr?.slice(0, 200) ?? ""}\n`);
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    // Codex Phase 2 R2 M3 — JSON parse silent null observability gap. log + null.
    process.stderr.write(
      `[fork-research] gh api ${args.join(" ")} JSON parse fail: ${err?.message ?? String(err)} ` +
        `(stdout head: ${result.stdout?.slice(0, 80) ?? ""})\n`,
    );
    return null;
  }
}

/**
 * gh api fork list. 단일 API call.
 *
 * @returns {{ forks: object[], api_calls: number }}
 */
export function fetchForks() {
  const forks = ghApi([`repos/${UPSTREAM}/forks?per_page=100&sort=newest`]);
  return { forks: Array.isArray(forks) ? forks : [], api_calls: 1 };
}

/**
 * fork 단위 compare (ahead_by / behind_by + commits) — gh api compare.
 *
 * @param {string} forkFullName - e.g., "user/repo"
 * @returns {{ compare: object | null, api_calls: number }}
 */
export function fetchCompare(forkFullName) {
  const [forkOwner, forkRepo] = (forkFullName ?? "").split("/");
  if (!forkOwner || !forkRepo) return { compare: null, api_calls: 0 };
  const compare = ghApi([`repos/${UPSTREAM}/compare/main...${forkOwner}:main`]);
  return { compare, api_calls: 1 };
}

/**
 * fork metadata 보강 — compare 결과로 ahead_by / commit list / touched paths 채움.
 * Phase 2 PoC — non_vendor_diff_ratio 와 author_diversity 는 compare commits 기반 추정.
 *
 * @param {object} fork - gh forks list 의 fork object
 * @returns {{ enriched: object, api_calls: number }}
 */
export function enrichFork(fork) {
  const { compare, api_calls } = fetchCompare(fork.full_name);
  if (!compare) {
    return { enriched: { ...fork, ahead_by: 0, _enrich_failed: true }, api_calls };
  }
  const commits = Array.isArray(compare.commits) ? compare.commits : [];
  const files = Array.isArray(compare.files) ? compare.files : [];
  const authors = new Set(commits.map((c) => c?.author?.login ?? c?.commit?.author?.email ?? "?"));
  const touchedPaths = files.map((f) => ({
    path: f.filename ?? "",
    ts: commits[commits.length - 1]?.commit?.author?.date ?? fork.pushed_at,
  }));
  const uniqueTouchedPathCount = new Set(touchedPaths.map((t) => t.path)).size;
  // non_vendor_diff_ratio: lib/fork-tarball 의 nonVendorDiffRatio 와 동일 로직 (orchestrator inline)
  const nonVendorPaths = files.filter((f) => {
    const p = (f.filename ?? "").toLowerCase();
    return !/(^|\/)(node_modules|vendor|dist|build|coverage|target|__pycache__|\.venv)\//.test(p)
        && !/\.(lock|min\.\w+|bundle\.\w+|png|jpg|jpeg|gif|webp|pdf|zip|tar|gz|exe|dll|so|woff2?)$/.test(p);
  });
  const non_vendor_diff_ratio = files.length === 0 ? 0 : nonVendorPaths.length / files.length;
  return {
    enriched: {
      ...fork,
      ahead_by: compare.ahead_by ?? 0,
      behind_by: compare.behind_by ?? 0,
      author_diversity: authors.size,
      non_vendor_diff_ratio,
      _touched_paths: touchedPaths,
      _unique_touched_path_count: uniqueTouchedPathCount,
      _upstream_merge_age_days: estimateUpstreamMergeAge(compare),
    },
    api_calls,
  };
}

/**
 * upstream merge recency 추정 — compare base_commit 의 timestamp 기준.
 * Pure helper.
 */
function estimateUpstreamMergeAge(compare) {
  const base = compare?.base_commit?.commit?.author?.date ?? compare?.merge_base_commit?.commit?.author?.date;
  if (typeof base !== "string") return Infinity;
  const baseMs = Date.parse(base);
  if (!Number.isFinite(baseMs)) return Infinity;
  return (Date.now() - baseMs) / (24 * 60 * 60 * 1000);
}

/**
 * L7 Codex heuristic stub (Phase 2 PoC).
 * Actual Codex pair 호출은 Phase 2.5+ — `/opnd-codex:pair --output-profile decision-triage`.
 *
 * Heuristic 분류:
 *   - matching_plugin_paths ≥ 0.5 AND unique_touched_path_count ≥ 5 → boost (우리에게 가치 큰 patch)
 *   - upstream_merge_age_days ≥ 180 → demote (stale fork)
 *   - non_vendor_diff_ratio < 0.5 → demote (mass vendor change)
 *   - ahead_by ≥ 20 AND author_diversity ≥ 3 → maintain
 *   - 그 외 정보 부족 → insufficient_info
 *
 * @param {object} fork - enriched fork + axes
 * @returns {{ adjustment, factor, rationale, cost_units }}
 */
export function heuristicL7(fork, axes) {
  const cost = measureCost({ profileName: "decision-triage" });
  if (axes.matching >= 0.5 && fork._unique_touched_path_count >= 5) {
    return {
      adjustment: "boost",
      factor: 1.3,
      rationale: `matching=${axes.matching.toFixed(2)} + unique=${fork._unique_touched_path_count} (우리 영역과 겹침 + 새 패치)`,
      cost_units: cost.units,
    };
  }
  if (fork._upstream_merge_age_days >= 180) {
    return {
      adjustment: "demote",
      factor: 0.7,
      rationale: `upstream_merge_age=${fork._upstream_merge_age_days.toFixed(0)}d (stale)`,
      cost_units: cost.units,
    };
  }
  if (fork.non_vendor_diff_ratio < 0.5) {
    return {
      adjustment: "demote",
      factor: 0.7,
      rationale: `non_vendor_diff_ratio=${fork.non_vendor_diff_ratio.toFixed(2)} (vendor mass change 우려)`,
      cost_units: cost.units,
    };
  }
  if (fork.ahead_by >= 20 && fork.author_diversity >= 3) {
    return {
      adjustment: "maintain",
      factor: 1.0,
      rationale: `ahead=${fork.ahead_by} + authors=${fork.author_diversity} (active dev — baseline 신뢰)`,
      cost_units: cost.units,
    };
  }
  return {
    adjustment: "insufficient_info",
    factor: 1.0,
    rationale: "axes 정보 부족 — baseline 유지",
    cost_units: cost.units,
  };
}

/**
 * Main research entrypoint. orchestrator.
 *
 * @param {{ repoRoot, skipNetwork, nFinal }} opts
 * @returns {{
 *   records: object[],          // IMPORT-CANDIDATE signal_type
 *   research_summary: {
 *     total_forks, active_forks, license_skipped, top_candidates,
 *     api_calls, l7_calls, l7_cost_units, budget_exceeded, n_final
 *   }
 * }}
 */
export function research(opts = {}) {
  if (opts.skipNetwork) {
    return {
      records: [],
      research_summary: {
        total_forks: 0,
        active_forks: 0,
        license_skipped: 0,
        top_candidates: 0,
        api_calls: 0,
        l7_calls: 0,
        l7_cost_units: 0,
        budget_exceeded: false,
        n_final: 0,
        skipped: true,
        skip_reason: "skipNetwork option",
      },
    };
  }

  let apiCalls = 0;
  let l7Calls = 0;
  let l7CostUnits = 0;
  let budgetExceeded = false;

  // 1. fetch forks list
  const { forks, api_calls: listCalls } = fetchForks();
  apiCalls += listCalls;

  // 2. License filter (응답에 license 포함, 추가 호출 0)
  const licenseOk = forks.filter((f) => isLicenseCompatible(f?.license?.spdx_id));
  const licenseSkipped = forks.length - licenseOk.length;

  // 3. Codex Phase 2 R2 M2 — stars desc pre-sort: budget cap 도달 시 high-value fork
  // (별점 높은 것) 우선 enrich. 동점은 pushed_at desc tie-break (최신 활동 우선).
  const prioritized = [...licenseOk].sort((a, b) => {
    const sd = (b?.stargazers_count ?? 0) - (a?.stargazers_count ?? 0);
    if (sd !== 0) return sd;
    return (b?.pushed_at ?? "").localeCompare(a?.pushed_at ?? "");
  });

  // 4. Enrich (각 fork compare API call) — budget 안에서 처리. budget 초과 전 cutoff.
  const enriched = [];
  for (const fork of prioritized) {
    if (apiCalls >= API_BUDGET_PER_RUN) {
      budgetExceeded = true;
      break;
    }
    const { enriched: e, api_calls: ec } = enrichFork(fork);
    apiCalls += ec;
    enriched.push(e);
  }

  // 4. Active 정의 check
  const nowIso = new Date().toISOString();
  const active = enriched.filter((f) => isActive(f, nowIso).active);

  // 5. baseline score 계산 (모든 active)
  const scored = active.map((f) => {
    const baselineInput = {
      upstream_merge_age_days: f._upstream_merge_age_days,
      touched_paths: f._touched_paths,
      unique_touched_path_count: f._unique_touched_path_count,
      author_diversity: f.author_diversity,
      non_vendor_diff_ratio: f.non_vendor_diff_ratio,
    };
    const { total, axes } = computeBaselineScore(baselineInput);
    return { fork: f, baseline_score: total, axes };
  });

  // 6. Top N candidates → L7 호출 (Phase 2 PoC heuristic stub)
  const candidates = selectTopN(
    scored.map((s) => ({ ...s, score: s.baseline_score, stars: s.fork.stargazers_count ?? 0 })),
    TOP_N_CANDIDATES,
  );

  // Codex Phase 2 R2 M1 — Austerity trigger (Plan §L7 cost trigger):
  //   - forks 수 > 50 → N_AUSTERITY (10→3) 축소
  //   - (Phase 2.5+) cost_units 누적 > daily_budget × 0.30 — cost-cap baseline 통합 후 추가
  const austerityMode = forks.length > 50;
  const nForL7 = austerityMode ? TOP_N_AUSTERITY : TOP_N_CANDIDATES;

  const l7Results = candidates.slice(0, nForL7).map((c) => {
    const l7 = heuristicL7(c.fork, c.axes);
    l7Calls += 1;
    l7CostUnits += l7.cost_units;
    return {
      ...c,
      l7,
      adjusted_score: applyL7Adjustment(c.baseline_score, l7.adjustment),
    };
  });

  // 7. Final top N=5
  const finalTop = selectTopN(
    l7Results.map((r) => ({ ...r, score: r.adjusted_score, stars: r.fork.stargazers_count ?? 0 })),
    opts.nFinal ?? TOP_N_FINAL,
  );

  // 8. IMPORT-CANDIDATE record 변환
  const records = finalTop.map((r) => ({
    verdict: VERDICTS.NOT_FIXED, // 기본 — 우리에게 없는 patch
    signal_type: SIGNAL_TYPES.FORK_IMPORT_CANDIDATE,
    fork: r.fork.full_name,
    fork_url: r.fork.html_url,
    title: `${r.fork.full_name} (★${r.fork.stargazers_count ?? 0} / ahead=${r.fork.ahead_by})`,
    baseline_score: Number(r.baseline_score.toFixed(3)),
    adjusted_score: Number(r.adjusted_score.toFixed(3)),
    axes: {
      recency: Number(r.axes.recency.toFixed(2)),
      matching: Number(r.axes.matching.toFixed(2)),
      unique: Number(r.axes.unique.toFixed(2)),
      diversity: Number(r.axes.diversity.toFixed(2)),
      ratio: Number(r.axes.ratio.toFixed(2)),
    },
    l7: r.l7,
    unique_touched_path_count: r.fork._unique_touched_path_count,
    license: r.fork.license?.spdx_id ?? "?",
  }));

  return {
    records,
    research_summary: {
      total_forks: forks.length,
      active_forks: active.length,
      license_skipped: licenseSkipped,
      top_candidates: candidates.length,
      api_calls: apiCalls,
      l7_calls: l7Calls,
      l7_cost_units: l7CostUnits,
      api_budget: API_BUDGET_PER_RUN,
      budget_exceeded: Number.isFinite(API_BUDGET_PER_RUN) && budgetExceeded,
      n_final: finalTop.length,
      austerity_mode: austerityMode,
      skipped: false,
      skip_reason: null,
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const result = research();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
