#!/usr/bin/env node
/**
 * digest-writer.mjs — daily-evolve Phase 0 digest markdown writer
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § 접근법 Component 4 (Daily Digest Writer L4)
 *   - Phase 0.4 — `docs/daily-evolve/{YYYY-MM-DD}.md` 생성
 *   - R3-M5 cognitive load metadata header (decision_count / estimated_reading_minutes / manual_actions_required)
 *   - R3-M6 last_3_runs header (run-ledger 통합)
 *   - R5-L10 no_changes / failures / run_status 별도 섹션
 *   - R3-M3 citation check pass (lib/citation-check.mjs)
 *   - Output Discipline ≤500줄 (CLAUDE.md)
 *
 * Phase 0 PoC: Codex citation 없이 record listing 만. Phase 1+ 에서 Codex L3 triage 결과
 * 인용 추가, citation-check 가 fail-closed 검증.
 *
 * Side effect 허용 (orchestrator): filesystem read (state/runs) + write (digest md).
 * lib (verdict-schema / run-ledger / citation-check) 는 pure — 본 orchestrator 가 IO.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { VERDICTS } from "./lib/verdict-schema.mjs";
import { queryLastN } from "./lib/run-ledger.mjs";
import { checkCitations } from "./lib/citation-check.mjs";
import { buildMetricHeader, formatMetricHeader } from "./lib/triage-metric.mjs";
import { redactAll } from "./lib/pii-redact.mjs";

/** PII 가 surface 가능한 record field — 외부 출력 전 redact 필수. */
const PII_REDACT_FIELDS = ["preview", "body", "error_message", "title"];

const DIGEST_DIR = "docs/daily-evolve";
const MAX_DIGEST_LINES = 500;
const READING_SECONDS_PER_RECORD = 30; // 30s per record estimate
const TIER_ORDER = Object.freeze([
  VERDICTS.NOT_FIXED,
  VERDICTS.PARTIAL,
  VERDICTS.FIXED,
  VERDICTS.QUESTION,
  VERDICTS.WONTFIX,
]);

/**
 * Group records by (verdict, signal_type) pair. Pure helper for digest layout.
 */
function groupRecords(records) {
  const groups = {};
  for (const r of records) {
    const key = `${r.verdict}::${r.signal_type}`;
    if (!groups[key]) {
      groups[key] = { verdict: r.verdict, signal_type: r.signal_type, records: [] };
    }
    groups[key].records.push(r);
  }
  return groups;
}

/**
 * Compute cognitive load metric (R3-M5).
 *   - decision_count = actionable items (NOT-FIXED + PARTIAL — 사용자 결정 필요)
 *   - estimated_reading_minutes = ceil(records × 30s / 60)
 *   - manual_actions_required = decision_count (Phase 0 stub — Phase 1+ 에서 Codex triage 결과로 세분화)
 */
export function computeMetrics(records) {
  const actionable = records.filter(
    (r) => r.verdict === VERDICTS.NOT_FIXED || r.verdict === VERDICTS.PARTIAL,
  );
  return {
    decision_count: actionable.length,
    estimated_reading_minutes: Math.max(
      1,
      Math.ceil((records.length * READING_SECONDS_PER_RECORD) / 60),
    ),
    manual_actions_required: actionable.length,
  };
}

/**
 * Load current-year ledger and return last N runs. Returns [] if file missing or corrupt.
 */
