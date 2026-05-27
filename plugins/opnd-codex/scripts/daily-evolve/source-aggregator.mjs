#!/usr/bin/env node
/**
 * source-aggregator.mjs — daily-evolve Phase 0 source aggregator
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 1 (Source Aggregator)
 *   - Phase 0.2 — upstream PR/Issue + 우리 telemetry 수집 → raw.json
 *
 * Phase 0 (PoC) 에서는 2 source 만:
 *   - upstream PR + Issue (gh api repos/openai/codex-plugin-cc/{pulls,issues})
 *   - 우리 telemetry (events.jsonl, codex-efficiency-report.mjs 패턴 재활용)
 *
 * Phase 2+ 에서 active forks 추가, Phase 3 에서 memory/Unreleased/TODO 추가.
 *
 * Side effect 허용 (orchestrator) — filesystem write + gh CLI subprocess.
 * Lib dep rule (R2-L2): pure lib 들은 직접 사용 (verdict-schema 등),
 * fs / network IO 는 본 orchestrator 가 처리.
 *
 * UTC ISO 8601 엄격 비교 (R3 LOW-10).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

const UPSTREAM_REPO = "openai/codex-plugin-cc";
const RECENT_WINDOW_DAYS = 30;
const SCHEMA_VERSION = 1;

/**
 * Resolve telemetry events.jsonl path — codex-efficiency-report.mjs 와 동일 룰.
 * #338 namespaced: CODEX_PLUGIN_DATA_DIR 우선, fallback CLAUDE_PLUGIN_DATA, fallback tmpdir.
 */
export function resolveTelemetryPath() {
  const pluginData =
    process.env.CODEX_PLUGIN_DATA_DIR ??
    process.env.CLAUDE_PLUGIN_DATA ??
    path.join(os.tmpdir(), "codex-companion");
  return path.join(pluginData, "telemetry", "events.jsonl");
}

/**
 * Invoke `gh api <endpoint>` synchronously. Returns parsed JSON.
 * Caller 는 에러 catch 책임 (network down / 401 / rate limit 등).
 *
 * @param {string} endpoint - e.g. "repos/openai/codex-plugin-cc/pulls?state=open&per_page=100"
 * @returns {any} parsed JSON
 */
export function ghApi(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`gh api ${endpoint}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `gh api ${endpoint}: exit ${result.status} — ${result.stderr?.slice(0, 500) ?? "no stderr"}`,
    );
  }
  return JSON.parse(result.stdout);
}

/**
 * Filter records updated within last N days (UTC ISO 엄격 <).
 */
function withinRecentWindow(records, days = RECENT_WINDOW_DAYS) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();
  return records.filter((r) => typeof r.updated_at === "string" && r.updated_at >= sinceIso);
}

/**
 * Fetch upstream PRs — open all + recently closed (last 30d).
 * Note: GitHub Issues API 가 PR 을 동시 반환하므로 본 함수는 /pulls endpoint 만 사용.
 */
export function fetchUpstreamPRs() {
  const opens = ghApi(`repos/${UPSTREAM_REPO}/pulls?state=open&per_page=100&sort=updated&direction=desc`);
  const closeds = ghApi(`repos/${UPSTREAM_REPO}/pulls?state=closed&per_page=100&sort=updated&direction=desc`);
  const recentCloseds = withinRecentWindow(closeds);
  return [...opens, ...recentCloseds];
}

/**
 * Fetch upstream Issues — open all + recently closed (last 30d).
 * GitHub /issues endpoint 가 PR 도 반환하므로 `pull_request` 필드로 PR 제외.
 */
export function fetchUpstreamIssues() {
  const opens = ghApi(`repos/${UPSTREAM_REPO}/issues?state=open&per_page=100&sort=updated&direction=desc`);
  const closeds = ghApi(`repos/${UPSTREAM_REPO}/issues?state=closed&per_page=100&sort=updated&direction=desc`);
  const recentCloseds = withinRecentWindow(closeds);
  return [...opens, ...recentCloseds].filter((rec) => rec.pull_request == null);
}

/**
 * Read telemetry events.jsonl — codex-efficiency-report.mjs:14-23 패턴 그대로.
 */
export function readTelemetry() {
  const file = resolveTelemetryPath();
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return []; // 아직 telemetry 없음 (첫 실행)
    throw err;
  }
}

/**
 * Aggregate all sources for a given date (default: today UTC).
 * Writes `docs/upstream-tracking/{YYYY-MM-DD}/raw.json` (FULL tracked per 사용자 #1).
 *
 * @param {{ date?: string, outputRoot?: string, repoRoot?: string }} opts
 * @returns {object} aggregated raw object
 */
export function aggregate({ date, outputRoot = "docs/upstream-tracking", repoRoot = process.cwd() } = {}) {
  const dateStr = date ?? new Date().toISOString().slice(0, 10);
  const outDir = path.join(repoRoot, outputRoot, dateStr);
  fs.mkdirSync(outDir, { recursive: true });

  const aggregated = {
    schema_version: SCHEMA_VERSION,
    aggregated_at: new Date().toISOString(),
    aggregated_for_date: dateStr,
    sources: {
      upstream_prs: safeCall(fetchUpstreamPRs, "upstream_prs"),
      upstream_issues: safeCall(fetchUpstreamIssues, "upstream_issues"),
      telemetry: safeCall(readTelemetry, "telemetry"),
    },
    errors: [],
  };

  // Surface partial errors so caller (diff-analyzer / digest-writer) can degrade gracefully.
  for (const [key, value] of Object.entries(aggregated.sources)) {
    if (value && value.__error) {
      aggregated.errors.push({ source: key, message: value.__error });
      aggregated.sources[key] = [];
    }
  }

  const outFile = path.join(outDir, "raw.json");
  fs.writeFileSync(outFile, JSON.stringify(aggregated, null, 2) + "\n");
  return aggregated;
}

function safeCall(fn, label) {
  try {
    return fn();
  } catch (err) {
    return { __error: `${label}: ${err.message}` };
  }
}

// CLI entry — `node source-aggregator.mjs [YYYY-MM-DD]`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const dateArg = process.argv[2];
  const result = aggregate({ date: dateArg });
  const counts = {
    prs: result.sources.upstream_prs.length,
    issues: result.sources.upstream_issues.length,
    telemetry: result.sources.telemetry.length,
    errors: result.errors.length,
  };
  process.stdout.write(
    `[source-aggregator] ${result.aggregated_for_date}: ${JSON.stringify(counts)}\n`,
  );
  if (counts.errors > 0) process.exit(2); // partial 실패 — caller 가 인지 가능
}
