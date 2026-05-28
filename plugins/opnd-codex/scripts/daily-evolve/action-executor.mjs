#!/usr/bin/env node
/**
 * action-executor.mjs — Phase 4 Action Executor + L5 협의 orchestrator
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 5 (Action Executor)
 *   - § Phase 4 — autonomous-safe → L5 → PR / needs_user / skip
 *   - § R2-H3 dedupe key + 7d cache (state/daily-evolve-pr-cache.json)
 *   - § R3-H3 5 PR 동시 cap + draft only + auto-merge X
 *
 * 흐름:
 *   1. records 중 triage=autonomous_safe filter
 *   2. 각 record 별 L5 협의 (action-policy.heuristicL5)
 *   3. PR cache (7d) prune + dedupe key 확인
 *   4. PR draft 후보 — `pr_draft` decision + cache miss + cap 안
 *   5. 결과: candidates / surfaced / skipped 분리 + cost 누적
 *
 * Phase 4 PoC = candidate 만 surface (실제 PR 생성 안 함). actual PR create 는
 * Phase 4.5+ — gh pr create --draft.
 *
 * Side effect 허용 (orchestrator): state file IO + (Phase 4.5+) gh pr create.
 * lib (action-policy / dedupe-key / state-migrator) 는 pure.
 *
 * Node 내장 + (선택) gh CLI subprocess.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  heuristicL5,
  pruneCache,
  buildPRBody,
  L5_DECISIONS,
  L5_SURFACE_VALUES,
  CACHE_TTL_DAYS,
  PR_CONCURRENT_CAP,
  PR_CACHE_SCHEMA_VERSION,
} from "./lib/action-policy.mjs";
import { computeDedupeKey } from "./lib/dedupe-key.mjs";
import { migrate, MigrationError } from "./lib/state-migrator.mjs";

const PR_CACHE_PATH = "state/daily-evolve-pr-cache.json";

/**
 * Load PR cache. Lazy create (사용자 default #5 — state lazy create).
 * Schema migration 자동 (state-migrator).
 *
 * @param {string} repoRoot
 * @returns {{ schema_version: 1, entries: Array<{ts, dedupe_key, ...}> }}
 */
export function loadCache(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, PR_CACHE_PATH);
  if (!fs.existsSync(file)) {
    return { schema_version: PR_CACHE_SCHEMA_VERSION, entries: [] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // R3-H4 corrupt JSON — backup + fresh
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* best-effort */
    }
    process.stderr.write(
      `[action-executor] pr-cache corrupt — backup ${backup}, starting fresh (${err?.message ?? err})\n`,
    );
    return { schema_version: PR_CACHE_SCHEMA_VERSION, entries: [] };
  }
  try {
    return migrate("daily-evolve-pr-cache", data);
  } catch (err) {
    if (err instanceof MigrationError) {
      process.stderr.write(`[action-executor] cache migration error: ${err.message}\n`);
    }
    throw err;
  }
}

/**
 * Save PR cache (atomic — temp + rename).
 */