export function loadLastRuns(repoRoot, n = 3) {
  const year = new Date().toISOString().slice(0, 4);
  const file = path.join(repoRoot, "state", `daily-evolve-runs-${year}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const ledger = JSON.parse(fs.readFileSync(file, "utf8"));
    return queryLastN(ledger, n);
  } catch {
    return [];
  }
}

/**
 * Apply ≤500 line cap (Output Discipline). Returns truncated lines if exceeded.
 */
function applyLineCap(lines) {
  if (lines.length <= MAX_DIGEST_LINES) return lines;
  const truncated = lines.slice(0, MAX_DIGEST_LINES - 4);
  truncated.push("");
  truncated.push("---");
  truncated.push(
    `_(${lines.length - MAX_DIGEST_LINES + 4}줄 truncated — 전체는 raw.json + analyzed.json 참조)_`,
  );
  truncated.push("");
  return truncated;
}

/**
 * Write daily digest markdown.
 *
 * @param {{
 *   analyzed: { records: object[], analyzed_at: string },
 *   raw: { aggregated_at: string, errors?: object[] },
 *   citations?: Array<{ agentId, line_ref, quoted_text }>,
 *   transcripts?: Record<string, { agentId, lines }>,
 *   repoRoot?: string,
 *   date?: string
 * }} input
 * @returns {{ outFile: string, lineCount: number, metrics: object, citationResult: object }}
 */
export function write({
  analyzed,
  raw,
  citations = [],
  transcripts = {},
  repoRoot = process.cwd(),
  date,
  triageSummary = null,
  forkSummary = null,
  actionSummary = null,
  actionCandidates = null,
  authHealthFailureMessage = null,
} = {}) {
  const dateStr = date ?? new Date().toISOString().slice(0, 10);
  const outDir = path.join(repoRoot, DIGEST_DIR);
  fs.mkdirSync(outDir, { recursive: true });

  // Phase 3 — Records 의 PII 가능 field redact (memory preview, telemetry errorMessage 등).
  // immutable: 새 array + 새 record 객체.
  const rawRecords = analyzed?.records ?? [];
  let totalPiiHits = { email: 0, token: 0, path: 0 };
  const records = rawRecords.map((r) => {
    if (!r || typeof r !== "object") return r;
    let redacted = r;
    let mutated = false;
    for (const field of PII_REDACT_FIELDS) {
      const val = r[field];
      if (typeof val !== "string") continue;
      const { redacted: rOut, hits } = redactAll(val);
      if (hits.email + hits.token + hits.path > 0) {
        totalPiiHits.email += hits.email;
        totalPiiHits.token += hits.token;
        totalPiiHits.path += hits.path;
        if (!mutated) {
          redacted = { ...r };
          mutated = true;
        }
        redacted[field] = rOut;
      }
    }
    return redacted;
  });
  const metrics = computeMetrics(records);
  const lastRuns = loadLastRuns(repoRoot);
  const citationResult = checkCitations({ citations, transcripts });

  let lines = [];

  // === Header ===
  lines.push(`# Daily Evolve Digest — ${dateStr}`);
  lines.push("");
  lines.push(`> 생성: ${new Date().toISOString()}`);
  let phaseLabel;
  if (actionSummary) {
    phaseLabel = "0-4 (7-source + L3 triage + active fork + L5 action executor)";
  } else if (forkSummary) {
    phaseLabel = "0-3 (7-source + L3 triage + active fork)";
  } else if (triageSummary) {
    phaseLabel = "0-1 (source 2 + Codex L3 triage)";
  } else {
    phaseLabel = "0 PoC (source 2개 — upstream PR/Issue + telemetry)";
  }
  lines.push(`> Phase: ${phaseLabel}`);
  lines.push("");

  // === Cognitive Load metadata (R3-M5 + Phase 1 triage 통합) ===
  // Codex Phase 1 review M2 — metric 계산은 final markdown 기준. records 추가 후 2-pass 로
  // placeholder 자리에 final metric insert.
  lines.push("## Cognitive Load");
  const COGNITIVE_PLACEHOLDER = "__DAILY_EVOLVE_COGNITIVE_PLACEHOLDER__";
  const cognitivePlaceholderIdx = lines.length;
  lines.push(COGNITIVE_PLACEHOLDER);
  lines.push("");

  // === last_3_runs header (R3-M6) ===
  lines.push("## last_3_runs");
  if (lastRuns.length === 0) {
    lines.push("_(no previous runs)_");
  } else {
    for (const r of lastRuns) {
      const dur = r.duration_ms != null ? `${r.duration_ms}ms` : "running";
      lines.push(
        `- ${r.started_at} — status=${r.status}, ${dur}, actionable=${r.actionable_count ?? "?"}`,
      );
    }
  }
  lines.push("");

  // === failures 섹션 (R5-L10 분리) ===
  const errors = raw?.errors ?? [];
  const piiHitsTotal = totalPiiHits.email + totalPiiHits.token + totalPiiHits.path;
  // Phase 1.5a — auth health 실패 메시지 surface
  const hasAuthFailure = typeof authHealthFailureMessage === "string" && authHealthFailureMessage.length > 0;
  const hasFailures = errors.length > 0 || !citationResult.passed || hasAuthFailure;
  if (piiHitsTotal > 0) {
    // PII redact 발생 — failures 가 아니라 별도 notice
  }
  lines.push("## failures");
  if (!hasFailures) {
    lines.push("_(no failures)_");
  } else {
    if (hasAuthFailure) {
      lines.push(`- ⚠ ${authHealthFailureMessage}`);
    }
    for (const e of errors) {
      lines.push(`- source \`${e.source}\`: ${e.message}`);
    }
    for (const f of citationResult.failures) {
      lines.push(
        `- citation fail: reason=${f.reason} (agentId=${f.citation?.agentId ?? "n/a"}, line_ref=${f.citation?.line_ref ?? "n/a"})`,
      );
    }
  }
  lines.push("");

  // === Records 분류 or no_changes (R5-L10) ===
  if (records.length === 0) {
    lines.push("## no_changes");
    lines.push("_(no signals detected today)_");
    lines.push("");
  } else {
    const groups = groupRecords(records);
    for (const verdict of TIER_ORDER) {
      const matches = Object.values(groups).filter((g) => g.verdict === verdict);
      if (matches.length === 0) continue;
      lines.push(`## ${verdict}`);
      for (const grp of matches) {
        lines.push(`### ${grp.signal_type} (${grp.records.length})`);
        for (const r of grp.records.slice(0, 20)) {
          const ref = r.issue_ref ?? "";
          const title = r.issue_title ?? r.title ?? "";
          lines.push(`- ${ref} ${title}`.trim());
        }
        if (grp.records.length > 20) {
          lines.push(`- _(${grp.records.length - 20}개 항목 더 — analyzed.json 참조)_`);
        }
        lines.push("");
      }
    }
  }

  // === Pass 2: final metric 계산 + placeholder replace (Codex Phase 1 review M2) ===
  // records 섹션까지 모두 추가된 후의 markdown 기준으로 estimateReadingMinutes 계산.
  const cognitiveLines = [];
  if (triageSummary && Array.isArray(records)) {
    // Phase 1+ — triage-metric lib (decision_count by triage 3분류 + reading_minutes)
    const finalMarkdown = lines.join("\n");
    const metricHeader = buildMetricHeader({ records, markdown: finalMarkdown });
    cognitiveLines.push(formatMetricHeader(metricHeader));
    cognitiveLines.push("");
    cognitiveLines.push("### Codex L3 Triage Summary");
    cognitiveLines.push(`- fan_out: ${triageSummary.fan_out}`);
    cognitiveLines.push(`- skipped: ${triageSummary.skipped}`);
    if (triageSummary.skip_reason) cognitiveLines.push(`- skip_reason: ${triageSummary.skip_reason}`);
    if (triageSummary.skip_detail) cognitiveLines.push(`- skip_detail: ${triageSummary.skip_detail}`);
    cognitiveLines.push(`- codex_called: ${triageSummary.codex_called}`);
    cognitiveLines.push(`- cost_units: ${triageSummary.cost_units} (source=${triageSummary.cost_source})`);
    if (triageSummary.cost_units_blocked != null) {
      cognitiveLines.push(`- cost_units_blocked: ${triageSummary.cost_units_blocked} (차단된 예상 비용)`);
    }
    cognitiveLines.push(`- cap: ${triageSummary.cap} (baseline_median=${triageSummary.baseline_median})`);

    if (actionSummary) {
      cognitiveLines.push("");
      cognitiveLines.push("### Phase 4 Action Executor Summary");
      cognitiveLines.push(`- input_total: ${actionSummary.input_total}`);
      cognitiveLines.push(`- autonomous_input: ${actionSummary.autonomous_input}`);
      cognitiveLines.push(`- candidates: ${actionSummary.candidates_count} / ${actionSummary.pr_cap} cap${actionSummary.cap_exceeded ? " (⚠ exceeded)" : ""}`);
      cognitiveLines.push(`- surfaced: ${actionSummary.surfaced_count} (needs_user / skip-with-value)`);
      cognitiveLines.push(`- skipped: ${actionSummary.skipped_count}`);
      cognitiveLines.push(`- cost_units: ${actionSummary.cost_units}`);
      cognitiveLines.push(`- cache: ${actionSummary.cache_size_before} → ${actionSummary.cache_size_after} entries`);
      if (Array.isArray(actionCandidates) && actionCandidates.length > 0) {
        cognitiveLines.push("");
        cognitiveLines.push("#### PR draft candidates");
        for (const c of actionCandidates) {
          cognitiveLines.push(`- \`${c.dedupe_key?.slice(0, 12) ?? "?"}\` — ${c.title ?? c.l5?.rationale ?? "?"}`);
        }
      }
    }
    if (forkSummary) {
      cognitiveLines.push("");
      cognitiveLines.push("### Phase 2 Active Fork Research Summary");
      cognitiveLines.push(`- total_forks: ${forkSummary.total_forks}`);
      cognitiveLines.push(`- license_skipped: ${forkSummary.license_skipped}`);
      cognitiveLines.push(`- active_forks: ${forkSummary.active_forks}`);
      cognitiveLines.push(`- top_candidates: ${forkSummary.top_candidates} (L7 호출 ${forkSummary.l7_calls})`);
      cognitiveLines.push(`- l7_cost_units: ${forkSummary.l7_cost_units}`);
      // Phase 0.5 fix — budget Infinity (unlimited) 시 stale "19 budget" 표시 회피.
      const budgetLabel = Number.isFinite(forkSummary.api_budget)
        ? `${forkSummary.api_calls} / ${forkSummary.api_budget} budget${forkSummary.budget_exceeded ? " (⚠ exceeded)" : ""}`
        : `${forkSummary.api_calls} (unlimited — env CODEX_PLUGIN_FORK_API_BUDGET 으로 cap 가능)`;
      cognitiveLines.push(`- api_calls: ${budgetLabel}`);
      cognitiveLines.push(`- n_final: ${forkSummary.n_final}${forkSummary.austerity_mode ? " (austerity mode)" : ""}`);
      if (forkSummary.skipped) {
        cognitiveLines.push(`- skipped: ${forkSummary.skip_reason}`);
      }
    }
  } else {
    // Phase 0 — simple metric (NOT-FIXED + PARTIAL count)
    cognitiveLines.push(`- decision_count: ${metrics.decision_count}`);
    cognitiveLines.push(`- estimated_reading_minutes: ${metrics.estimated_reading_minutes}`);
    cognitiveLines.push(`- manual_actions_required: ${metrics.manual_actions_required}`);
  }
  // splice in place of placeholder (1 line) — 모든 cognitiveLines 로 replace
  lines.splice(cognitivePlaceholderIdx, 1, ...cognitiveLines);

  // === Apply ≤500줄 cap ===
  lines = applyLineCap(lines);

  const outFile = path.join(outDir, `${dateStr}.md`);
  fs.writeFileSync(outFile, lines.join("\n") + "\n");

  return { outFile, lineCount: lines.length, metrics, citationResult };
}

// CLI entry — `node digest-writer.mjs <analyzed.json> [raw.json]`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const analyzedFile = process.argv[2];
  const rawFile = process.argv[3];
  if (!analyzedFile) {
    process.stderr.write("usage: digest-writer.mjs <analyzed.json> [raw.json]\n");
    process.exit(1);
  }
  const analyzed = JSON.parse(fs.readFileSync(analyzedFile, "utf8"));
  const raw = rawFile ? JSON.parse(fs.readFileSync(rawFile, "utf8")) : {};
  const result = write({ analyzed, raw });
  process.stdout.write(
    `[digest-writer] ${result.outFile} (${result.lineCount} lines, decision_count=${result.metrics.decision_count})\n`,
  );
}
