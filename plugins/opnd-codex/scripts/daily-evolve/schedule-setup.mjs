#!/usr/bin/env node
/**
 * schedule-setup.mjs — Phase 5.0 env probe + Phase 5 자동화 등록 helper
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Phase 5.0 BLOCKING — env probe
 *   - § Phase 5 — `scheduled-tasks` MCP 등록 morning 9 KST
 *   - § R3-H2 enum branch (UTC_AWARE / LOCAL_TZ_ONLY / MCP_UNAVAILABLE / UNKNOWN)
 *
 * 동작:
 *   1. probe: `scheduled-tasks` MCP 설치 + cron timezone API 지원 + 머신 TZ
 *   2. scheduler_status 결정 + state/daily-evolve-env-probe.json 기록 (atomic)
 *   3. branch 별 registration guidance 출력 (실제 등록은 사용자 manual or MCP API call)
 *
 * 자동 등록은 Phase 5 PoC 에선 NOT 수행 — MCP API call 이 사용자 환경마다 다름.
 * 본 script 는 probe + 가이드까지. Phase 5.5+ 에서 자동 등록.
 *
 * Side effect 허용 (orchestrator): filesystem (state) + (선택) MCP API call.
 * lib (env-probe) 는 pure.
 *
 * Node 내장 + (선택) subprocess.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  buildProbeResult,
  validateProbe,
  kstNineToLocalCron,
  hasDstRisk,
  SCHEDULER_STATUS,
  ENV_PROBE_SCHEMA_VERSION,
} from "./lib/env-probe.mjs";
import { migrate, MigrationError } from "./lib/state-migrator.mjs";

const PROBE_STATE_PATH = "state/daily-evolve-env-probe.json";

/**
 * Detect MCP installation — `claude mcp list` 또는 동등 query. Best-effort.
 *
 * @returns {{ installed: boolean, raw: string | null }}
 */
export function probeMcpInstalled() {
  // 1순위: claude CLI 의 mcp list — 사용자 환경에 따라 다름. 실패 시 null.
  const result = spawnSync("claude", ["mcp", "list"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { installed: false, raw: null };
  }
  const out = result.stdout ?? "";
  const installed = /scheduled-tasks/i.test(out);
  return { installed, raw: out.slice(0, 500) };
}

/**
 * MCP cron timezone 지원 여부 — docs / API spec 에 CRON_TZ / timezone field 검색.
 * Phase 5 PoC: 미지원 default (LOCAL_TZ_ONLY) — Phase 5.5+ 에서 정확 probe.
 *
 * @returns {{ supported: boolean | null, docs_found: boolean }}
 */
export function probeCronTzSupport() {
  // Phase 5 PoC: heuristic — `claude mcp inspect scheduled-tasks` 같은 명령 없음.
  // CLI 가 cron 표현식만 받으면 LOCAL_TZ_ONLY 가정.
  return { supported: null, docs_found: false };
}

/**
 * Machine TZ probe — Intl.DateTimeFormat 의 resolvedOptions.timeZone + offset.
 *
 * @returns {{ tz: string, offsetMinutes: number }}
 */
export function probeMachineTz() {
  let tz = "?";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "?";
  } catch {
    /* fallback */
  }
  // offsetMinutes: -now.getTimezoneOffset() 가 UTC 기준 offset (e.g., KST = +540)
  const offsetMinutes = -new Date().getTimezoneOffset();
  return { tz, offsetMinutes };
}

/**
 * Load env-probe state. Lazy create (사용자 default #5).
 */
export function loadProbeState(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, PROBE_STATE_PATH);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return migrate("daily-evolve-env-probe", data);
  } catch (err) {
    if (err instanceof MigrationError) {
      process.stderr.write(`[schedule-setup] probe state migration: ${err.message}\n`);
    } else {
      process.stderr.write(`[schedule-setup] probe state load: ${err?.message ?? err}\n`);
    }
    return null;
  }
}

/**
 * Save probe state (atomic).
 */
