/**
 * fork-tarball.test.mjs — lib/fork-tarball.mjs unit test (Phase 2)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizePosixPath,
  isVendorPath,
  isBinaryByExtension,
  isBinaryBySize,
  isBinaryByMagic,
  shouldSkipPath,
  nonVendorDiffRatio,
  BINARY_SIZE_BYTES,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/fork-tarball.mjs";

test("normalizePosixPath — Windows backslash → /", () => {
  assert.equal(normalizePosixPath("plugins\\codex\\foo.mjs"), "plugins/codex/foo.mjs");
  assert.equal(normalizePosixPath("a/b/c"), "a/b/c");
  assert.equal(normalizePosixPath(""), "");
  assert.equal(normalizePosixPath(null), "");
});

test("isVendorPath — node_modules / vendor / dist / build", () => {
  assert.equal(isVendorPath("node_modules/foo/index.js"), true);
  assert.equal(isVendorPath("packages/x/node_modules/y.js"), true);
  assert.equal(isVendorPath("vendor/lib/x.go"), true);
  assert.equal(isVendorPath("dist/main.js"), true);
  assert.equal(isVendorPath("build/output.bin"), true);
  assert.equal(isVendorPath("coverage/lcov.info"), true);
  assert.equal(isVendorPath("__pycache__/x.pyc"), true);
  assert.equal(isVendorPath(".venv/bin/python"), true);
  assert.equal(isVendorPath("target/debug/x"), true);
});

test("isVendorPath — *.lock / *.min.js / *.bundle.css", () => {
  assert.equal(isVendorPath("package-lock.json"), true);
  assert.equal(isVendorPath("yarn.lock"), true);
  assert.equal(isVendorPath("Cargo.lock"), true);
  assert.equal(isVendorPath("dist/foo.min.js"), true); // path 매칭 + ext 매칭
  assert.equal(isVendorPath("src/foo.min.css"), true);
  assert.equal(isVendorPath("a/b/foo.bundle.js"), true);
});

test("isVendorPath — 일반 source 파일은 false", () => {
  assert.equal(isVendorPath("src/foo.js"), false);
  assert.equal(isVendorPath("plugins/codex/scripts/foo.mjs"), false);
  assert.equal(isVendorPath("README.md"), false);
  assert.equal(isVendorPath(""), false);
  assert.equal(isVendorPath(null), false);
});

test("isBinaryByExtension — 다양한 binary 확장자", () => {
  assert.equal(isBinaryByExtension("logo.png"), true);
  assert.equal(isBinaryByExtension("doc.pdf"), true);
  assert.equal(isBinaryByExtension("archive.tar.gz"), true);
  assert.equal(isBinaryByExtension("native.so"), true);
  assert.equal(isBinaryByExtension("font.woff2"), true);
  assert.equal(isBinaryByExtension("video.mp4"), true);

  // 소스 파일은 false
  assert.equal(isBinaryByExtension("foo.mjs"), false);
  assert.equal(isBinaryByExtension("README.md"), false);
});

test("isBinaryBySize — 1 MB threshold", () => {
  assert.equal(isBinaryBySize(0), false);
  assert.equal(isBinaryBySize(BINARY_SIZE_BYTES), false);
  assert.equal(isBinaryBySize(BINARY_SIZE_BYTES + 1), true);
  assert.equal(isBinaryBySize(NaN), false);
});

test("isBinaryByMagic — NUL byte 검출", () => {
  assert.equal(isBinaryByMagic("hello world"), false);
  assert.equal(isBinaryByMagic("text\x00with nul"), true);
  assert.equal(isBinaryByMagic(new Uint8Array([1, 2, 3])), false);
  assert.equal(isBinaryByMagic(new Uint8Array([1, 0, 3])), true);
  assert.equal(isBinaryByMagic(null), false);
});

test("shouldSkipPath — 종합 판정 (vendor / binary 우선)", () => {
  // vendor
  assert.deepEqual(shouldSkipPath({ path: "node_modules/x.js" }), { skip: true, reason: "vendor" });
  // binary extension
  assert.deepEqual(shouldSkipPath({ path: "logo.png" }), { skip: true, reason: "binary_extension" });
  // size
  assert.deepEqual(
    shouldSkipPath({ path: "huge.txt", size: BINARY_SIZE_BYTES + 1 }),
    { skip: true, reason: "binary_size" },
  );
  // magic
  assert.deepEqual(
    shouldSkipPath({ path: "text.txt", headBytes: "abc\x00def" }),
    { skip: true, reason: "binary_magic" },
  );
  // pass
  assert.deepEqual(
    shouldSkipPath({ path: "src/foo.mjs", size: 100, headBytes: "import" }),
    { skip: false, reason: null },
  );
  // path missing
  assert.equal(shouldSkipPath({}).skip, true);
  assert.equal(shouldSkipPath().skip, true);
});

test("nonVendorDiffRatio — vendor 제외 비율", () => {
  assert.equal(nonVendorDiffRatio([]), 0);
  assert.equal(nonVendorDiffRatio(null), 0);
  // 4 paths, 2 vendor → ratio = 2/4 = 0.5
  assert.equal(
    nonVendorDiffRatio(["src/foo.mjs", "node_modules/x.js", "src/bar.mjs", "package-lock.json"]),
    0.5,
  );
  // all vendor → 0
  assert.equal(nonVendorDiffRatio(["node_modules/a.js", "yarn.lock"]), 0);
  // all source → 1
  assert.equal(nonVendorDiffRatio(["src/a.mjs", "src/b.mjs"]), 1);
});
