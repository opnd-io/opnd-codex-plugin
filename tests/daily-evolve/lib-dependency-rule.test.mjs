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
