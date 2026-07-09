import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 0.9 (R2-L2) — lib dependency rule guard.
 *
 * lib/*.mjs 는 pure modules — filesystem / network / LLM 호출 금지.
 * 본 test 는 source-level grep 으로 위반 검출.
 *
 * 허용 import: node 내장 중 pure 만 (node:crypto). filesystem/network 차단.
 * Lib 의 IO 가 필요한 경우 caller (orchestrator) 가 inject.
 */

const LIB_DIR = path.resolve("plugins/opnd-codex/scripts/daily-evolve/lib");

const FORBIDDEN_IMPORTS = [
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "node:dns",
  "node:tls",
  "node:readline",
];

const ALLOWED_NODE_BUILTINS = ["node:crypto"]; // pure

test("lib dir 존재 (Phase 0.9 R2-L2 guard)", () => {
  assert.ok(fs.existsSync(LIB_DIR), `lib dir missing: ${LIB_DIR}`);
});

test("lib/*.mjs 모두 forbidden import 없음 (filesystem / network 차단)", () => {
  const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"));
  assert.ok(libFiles.length >= 7, `expected ≥7 lib files, got ${libFiles.length}`);

  const violations = [];
  for (const file of libFiles) {
    const filePath = path.join(LIB_DIR, file);
    const source = fs.readFileSync(filePath, "utf8");
    for (const forbidden of FORBIDDEN_IMPORTS) {
      const importRegex = new RegExp(
        `import\\s+[^;]*from\\s+["']${forbidden.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}["']`,
        "g",
      );
      if (importRegex.test(source)) {
        violations.push({ file, forbidden });
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `lib dependency rule violation:\n${JSON.stringify(violations, null, 2)}`,
  );
});

test("lib/*.mjs 의 node 내장 import 는 pure (현재 node:crypto 만 허용)", () => {
  const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"));
  const unexpected = [];
  for (const file of libFiles) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), "utf8");
    const importMatches = source.matchAll(/import\s+[^;]*from\s+["'](node:[^"']+)["']/g);
    for (const match of importMatches) {
      const imported = match[1];
      if (!ALLOWED_NODE_BUILTINS.includes(imported)) {
        unexpected.push({ file, imported });
      }
    }
  }
  assert.deepEqual(
    unexpected,
    [],
    `unexpected node builtin import in lib/:\n${JSON.stringify(unexpected, null, 2)}\n` +
      `Allowed: ${ALLOWED_NODE_BUILTINS.join(", ")}. Other IO must be in orchestrator.`,
  );
});

test("lib/*.mjs 는 npm package import 없음 (zero npm 룰)", () => {
  const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"));
  const npmImports = [];
  for (const file of libFiles) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), "utf8");
    // npm package: bare specifier (not relative, not node:)
    const matches = source.matchAll(/import\s+[^;]*from\s+["']([^"'./][^"']*)["']/g);
    for (const m of matches) {
      const spec = m[1];
      if (!spec.startsWith("node:")) {
        npmImports.push({ file, spec });
      }
    }
  }
  assert.deepEqual(npmImports, [], `npm import detected:\n${JSON.stringify(npmImports, null, 2)}`);
});

// 위 세 테스트는 `import ... from "..."` 문만 검사하므로, 모듈이 아무것도 import 하지 않고도
// 네트워크나 파일시스템에 닿을 수 있다: `fetch()` 는 전역이고 `await import("node:fs")` 는
// 정적 import 가 아니다. 현재 위반 0건 — 이 가드가 그 상태를 유지한다.
const FORBIDDEN_GLOBAL_CALLS = [
  { name: "fetch", pattern: /(^|[^.\w])fetch\s*\(/ },
  { name: "globalThis.fetch", pattern: /globalThis\s*\.\s*fetch/ },
  { name: "require", pattern: /(^|[^.\w])require\s*\(/ },
  { name: "process.binding", pattern: /process\s*\.\s*binding\s*\(/ },
];

const DYNAMIC_IMPORT_RE = /(^|[^.\w])import\s*\(\s*["'`]([^"'`]+)["'`]/g;

function stripCommentsAndStrings(source) {
  // schema id 안의 `"http://json-schema.org/..."` 나 `// fetch(...)` 주석이 아래 호출 감지기를
  // 오작동시키지 않도록 하는 값싼 어휘 수준 청소.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

test("lib/*.mjs 는 전역 IO 호출 없음 (fetch / require / dynamic import)", () => {
  const libFiles = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs"));
  const violations = [];
  for (const file of libFiles) {
    const raw = fs.readFileSync(path.join(LIB_DIR, file), "utf8");
    const source = stripCommentsAndStrings(raw);
    for (const { name, pattern } of FORBIDDEN_GLOBAL_CALLS) {
      if (pattern.test(source)) {
        violations.push({ file, call: name });
      }
    }
    // Dynamic import needs the *unstripped* source: the specifier is a string.
    for (const match of raw.matchAll(DYNAMIC_IMPORT_RE)) {
      const spec = match[2];
      if (spec.startsWith(".")) {
        continue; // relative sibling import — same rule as the static case
      }
      if (spec.startsWith("node:") && ALLOWED_NODE_BUILTINS.includes(spec)) {
        continue;
      }
      violations.push({ file, dynamicImport: spec });
    }
  }
  assert.deepEqual(
    violations,
    [],
    `lib purity violation (global IO call or dynamic import):\n${JSON.stringify(violations, null, 2)}\n` +
      `fetch/require/dynamic-import bypass the static-import guards above.`,
  );
});
