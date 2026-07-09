#!/usr/bin/env node
// H4 — `npm test` 는 예전에 `node --test tests/*.test.mjs tests/daily-evolve/*.test.mjs`
// 였다. 이는 glob 확장을 *셸* 에 의존한다. npm 은 POSIX 에서 `sh`, Windows 에서 `cmd.exe` 로
// 스크립트를 돌리는데 cmd.exe 는 glob 을 확장하지 않으므로 node 가 패턴 문자열을 그대로
// 받았다. Node 가 스스로 확장하게 된 것은 이 패키지가 선언한 `engines.node: ">=18.18.0"`
// 하한보다 훨씬 뒤 릴리스다. 선언된 하한과 실제 요구사항이, 정확히 한 플랫폼에서, 조용히
// 어긋나 있었다.
//
// 여기서 파일을 열거하면 셸을 방정식에서 완전히 제거하고, 하한은 런타임 코드가 실제로
// 필요로 하는 자리에 그대로 둘 수 있다.
//
// 아울러 spawn 되는 모든 테스트 프로세스에 telemetry 격리를 보장한다 (O1): 스위트가
// fixture 이벤트를 사용자의 실제 ledger 에 그대로 append 하고 있었다.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIRS = [path.join(ROOT_DIR, "tests"), path.join(ROOT_DIR, "tests", "daily-evolve")];

function collectTestFiles() {
  const files = [];
  for (const dir of TEST_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files.sort();
}

const files = collectTestFiles();
if (files.length === 0) {
  process.stderr.write(`No test files found under ${TEST_DIRS.join(", ")}\n`);
  process.exit(1);
}

const args = ["--test", ...files, ...process.argv.slice(2)];

const result = spawnSync(process.execPath, args, {
  cwd: ROOT_DIR,
  stdio: "inherit",
  env: {
    // 자식 프로세스와 그것이 spawn 하는 모든 프로세스가 이것을 상속한다. Node 버전과
    // 무관하다. 호출자 env 의 명시적 값이 뒤에 spread 되어 이기므로, 실제 write 를 관찰해야
    // 하는 테스트는 opt-out 할 수 있다.
    //
    // `tests/telemetry-isolation.mjs` 는 테스트 파일 하나를 직접 돌리는 개발자를 위해
    // `--import` 로 같은 일을 한다. 여기서는 의도적으로 쓰지 않는다 — 이미 지켜진 경로를
    // 지키는 두 번째 레이어가 되기 때문이다.
    CODEX_PLUGIN_TELEMETRY_DISABLED: "1",
    CODEX_PLUGIN_SUPPRESS_V2_NOTICE: "1",
    ...process.env
  }
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
