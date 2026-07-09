#!/usr/bin/env node
// H2 — CI 는 두 단계를 돌린다 (`npm test` 다음 `npm run build`). `npm test` 만으로는
// 첫 단계뿐이다. 그래서 checkJs 회귀가 모든 로컬 검사를 통과하고 CI 에서 실패했다.
// `npm run verify` 가 CI 등가 게이트다.
//
// `npm run build` 를 `npm test` 에 그냥 접어 넣을 수는 없다: 그 `prebuild` 가
// `codex app-server generate-ts` 를 셸로 호출하므로, Codex CLI 가 없는 기여자는 테스트조차
// 돌릴 수 없게 된다. 대신 생성된 타입을 쓸 수 있을 때(또는 만들 수 있을 때) 타입 검사를
// 돌리고, 아닐 때는 그렇다고 분명히 말한다 — 게이트 절반을 건너뛴 green 을 보고하지 않는다.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_DIR = path.join(ROOT_DIR, "plugins", "opnd-codex", ".generated", "app-server-types");

function run(label, command, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function codexCliAvailable() {
  const probe = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  return probe.status === 0;
}

function generatedTypesPresent() {
  try {
    return fs.readdirSync(GENERATED_DIR).some((name) => name.endsWith(".ts"));
  } catch {
    return false;
  }
}

const skipped = [];
let failed = 0;

failed += run("npm test", "npm", ["test"]) === 0 ? 0 : 1;

if (codexCliAvailable() || generatedTypesPresent()) {
  failed += run("npm run build (tsc --checkJs)", "npm", ["run", "build"]) === 0 ? 0 : 1;
} else {
  skipped.push(
    "build: the Codex CLI is not installed and plugins/opnd-codex/.generated/app-server-types is empty, " +
      "so `codex app-server generate-ts` cannot run. CI does run this step — install the CLI " +
      "(`npm install -g @openai/codex`) to reproduce it locally."
  );
}

process.stdout.write("\n=== verify summary ===\n");
if (skipped.length > 0) {
  for (const note of skipped) {
    process.stdout.write(`SKIPPED  ${note}\n`);
  }
}
if (failed > 0) {
  process.stdout.write(`FAILED   ${failed} step(s)\n`);
  process.exit(1);
}
process.stdout.write(skipped.length > 0 ? "PASSED   (with skips above)\n" : "PASSED   all CI-equivalent steps\n");
