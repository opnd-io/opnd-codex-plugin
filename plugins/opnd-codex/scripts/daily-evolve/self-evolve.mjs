#!/usr/bin/env node
/**
 * self-evolve.mjs — Phase 6 Self-Evolve Meta Loop orchestrator
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Component 6 (Self-Evolve Meta Loop)
 *   - § Phase 6 FP Baseline & Rollback (R3-H1)
 *   - § R4-M3 review_type CLI 인자 (--type weekly_normal | monthly_self_change)
 *
 * 흐름:
 *   1. weekly normal review trigger check (마지막 weekly ≥ 7d 경과?)
 *   2. Loop guard 검사 (self_review_depth ≤ 1 + recursive STOP)
 *   3. routine telemetry 수집 (runs-YYYY.json + cost-baseline + self-evolve-log)
 *   4. heuristic 조정 후보 도출 (L6 Codex pair 호출 또는 PoC stub)
 *   5. weekly report `docs/daily-evolve/_weekly/{YYYY-Www}.md` 작성
 *   6. log entry 추가 (state/daily-evolve-self-evolve-log.json)
 *   7. heuristic 조정 PR draft 후보는 decision=pending 으로 surface
 *
 * Phase 6 PoC = stub review entry + weekly report. Actual L6 Codex pair 호출과
 * heuristic 조정 PR draft 생성은 Phase 6.5+.
 *
 * Side effect 허용 (orchestrator): state IO + (Phase 6.5+) Codex CLI subprocess.
 * lib (self-evolve-policy / state-migrator / run-ledger) 는 pure.
 *
 * Node 내장 + (선택) gh CLI / Codex CLI subprocess.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  REVIEW_TYPE,
  DECISION,
  buildReviewEntry,
  shouldFireWeekly,
  checkLoopGuard,
  WEEKLY_TRIGGER_DAYS,
  MAX_SELF_REVIEW_DEPTH,
} from "./lib/self-evolve-policy.mjs";
import { migrate, MigrationError } from "./lib/state-migrator.mjs";
import { mergeLedgers, yearlyFilePath } from "./lib/run-ledger.mjs";

const LOG_STATE_PATH = "state/daily-evolve-self-evolve-log.json";
const WEEKLY_REPORT_DIR = "docs/daily-evolve/_weekly";
const LOG_SCHEMA_VERSION = 1;

/**
 * Load self-evolve log. Lazy create.
 */
export function loadLog(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, LOG_STATE_PATH);
  if (!fs.existsSync(file)) {
    return { schema_version: LOG_SCHEMA_VERSION, entries: [] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    try {
      fs.copyFileSync(file, backup);
    } catch {
      /* best-effort */
    }
    process.stderr.write(
      `[self-evolve] log corrupt — backup ${backup}, starting fresh (${err?.message ?? err})\n`,
    );
    return { schema_version: LOG_SCHEMA_VERSION, entries: [] };
  }
  try {
    return migrate("daily-evolve-self-evolve-log", data);
  } catch (err) {
    if (err instanceof MigrationError) {
      process.stderr.write(`[self-evolve] log migration: ${err.message}\n`);
    }
    throw err;
  }
}

/**
 * Save self-evolve log (atomic).
 */
