import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTitle,
  normalizePaths,
  computeDedupeKey,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/dedupe-key.mjs";

test("normalizeTitle — PR/Issue 번호 strip", () => {
  assert.equal(normalizeTitle("Fix #338 race condition"), "fix race condition");
  assert.equal(normalizeTitle("PR 340 race condition"), "race condition");
  assert.equal(normalizeTitle("issue #42 windows path"), "windows path");
});

test("normalizeTitle — semver + prerelease + build strip (R3-M1)", () => {
  assert.equal(normalizeTitle("v2.0.0-rc.1 release"), "release");
  assert.equal(normalizeTitle("v2.0.0+build.42 broker"), "broker");
  assert.equal(normalizeTitle("2.1.0 release"), "release");
});

test("normalizeTitle — CJK punctuation → 공백 (R3-M1)", () => {
  assert.equal(normalizeTitle("버그 수정、테스트"), "버그 수정 테스트");
});

test("normalizeTitle — emoji strip (R3-M1)", () => {
  // Unicode Emoji property strip
  const result = normalizeTitle("🐛 fix race condition");
  assert.equal(result.includes("🐛"), false);
  assert.match(result, /race condition/);
});

test("normalizeTitle — collision: same-root fix#338 vs #340", () => {
  // R3-M1 의도된 collision — 같은 root cause 의 후속 PR 차단
  const a = normalizeTitle("Fix #338 race condition");
  const b = normalizeTitle("fix #340 race condition");
  assert.equal(a, b);
});

test("normalizeTitle — null/empty input safe", () => {
  assert.equal(normalizeTitle(""), "");
  assert.equal(normalizeTitle(null), "");
  assert.equal(normalizeTitle(undefined), "");
  assert.equal(normalizeTitle(42), "");
});

test("normalizePaths — Windows \\ → POSIX /", () => {
  assert.deepEqual(
    normalizePaths(["plugins\\codex\\file.mjs", "tests/x.test.mjs"]),
    ["plugins/codex/file.mjs", "tests/x.test.mjs"],
  );
});

test("normalizePaths — sort + filter empty", () => {
  assert.deepEqual(
    normalizePaths(["b.mjs", "a.mjs", "", null, "c.mjs"]),
    ["a.mjs", "b.mjs", "c.mjs"],
  );
});

test("computeDedupeKey — 같은 input → 같은 hash (deterministic)", () => {
  const k1 = computeDedupeKey({
    signal_type: "upstream-issue",
    title: "Fix #338 race",
    affected_paths: ["lib/foo.mjs", "lib/bar.mjs"],
    verdict: "NOT-FIXED",
  });
  const k2 = computeDedupeKey({
    signal_type: "upstream-issue",
    title: "Fix #340 race",  // 다른 PR 번호 — normalize 후 같음
    affected_paths: ["lib/bar.mjs", "lib/foo.mjs"],  // 다른 순서 — sort 후 같음
    verdict: "NOT-FIXED",
  });
  assert.equal(k1, k2);
});

test("computeDedupeKey — verdict 다르면 다른 hash", () => {
  const k1 = computeDedupeKey({ signal_type: "x", title: "y", affected_paths: [], verdict: "NOT-FIXED" });
  const k2 = computeDedupeKey({ signal_type: "x", title: "y", affected_paths: [], verdict: "PARTIAL" });
  assert.notEqual(k1, k2);
});

test("computeDedupeKey — 64 char hex sha256", () => {
  const k = computeDedupeKey({ signal_type: "x", title: "y", affected_paths: [], verdict: "z" });
  assert.match(k, /^[a-f0-9]{64}$/);
});

test("computeDedupeKey — falsy fields safe", () => {
  const k = computeDedupeKey({});
  assert.match(k, /^[a-f0-9]{64}$/); // 결정적 hash 여전히 반환
});
