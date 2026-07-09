import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  listJobs,
  reapDeadJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/opnd-codex/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

// R4 — `reapDeadJobs()` 가 `updateState()` 를 무조건 호출했고, `updateState()` 는
// state lock 을 잡고 mutator 가 아무것도 바꾸지 않아도 state.json 을 다시 쓴다. 모든
// read entrypoint 가 reap 하고 `--wait` 도 이제 poll tick 마다 reap 하므로, 놀고 있는
// wait 이 deadline 내내 tick 당 한 번씩 state.json 을 다시 쓰고 있었다.

function stateFile(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), "state.json");
}

function seed(workspaceRoot, job) {
  const record = { kind: "task", jobClass: "task", ...job };
  writeJobFile(workspaceRoot, record.id, record);
  upsertJob(workspaceRoot, record);
  return record;
}

function freshWorkspace() {
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  return workspaceRoot;
}

/** 일부 파일시스템에서 mtimeMs 해상도가 거칠다. inode 내용 + mtime 을 함께 비교한다. */
function fingerprint(file) {
  const stat = fs.statSync(file);
  return `${stat.mtimeMs}:${stat.size}:${fs.readFileSync(file, "utf8").length}`;
}

test("reaping nothing does not rewrite state.json", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-alive", status: "running", pid: process.pid, updatedAt: new Date().toISOString() });
  seed(workspaceRoot, { id: "task-done", status: "completed", updatedAt: new Date().toISOString() });

  const file = stateFile(workspaceRoot);
  const before = fingerprint(file);

  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(reapDeadJobs(workspaceRoot), [], "nothing to reap");
  }

  assert.equal(fingerprint(file), before, "five reap passes left the file untouched");
});

test("reaping nothing does not leave a lock directory behind", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-alive", status: "running", pid: process.pid, updatedAt: new Date().toISOString() });

  reapDeadJobs(workspaceRoot);

  assert.equal(
    fs.existsSync(path.join(resolveStateDir(workspaceRoot), ".lock")),
    false,
    "the fast path never takes the state lock"
  );
});

test("an empty job list is a no-op", () => {
  const workspaceRoot = freshWorkspace();
  assert.deepEqual(reapDeadJobs(workspaceRoot), []);
});

test("a workspace with no state at all does not throw", () => {
  const workspaceRoot = freshWorkspace();
  assert.deepEqual(reapDeadJobs(workspaceRoot), []);
});

test("the fast path still lets a real reap through", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-alive", status: "running", pid: process.pid, updatedAt: new Date().toISOString() });
  seed(workspaceRoot, { id: "task-dead", status: "running", pid: 999999999, updatedAt: new Date().toISOString() });

  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].id, "task-dead");

  const jobs = listJobs(workspaceRoot);
  assert.equal(jobs.find((j) => j.id === "task-dead").status, "failed");
  assert.equal(jobs.find((j) => j.id === "task-alive").status, "running", "the live job is untouched");
});

test("the pre-scan and the locked pass agree on what counts as dead", () => {
  // 둘의 판정이 어긋나면 fast path 가 진짜 reap 을 건너뛰거나, lock 을 잡고 아무것도
  // 바꾸지 않는다 (이 코드가 피하려는 바로 그 버그).
  const workspaceRoot = freshWorkspace();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  seed(workspaceRoot, { id: "task-queued-fresh", status: "queued", pid: null, updatedAt: new Date().toISOString() });
  seed(workspaceRoot, { id: "task-queued-stale", status: "queued", pid: null, updatedAt: stale });

  const reaped = reapDeadJobs(workspaceRoot);
  assert.deepEqual(
    reaped.map((r) => r.id),
    ["task-queued-stale"],
    "only the stale one, and it went through both gates"
  );
});