export function saveLog(state, repoRoot = process.cwd()) {
  const file = path.join(repoRoot, LOG_STATE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Load runs ledger (current + previous year merge — last 2 years).
 */
export function loadRunsTelemetry(repoRoot = process.cwd()) {
  const ledgers = [];
  for (let yearOffset = 0; yearOffset >= -1; yearOffset--) {
    const year = new Date().getUTCFullYear() + yearOffset;
    const file = path.join(repoRoot, "state", `daily-evolve-runs-${year}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
      ledgers.push(ledger);
    } catch {
      /* skip corrupt */
    }
  }
  return mergeLedgers(ledgers);
}

/**
 * ISO week label (YYYY-Www) — pure for testing-friendliness.
 *
 * @param {string} iso
 * @returns {string}
 */
export function isoWeekLabel(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "?";
  // ISO week (월요일 시작) — Thursday-based 공식
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Build weekly report markdown.
 */
export function buildWeeklyReport({ entry, telemetry } = {}) {
  const lines = [];
  lines.push(`# Self-Evolve Weekly Report — ${isoWeekLabel(entry?.started_at ?? new Date().toISOString())}`);
  lines.push("");
  lines.push(`> review_id: \`${entry?.review_id ?? "?"}\``);
  lines.push(`> review_type: ${entry?.review_type ?? "?"}`);
  lines.push(`> started_at: ${entry?.started_at ?? "?"}`);
  lines.push(`> self_review_depth: ${entry?.self_review_depth ?? 0} / max ${MAX_SELF_REVIEW_DEPTH}`);
  lines.push("");
  lines.push(`## Routine Telemetry`);
  if (!Array.isArray(telemetry) || telemetry.length === 0) {
    lines.push(`_(no runs in last 2 years)_`);
  } else {
    lines.push(`- total runs: ${telemetry.length}`);
    const success = telemetry.filter((t) => t?.status === "success").length;
    const failure = telemetry.filter((t) => t?.status === "failure").length;
    const partial = telemetry.filter((t) => t?.status === "partial").length;
    lines.push(`- success / partial / failure: ${success} / ${partial} / ${failure}`);
    const durations = telemetry.map((t) => t?.duration_ms).filter((d) => Number.isFinite(d));
    if (durations.length > 0) {
      const sorted = [...durations].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      lines.push(`- duration_ms median: ${median}`);
    }
    const costs = telemetry.map((t) => t?.cost_units_consumed).filter((c) => Number.isFinite(c));
    if (costs.length > 0) {
      const totalCost = costs.reduce((a, b) => a + b, 0);
      lines.push(`- cost_units 누적: ${totalCost}`);
    }
  }
  lines.push("");
  lines.push(`## Proposed Heuristic Changes`);
  if (!Array.isArray(entry?.proposed_changes) || entry.proposed_changes.length === 0) {
    lines.push(`_(no proposals — Phase 6 PoC stub)_`);
  } else {
    for (const c of entry.proposed_changes) {
      lines.push(`- target: \`${c.target}\` — \`${c.old_value}\` → \`${c.new_value}\``);
      if (c.evidence) lines.push(`  evidence: ${c.evidence}`);
    }
  }
  lines.push("");
  lines.push(`## Decision`);
  lines.push(`- decision: \`${entry?.decision ?? "pending"}\``);
  if (entry?.pr_draft_url) lines.push(`- pr_draft_url: ${entry.pr_draft_url}`);
  if (entry?.rollback_target_review_id) {
    lines.push(`- rollback_target_review_id: \`${entry.rollback_target_review_id}\``);
  }
  lines.push("");
  lines.push(`## Loop Guard`);
  lines.push(`- self_review_depth ≤ ${MAX_SELF_REVIEW_DEPTH} 강제`);
  lines.push(`- 본 plan §Phase 6 — heuristic 조정은 항상 PR draft + 사용자 review 후만 적용`);
  return lines.join("\n");
}

/**
 * Main entrypoint.
 *
 * @param {{
 *   reviewType?: string,    // weekly_normal | monthly_self_change
 *   force?: boolean,        // trigger check 무시
 *   repoRoot?: string,
 *   skipPersistence?: boolean,
 *   nowIso?: string,
 * }} opts
 * @returns {{
 *   fired: boolean,
 *   reason: string,
 *   entry?: object,
 *   report?: string,
 *   guard?: object,
 * }}
 */
export function selfEvolve(opts = {}) {
  const reviewType = opts.reviewType ?? REVIEW_TYPE.WEEKLY_NORMAL;
  const repoRoot = opts.repoRoot ?? process.cwd();
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const log = opts.skipPersistence ? { schema_version: LOG_SCHEMA_VERSION, entries: [] } : loadLog(repoRoot);

  // 1. Trigger check
  if (!opts.force) {
    const trig = shouldFireWeekly(log, nowIso);
    if (!trig.fire) {
      return { fired: false, reason: trig.reason };
    }
  }

  // 2. Build entry skeleton
  const entry = buildReviewEntry({
    review_type: reviewType,
    started_at: nowIso,
    self_review_depth: 0, // 본 invocation 은 user-triggered 또는 weekly cron, depth=0
  });

  // 3. Loop guard
  const guard = checkLoopGuard(entry);
  if (!guard.allowed) {
    return { fired: false, reason: guard.reason, guard };
  }

  // 4. Routine telemetry 수집
  const telemetry = loadRunsTelemetry(repoRoot);

  // 5. Phase 6 PoC stub — actual L6 Codex pair 호출은 Phase 6.5+
  // proposed_changes 비움. weekly report 만 생성.
  entry.inputs.routine_telemetry = {
    exec_time_ms: telemetry.map((t) => t?.duration_ms).filter(Number.isFinite),
    codex_cost: telemetry.map((t) => t?.cost_units_consumed).filter(Number.isFinite),
    fp_rate: [], // Phase 6.5+ 에서 PR-별 attribution 후 채움
    triage_time_min: [],
  };
  entry.ended_at = new Date().toISOString();

  // 6. Build report
  const report = buildWeeklyReport({ entry, telemetry });

  // 7. Persist (weekly report md + log entry)
  if (!opts.skipPersistence) {
    const weeklyDir = path.join(repoRoot, WEEKLY_REPORT_DIR);
    fs.mkdirSync(weeklyDir, { recursive: true });
    const reportFile = path.join(weeklyDir, `${isoWeekLabel(nowIso)}.md`);
    fs.writeFileSync(reportFile, report + "\n");

    const updated = {
      schema_version: LOG_SCHEMA_VERSION,
      entries: [...(log.entries ?? []), entry],
    };
    saveLog(updated, repoRoot);
  }

  return { fired: true, reason: "trigger fired", entry, report, guard };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const typeIdx = process.argv.indexOf("--type");
  const reviewType = typeIdx >= 0 ? process.argv[typeIdx + 1] : REVIEW_TYPE.WEEKLY_NORMAL;
  const force = process.argv.includes("--force");
  const result = selfEvolve({ reviewType, force });
  process.stdout.write(JSON.stringify({ fired: result.fired, reason: result.reason }, null, 2) + "\n");
  if (result.report) {
    process.stderr.write("\n" + result.report + "\n");
  }
}
