import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ERROR_CLASSES, EVENT_NAMES } from "../plugins/opnd-codex/scripts/lib/telemetry.mjs";

// `telemetry.mjs` 는 EVENT_NAMES 에 대해 "contract test 및 docs/TROUBLESHOOTING.md
// (telemetry 섹션) 와 동기 유지" 라고 지시한다. contract test 는 목록 변경을 잡았지만
// 문서는 아무도 검사하지 않아 놓쳤다. 사용자에게 단일 파일을 `jq` 하라고 안내하는 섹션을
// 갱신하지 않은 채 회전이 추가됐고, 신규 이벤트 이름 두 개가 문서 없이 배포됐다.
//
// 이것은 가능한 가장 싼 가드다: 코드가 emit 하는 모든 이름은, 사용자가 버그를 신고할 때
// 읽는 그 섹션에 나타나야 한다.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC = fs.readFileSync(path.join(ROOT, "docs", "TROUBLESHOOTING.md"), "utf8");
const TELEMETRY_SRC = fs.readFileSync(
  path.join(ROOT, "plugins", "opnd-codex", "scripts", "lib", "telemetry.mjs"),
  "utf8"
);

test("every EVENT_NAMES member is documented in TROUBLESHOOTING.md", () => {
  const missing = EVENT_NAMES.filter((name) => !DOC.includes(name));
  assert.deepEqual(missing, [], `undocumented telemetry events: ${missing.join(", ")}`);
});

test("every ERROR_CLASSES member is documented in TROUBLESHOOTING.md", () => {
  const missing = ERROR_CLASSES.filter((cls) => !DOC.includes(cls));
  assert.deepEqual(missing, [], `undocumented error classes: ${missing.join(", ")}`);
});

test("the docs tell readers the ledger rotates and that they must read both files", () => {
  assert.match(DOC, /events\.jsonl\.1/, "the rotated segment is named");
  assert.match(DOC, /rotat/i, "rotation is explained");
  // 사용자가 복사하는 두 개의 `jq` 레시피는 회전 파일을 포함해야 한다. 그러지 않으면
  // 이력을 조용히 놓친다 — 그것이 이 실패 모드의 전부다.
  const jqRecipes = DOC.match(/jq -c 'select\(\.traceId[\s\S]*?events\.jsonl\n/g) ?? [];
  assert.ok(jqRecipes.length >= 2, `expected the traceId jq recipes, found ${jqRecipes.length}`);
  for (const recipe of jqRecipes) {
    assert.match(recipe, /events\.jsonl\.1/, `a jq recipe reads only the current segment:\n${recipe}`);
  }
});

test("the docs no longer describe the stream as unconditionally append-only", () => {
  assert.doesNotMatch(
    DOC,
    /added an append-only JSONL telemetry stream/,
    "rotation makes the old wording false"
  );
});

test("the module header records the rotation invariants it depends on", () => {
  // 둘 다 실제 버그였다: 세그먼트 하나만 읽으면 undercount 하고, rename 전에 목적지를
  // unlink 하면 두 writer 가 서로의 세그먼트를 파괴한다.
  assert.match(TELEMETRY_SRC, /모든 READER 는 둘 다/);
  assert.match(TELEMETRY_SRC, /목적지를 먼저 unlink 하면 안 된다/);
});
