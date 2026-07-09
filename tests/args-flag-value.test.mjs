import { test } from "node:test";
import assert from "node:assert/strict";

import { readFlagValue } from "../plugins/opnd-codex/scripts/lib/args.mjs";

// C9 — daily-evolve 진입점은 `argv.indexOf("--phase")` 로 flag 를 읽었고, 이는 공백 구분
// 형식만 매칭한다. `--phase=4` 는 에러 없이 호출자의 기본값으로 떨어져, 실행이 조용히
// phase 0 을 돌렸다.

test("readFlagValue reads the space-separated form", () => {
  assert.equal(readFlagValue(["--phase", "4"], "--phase"), "4");
  assert.equal(readFlagValue(["x", "--type", "weekly_forced"], "--type"), "weekly_forced");
});

test("readFlagValue reads the equals form (the regression this guards)", () => {
  assert.equal(readFlagValue(["--phase=4"], "--phase"), "4");
  assert.equal(readFlagValue(["--type=monthly_self_change"], "--type"), "monthly_self_change");
});

test("readFlagValue returns null when the flag is absent or has no value", () => {
  assert.equal(readFlagValue([], "--phase"), null);
  assert.equal(readFlagValue(["--probe"], "--phase"), null);
  assert.equal(readFlagValue(["--phase"], "--phase"), null, "trailing flag has no value");
});

test("readFlagValue does not match a longer flag that shares the prefix", () => {
  assert.equal(readFlagValue(["--phased=9"], "--phase"), null);
  assert.equal(readFlagValue(["--phase-only", "4"], "--phase"), null);
});

test("readFlagValue accepts an empty equals value verbatim", () => {
  assert.equal(readFlagValue(["--type="], "--type"), "");
});

test("readFlagValue takes the first occurrence", () => {
  assert.equal(readFlagValue(["--phase", "1", "--phase", "2"], "--phase"), "1");
  assert.equal(readFlagValue(["--phase=1", "--phase=2"], "--phase"), "1");
});
