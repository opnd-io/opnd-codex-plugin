import test from "node:test";
import assert from "node:assert/strict";

import { __testHooks } from "../plugins/opnd-codex/scripts/lib/codex.mjs";

const { sameSourcePath, pickImportedThreadId, importFailureMessage, sortByImportedAt } = __testHooks;

const isWin = process.platform === "win32";

test("sameSourcePath: exact match on any platform", () => {
  assert.equal(sameSourcePath("/home/u/.claude/projects/x.jsonl", "/home/u/.claude/projects/x.jsonl"), true);
  assert.equal(sameSourcePath("", "x"), false);
  assert.equal(sameSourcePath("x", null), false);
});

test("sameSourcePath: tolerates Windows \\\\?\\ prefix + case only on win32", () => {
  const verbatim = "\\\\?\\C:\\Users\\me\\.claude\\projects\\X.jsonl";
  const plain = "C:\\Users\\me\\.claude\\projects\\x.jsonl";
  if (isWin) {
    assert.equal(sameSourcePath(verbatim, plain), true, "win32 folds prefix + case");
  } else {
    // POSIX 에서는 Windows-ism 이 꺼진다: 서로 다른 대소문자 변이 문자열이
    // 합쳐지면 안 된다(SF2-003).
    assert.equal(sameSourcePath("/p/Session.jsonl", "/p/session.jsonl"), false);
  }
});

test("pickImportedThreadId: is always source-strict — never returns an unrelated thread (SF2-001/CDX2-002)", () => {
  const records = [
    { source_path: "/p/a.jsonl", imported_thread_id: "thr_a", imported_at: 1 }
  ];
  // 매칭 record 없는 b.jsonl 조회는 thr_a 가 아니라 null 을 반환해야 한다.
  // thr_a 가 유일한 record 여도(동시의 무관한 import 를 이번 run 결과로 오인 금지).
  assert.equal(pickImportedThreadId(records, "/p/b.jsonl"), null);
});

test("pickImportedThreadId: matching source returns its thread", () => {
  const records = [
    { source_path: "/p/a.jsonl", imported_thread_id: "thr_a", imported_at: 1 },
    { source_path: "/p/b.jsonl", imported_thread_id: "thr_b", imported_at: 2 }
  ];
  assert.equal(pickImportedThreadId(records, "/p/b.jsonl"), "thr_b");
});

test("pickImportedThreadId: picks latest by imported_at, not array position (QUAL2-002)", () => {
  const records = [
    { source_path: "/p/a.jsonl", imported_thread_id: "thr_new", imported_at: 99 },
    { source_path: "/p/a.jsonl", imported_thread_id: "thr_old", imported_at: 1 }
  ];
  assert.equal(pickImportedThreadId(records, "/p/a.jsonl"), "thr_new");
});

test("pickImportedThreadId: ignores records without a string thread id", () => {
  const records = [
    { source_path: "/p/a.jsonl", imported_thread_id: null, imported_at: 5 },
    { source_path: "/p/a.jsonl", imported_at: 6 }
  ];
  assert.equal(pickImportedThreadId(records, "/p/a.jsonl"), null);
});

test("sortByImportedAt: records without imported_at keep original order, sorted below timestamped", () => {
  const records = [
    { imported_thread_id: "b" },
    { imported_thread_id: "t", imported_at: 10 },
    { imported_thread_id: "a" }
  ];
  const ordered = sortByImportedAt(records).map((r) => r.imported_thread_id);
  // timestamp 없는 것(NEGATIVE_INFINITY)이 먼저 정렬, 자기들끼리는 stable; timestamp 있는 게 마지막.
  assert.deepEqual(ordered, ["b", "a", "t"]);
});

test("importFailureMessage: null when no failures", () => {
  assert.equal(importFailureMessage({ itemTypeResults: [{ itemType: "SESSIONS", successes: [{}], failures: [] }] }), null);
  assert.equal(importFailureMessage({}), null);
  assert.equal(importFailureMessage(null), null);
});

test("importFailureMessage: surfaces a SESSIONS failure message", () => {
  const params = {
    itemTypeResults: [
      { itemType: "SESSIONS", successes: [], failures: [{ message: "boom", errorType: "E" }] }
    ]
  };
  assert.equal(importFailureMessage(params), "boom");
});

test("importFailureMessage: ignores failures for non-requested item types (SF2-002)", () => {
  const params = {
    itemTypeResults: [
      { itemType: "MCP_SERVERS", successes: [], failures: [{ message: "unrelated" }] },
      { itemType: "SESSIONS", successes: [{}], failures: [] }
    ]
  };
  assert.equal(importFailureMessage(params), null);
});