export function saveProbeState(probe, repoRoot = process.cwd()) {
  const file = path.join(repoRoot, PROBE_STATE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(probe, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Main probe entry — run all probes + persist + return result with guidance.
 *
 * @param {{ repoRoot?: string, skipPersistence?: boolean }} opts
 * @returns {{ probe: object, guidance: string[] }}
 */
export function probeAndRegister(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const mcp = probeMcpInstalled();
  const tz = probeCronTzSupport();
  const machine = probeMachineTz();

  const probe = buildProbeResult({
    mcp_installed: mcp.installed,
    mcp_cron_api_docs_found: tz.docs_found,
    cron_tz_supported: tz.supported,
    user_machine_tz: machine.tz,
    machine_offset_minutes: machine.offsetMinutes,
  });

  const validation = validateProbe(probe);
  if (!validation.ok) {
    process.stderr.write(`[schedule-setup] probe invalid: ${validation.errors.join("; ")}\n`);
  }

  if (!opts.skipPersistence) {
    saveProbeState(probe, repoRoot);
  }

  const guidance = buildGuidance(probe);
  return { probe, guidance };
}

/**
 * Build guidance lines per scheduler_status. Pure.
 *
 * @param {object} probe
 * @returns {string[]}
 */
export function buildGuidance(probe) {
  const lines = [];
  const status = probe?.scheduler_status;
  const machineOffsetMinutes = probe?.machine_offset_minutes ?? 0;
  const { cron: machineCron } = kstNineToLocalCron(machineOffsetMinutes);
  const dst = hasDstRisk(probe?.user_machine_tz ?? "");

  lines.push(`scheduler_status: ${status}`);
  lines.push(`user_machine_tz: ${probe?.user_machine_tz ?? "?"} (offset=${machineOffsetMinutes}min)`);

  switch (status) {
    case SCHEDULER_STATUS.UTC_AWARE:
      lines.push(``);
      lines.push(`등록 명령 (예시):`);
      lines.push(`  claude mcp call scheduled-tasks create \\`);
      lines.push(`    --name daily-evolve \\`);
      lines.push(`    --cron "CRON_TZ=UTC 0 0 * * *" \\`);
      lines.push(`    --command "/opnd-codex:daily-evolve --phase 4"`);
      break;

    case SCHEDULER_STATUS.LOCAL_TZ_ONLY:
      lines.push(``);
      lines.push(`등록 명령 (예시 — local TZ 기준 ${machineCron}):`);
      lines.push(`  claude mcp call scheduled-tasks create \\`);
      lines.push(`    --name daily-evolve \\`);
      lines.push(`    --cron "${machineCron}" \\`);
      lines.push(`    --command "/opnd-codex:daily-evolve --phase 4"`);
      if (dst) {
        lines.push(``);
        lines.push(`⚠ DST risk — 봄/가을 전환 시 1h drift. mitigation:`);
        lines.push(`   매월 1회 \`schedule-setup --reprobe\` 권장`);
      }
      break;

    case SCHEDULER_STATUS.MCP_UNAVAILABLE:
      lines.push(``);
      lines.push(`MCP 미설치 — cron fallback 권장:`);
      lines.push(`  bash scripts/daily-evolve/cron-fallback.sh install`);
      lines.push(``);
      lines.push(`또는 사용자 OS cron 직접 등록:`);
      lines.push(`  (crontab -l 2>/dev/null; echo "${machineCron} cd $(pwd) && /opnd-codex:daily-evolve --phase 4") | crontab -`);
      break;

    case SCHEDULER_STATUS.UNKNOWN:
    default:
      lines.push(``);
      lines.push(`⚠ probe 결과 불명확 — Phase 5 진입 BLOCKING`);
      lines.push(`   사용자 explicit confirm 필요:`);
      lines.push(`     (a) MCP cron API spec 확인 후 timezone 지원 명시`);
      lines.push(`     (b) cron fallback primary 로 승격 (사용자 결정 #2)`);
      break;
  }

  lines.push(``);
  lines.push(`opt-out: CODEX_PLUGIN_DAILY_EVOLVE_DISABLED=1`);
  return lines;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  const result = probeAndRegister();
  process.stdout.write(JSON.stringify(result.probe, null, 2) + "\n");
  process.stderr.write("\n" + result.guidance.join("\n") + "\n");
}
