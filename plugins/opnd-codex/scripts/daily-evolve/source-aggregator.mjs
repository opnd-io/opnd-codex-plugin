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
// M1 fix (Codex R1): 기존 `\.corrupt-\$\{ISO\}\.bak$` 는 literal `${ISO}` 만 매치 — 실제
// file path `.corrupt-2026-05-28T04-11-56-668Z.bak` 매치 안 됨. ISO timestamp 가 들어가는
// 모든 `.corrupt-*.bak` 경로 매치하도록 `.+` 사용.
const UNRELEASED_SELF_REFERENCE_RE =
  /^(docs\/daily-evolve\/|docs\/upstream-tracking\/|state\/|\.corrupt-.+\.bak$)/;

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
 * Phase 3 sub-source: memory diff — `~/.claude/projects/{본 project}/memory/feedback_*.md` scan.
 * MEMORY-DRIFT signal_type 후보 추출.
 *
 * Phase 0.5 fix — 본 plugin 의 project dir 만 scan (이전엔 ~/.claude/projects/* 전체 scan
 * 으로 다른 프로젝트 noise 60+건 surface). Claude Code 의 project hash 패턴:
 *   ~/.claude/projects/<sanitized-cwd-path>/memory/feedback_*.md
 *
 * sanitized = cwd 의 `\` `:` `/` 등을 `-` 로 치환. 본 cwd 의 hash dir 우선,
 * 매칭 안 되면 모든 project 의 feedback 중 본 plugin 키워드 (codex-plugin / daily-evolve /
 * opnd-codex) 포함 것만 surface (fallback).
 *
 * Best-effort: 디렉토리 부재 시 빈 배열. ENOENT 만 swallow.
 */
export function readMemoryFeedback(repoRoot = process.cwd()) {
  const memoryRoot = path.join(os.homedir(), ".claude", "projects");
  const out = [];
  if (!fs.existsSync(memoryRoot)) return out;

  // 본 cwd → Claude Code project hash 추정 (Windows: `D:\01.Work\...` → `D--01-Work-...`,
  // POSIX: `/Users/x/...` → `-Users-x-...`)
  const cwdHash = repoRoot.replace(/[\\/:]/g, "-").replace(/^-/, "");
  const PLUGIN_KEYWORDS = /\b(codex-plugin|daily-evolve|opnd-codex|opnd-io)\b/i;

  let projects;
  try {
    projects = fs.readdirSync(memoryRoot);
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }

  // 1순위: 본 cwd 정확 매칭 dir
  const ownProject = projects.find((p) => p === cwdHash || cwdHash.endsWith(p) || p.endsWith(cwdHash));
  const scanProjects = ownProject ? [ownProject] : projects;
  const fallbackMode = !ownProject;

  for (const proj of scanProjects) {
    const memDir = path.join(memoryRoot, proj, "memory");
    if (!fs.existsSync(memDir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(memDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^feedback[_-].*\.md$/i.test(entry)) continue;
      const full = path.join(memDir, entry);
      try {
        const stat = fs.statSync(full);
        const text = fs.readFileSync(full, "utf8");
        // fallback mode 면 plugin keyword 포함된 feedback 만 surface
        if (fallbackMode && !PLUGIN_KEYWORDS.test(text) && !PLUGIN_KEYWORDS.test(entry)) continue;
        out.push({
          project: proj,
          file: entry,
          modified_at: stat.mtime.toISOString(),
          size_bytes: stat.size,
          preview: text.slice(0, 500),
          scope: fallbackMode ? "keyword-match" : "own-project",
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  return out;
}

/**
 * Phase 3 sub-source: CHANGELOG Unreleased ↔ 코드 grep diff.
 * UNRELEASED-GAP signal_type — Unreleased 에 선언된 변경이 코드에 실제 반영됐는지.
 *
 * Heuristic (PoC):
 *   - CHANGELOG `## Unreleased` 블록 추출
 *   - 각 줄에서 ` `` ` 로 감싼 file path / 함수명 추출
 *   - 그 path/함수가 fork 코드 grep 1+ 매칭이면 reflected, 아니면 gap
 */
export function readUnreleasedGap(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, "plugins", "opnd-codex", "CHANGELOG.md");
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const unreleasedMatch = text.match(/##\s+Unreleased\s*\n([\s\S]+?)(?=\n##\s+\d|$)/);
  if (!unreleasedMatch) return [];
  const block = unreleasedMatch[1];
  // 백틱으로 감싼 path/identifier 추출 — `foo.mjs` / `dir/file.mjs` / `funcName`
  const refMatches = block.match(/`([^`]+)`/g) ?? [];
  const refs = [...new Set(refMatches.map((m) => m.replace(/`/g, "")))];
  const gaps = [];
  for (const ref of refs) {
    if (UNRELEASED_SELF_REFERENCE_RE.test(ref)) continue;
    if (ref.length < 3) continue;
    // path-like (slash 또는 dot 포함) 만 grep — naked identifier 는 noise 많음
    if (!/[./]/.test(ref)) continue;
    const grep = spawnSync(
      "grep",
      ["-rlF", "--include=*.mjs", "--include=*.md", ref, "plugins/opnd-codex", "tests"],
      { encoding: "utf8", cwd: repoRoot },
    );
    const matched = grep.status === 0 && grep.stdout.trim().length > 0;
    if (!matched) {
      gaps.push({ ref, matched: false });
    }
  }
  return gaps;
}

/**
 * Phase 3 sub-source: TODO/FIXME stale (>30d) scan.
 * TODO-STALE signal_type — TODO/FIXME 가 30d+ stale 이면 후보.
 */
export function readStaleTodos(repoRoot = process.cwd(), staleDays = RECENT_WINDOW_DAYS) {
  const grep = spawnSync(
    "grep",
    ["-rnE", "--include=*.mjs", "(TODO|FIXME)\\b", "plugins/opnd-codex/scripts"],
    { encoding: "utf8", cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  if (grep.status !== 0) return [];
  const hits = grep.stdout.split(/\r?\n/).filter((l) => l.length > 0);
  const staleMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  const stale = [];
  // git blame 으로 각 line 의 last-modified — 비싸지만 hit 수 제한적
  for (const hit of hits.slice(0, 100)) {
    // grep -n 출력: "path:line:body"
    const m = hit.match(/^([^:]+):(\d+):(.+)$/);
    if (!m) continue;
    const [, file, lineNoStr, body] = m;
    const lineNo = Number(lineNoStr);
    const blame = spawnSync(
      "git",
      ["blame", "-L", `${lineNo},${lineNo}`, "--porcelain", "--", file],
      { encoding: "utf8", cwd: repoRoot, maxBuffer: 1 * 1024 * 1024 },
    );
    if (blame.status !== 0) continue;
    const authorTime = blame.stdout.match(/^author-time\s+(\d+)/m);
    if (!authorTime) continue;
    const tsMs = Number(authorTime[1]) * 1000;
    if (Number.isFinite(tsMs) && tsMs < staleMs) {
      stale.push({
        file,
        line: lineNo,
        body: body.trim().slice(0, 200),
        author_time_ms: tsMs,
        age_days: Math.floor((Date.now() - tsMs) / (24 * 60 * 60 * 1000)),
      });
    }
  }
  return stale;
}

/**
 * Phase 3 sub-source: telemetry failure cluster.
 * UX-IMPROVEMENT signal_type — errorMessage top 5 cluster.
 */
export function readFailureCluster(telemetry) {
  if (!Array.isArray(telemetry)) return [];
  const failures = telemetry.filter(
    (e) => e?.event === "failed" || e?.event === "terminated",
  );
  const counts = new Map();
  for (const f of failures) {
    const key =
      (f?.extras?.errorMessage ?? f?.errorClass ?? "?")
        .toString()
        .slice(0, 200);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
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

  const telemetryData = safeCall(readTelemetry, "telemetry");
  const aggregated = {
    schema_version: SCHEMA_VERSION,
    aggregated_at: new Date().toISOString(),
    aggregated_for_date: dateStr,
    sources: {
      upstream_prs: safeCall(fetchUpstreamPRs, "upstream_prs"),
      upstream_issues: safeCall(fetchUpstreamIssues, "upstream_issues"),
      telemetry: telemetryData,
      // Phase 3 신규 sub-source (best-effort, network 무관)
      memory_feedback: safeCall(readMemoryFeedback, "memory_feedback"),
      unreleased_gap: safeCall(() => readUnreleasedGap(repoRoot), "unreleased_gap"),
      todo_stale: safeCall(() => readStaleTodos(repoRoot), "todo_stale"),
      failure_cluster: safeCall(
        () => readFailureCluster(Array.isArray(telemetryData) ? telemetryData : []),
        "failure_cluster",
      ),
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
