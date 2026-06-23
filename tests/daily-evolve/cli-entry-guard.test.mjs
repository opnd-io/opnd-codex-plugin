import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * CLI entry guard regression (analysis 2026-06-22, Codex-only finding A).
 *
 * daily-evolve orchestrators end with a "is this module the main entry?" guard.
 * The legacy form dereferenced `process.argv[1]` at top level:
 *
 *   if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
 *
 * Two latent bugs:
 *   1. `process.argv[1]` is `undefined` in eval/`-e`/programmatic-import contexts
 *      → `.replace` throws `TypeError` at import time (crashes any tooling that
 *      dynamically imports the orchestrator outside a `node x.mjs` launch).
 *   2. `file://${path}` (2 slashes) never equals `import.meta.url`
 *      (`file:///…`, 3 slashes) on Windows → the guard silently never fires when
 *      run directly as `node x.mjs`.
 *
 * Fix: `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`.
 * The orchestrators are invoked via dynamic `import()` from codex-companion.mjs in
 * production, so the guard must be `false` (no side effect) when imported.
 */

const DIR = path.resolve("plugins/opnd-codex/scripts/daily-evolve");

const ORCHESTRATORS = [
  "action-executor.mjs",
  "codex-triage.mjs",
  "diff-analyzer.mjs",
  "digest-writer.mjs",
  "fork-research.mjs",
  "schedule-setup.mjs",
  "self-evolve.mjs",
  "source-aggregator.mjs"
];

test("orchestrators 존재 (CLI guard regression scope)", () => {
  for (const f of ORCHESTRATORS) {
    assert.ok(fs.existsSync(path.join(DIR, f)), `missing orchestrator: ${f}`);
  }
});

test("CLI guard 가 unguarded process.argv[1] deref 를 쓰지 않음", () => {
  const offenders = [];
  for (const f of ORCHESTRATORS) {
    const src = fs.readFileSync(path.join(DIR, f), "utf8");
    // legacy crash pattern: `process.argv[1].replace` without a preceding truthiness guard
    if (/process\.argv\[1\]\.replace/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `unguarded process.argv[1].replace in: ${offenders.join(", ")}`);
});

test("CLI guard 가 pathToFileURL + argv[1] truthiness 형식 사용", () => {
  const missing = [];
  for (const f of ORCHESTRATORS) {
    const src = fs.readFileSync(path.join(DIR, f), "utf8");
    const hasImport = /import\s*\{[^}]*\bpathToFileURL\b[^}]*\}\s*from\s*["']node:url["']/.test(src);
    const hasGuard =
      /process\.argv\[1\]\s*&&\s*import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/.test(src);
    if (!hasImport || !hasGuard) {
      missing.push({ file: f, hasImport, hasGuard });
    }
  }
  assert.deepEqual(missing, [], `guard not in canonical form:\n${JSON.stringify(missing, null, 2)}`);
});

test("eval-context import (argv[1] undefined) 가 throw 하지 않음 + guard side-effect 없음", () => {
  for (const f of ORCHESTRATORS) {
    const rel = path.join(DIR, f).replace(/\\/g, "/");
    // `node -e` leaves process.argv[1] undefined — the exact context that crashed.
    const res = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify("file:///" + rel)});`],
      { encoding: "utf8", timeout: 30000 }
    );
    assert.equal(
      res.status,
      0,
      `${f}: import in eval context failed (status=${res.status})\nstderr:\n${res.stderr}`
    );
  }
});