export function saveCache(state, repoRoot = process.cwd()) {
  const file = path.join(repoRoot, PR_CACHE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Compute dedupe key from record (R3-M1 normalized_title 알고리즘).
 * paths normalization 은 dedupe-key 가 처리.
 */
export function recordDedupeKey(record) {
  const affectedPaths = [];
  if (typeof record?.file === "string") affectedPaths.push(record.file);
  if (typeof record?.ref === "string") affectedPaths.push(record.ref);
  if (typeof record?.memory_file === "string") affectedPaths.push(record.memory_file);
  if (typeof record?.fork === "string") affectedPaths.push(record.fork);
  return computeDedupeKey({
    signal_type: record?.signal_type,
    title: record?.title ?? record?.issue_title ?? "",
    affected_paths: affectedPaths,
    verdict: record?.verdict,
  });
}

/**
 * Main execute entrypoint.
 *
 * @param {{
 *   records: object[],
 *   repoRoot?: string,
 *   skipPersistence?: boolean,
 *   nowIso?: string,
 * }} input
 * @returns {{
 *   candidates: object[],     // pr_draft + cache miss + cap 안
 *   surfaced: object[],       // needs_user 또는 skip+high/medium surface_value
 *   skipped: object[],        // skip + low/none surface — digest 표시 안 함
 *   action_summary: object
 * }}
 */
export function execute(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const repoRoot = input.repoRoot ?? process.cwd();
  const nowIso = input.nowIso ?? new Date().toISOString();

  // 1. autonomous_safe filter
  const autonomousRecords = records.filter((r) => r?.triage === "autonomous_safe");

  // 2. Cache load + prune (7d TTL)
  const cacheState = input.skipPersistence
    ? { schema_version: PR_CACHE_SCHEMA_VERSION, entries: [] }
    : loadCache(repoRoot);
  const liveEntries = pruneCache(cacheState.entries ?? [], nowIso);
  const cachedKeys = new Set(liveEntries.map((e) => e?.dedupe_key));

  // 3. L5 협의 + dedupe + cap
  const candidates = [];
  const surfaced = [];
  const skipped = [];
  let totalCostUnits = 0;
  const newCacheEntries = [...liveEntries];

  for (const record of autonomousRecords) {
    const dedupe_key = recordDedupeKey(record);
    const l5 = heuristicL5(record);
    totalCostUnits += l5?.cost_units ?? 1;

    if (l5.decision === L5_DECISIONS.PR_DRAFT) {
      if (cachedKeys.has(dedupe_key)) {
        // 7d 안 동일 PR 후보 이미 처리 — skip
        skipped.push({ ...record, l5, dedupe_key, skip_reason: "dedupe_cached" });
        continue;
      }
      if (candidates.length >= PR_CONCURRENT_CAP) {
        // 5 cap 도달 — needs_user 로 strand
        surfaced.push({ ...record, l5: { ...l5, fallback_used: true }, dedupe_key, surface_reason: "pr_cap_exceeded" });
        continue;
      }
      const prBody = buildPRBody({ record, l5, dedupe_key });
      candidates.push({ ...record, l5, dedupe_key, pr_body: prBody });
      newCacheEntries.push({ ts: nowIso, dedupe_key, signal_type: record.signal_type, title: record.title ?? "" });
      cachedKeys.add(dedupe_key);
      continue;
    }

    if (l5.decision === L5_DECISIONS.NEEDS_USER) {
      surfaced.push({ ...record, l5, dedupe_key });
      continue;
    }

    // SKIP — but user_surface_value high/medium 이면 surface
    if (l5.user_surface_value === L5_SURFACE_VALUES.HIGH || l5.user_surface_value === L5_SURFACE_VALUES.MEDIUM) {
      surfaced.push({ ...record, l5, dedupe_key, surface_reason: "skip_with_value" });
    } else {
      skipped.push({ ...record, l5, dedupe_key, skip_reason: "low_value" });
    }
  }

  // 4. Cache persist
  if (!input.skipPersistence && newCacheEntries.length !== liveEntries.length) {
    saveCache({ schema_version: PR_CACHE_SCHEMA_VERSION, entries: newCacheEntries }, repoRoot);
  }

  return {
    candidates,
    surfaced,
    skipped,
    action_summary: {
      input_total: records.length,
      autonomous_input: autonomousRecords.length,
      candidates_count: candidates.length,
      surfaced_count: surfaced.length,
      skipped_count: skipped.length,
      cache_size_before: cacheState.entries?.length ?? 0,
      cache_size_after: newCacheEntries.length,
      cost_units: totalCostUnits,
      pr_cap: PR_CONCURRENT_CAP,
      cap_exceeded: surfaced.some((s) => s.surface_reason === "pr_cap_exceeded"),
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("usage: action-executor.mjs <triaged.json>\n");
    process.exit(1);
  }
  const triaged = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = execute({ records: triaged.records ?? [] });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
