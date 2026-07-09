import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  QUEUED_DISPATCH_GRACE_MS,
  listJobs,
  reapDeadJobs,
  upsertJob,
  writeJobFile
} from "../plugins/opnd-codex/scripts/lib/state.mjs";
import { resolveResultJob } from "../plugins/opnd-codex/scripts/lib/job-control.mjs";
import { makeTempDir, initGitRepo } from "./helpers.mjs";

const DEAD_PID = 999999999;

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

// ------------------------------------------------------------------ C7

// pruneJobs 는 `updatedAt` 으로 정렬해 MAX_JOBS=50 을 넘는 것을 버리고 그 job 의 로그
// 파일을 unlink 했다. status 를 전혀 보지 않았기 때문에, 마지막 progress write 가 더
// 새로운 job 50개 뒤로 밀린 장수 job 이 worker 가 아직 도는 중에 쫓겨나고 로그까지
// 삭제됐다.

test("pruneJobs never evicts a running job to make room for newer terminal ones", () => {
  const workspaceRoot = freshWorkspace();

  seed(workspaceRoot, {
    id: "task-long-runner",
    status: "running",
    pid: process.pid,
    updatedAt: "2020-01-01T00:00:00.000Z" // 압도적으로 가장 오래됨
  });

  for (let i = 0; i < 60; i += 1) {
    seed(workspaceRoot, {
      id: `task-done-${String(i).padStart(3, "0")}`,
      status: "completed",
      updatedAt: `2026-07-09T00:${String(i).padStart(2, "0")}:00.000Z`
    });
  }

  const jobs = listJobs(workspaceRoot);
  assert.equal(jobs.length, 50, "the cap still holds");
  assert.ok(
    jobs.some((job) => job.id === "task-long-runner"),
    "the running job survives despite being the least-recently-updated"
  );
});

test("a running job's log file is not unlinked by the pruner", () => {
  const workspaceRoot = freshWorkspace();
  const logFile = `${workspaceRoot}/running.log`;
  fs.writeFileSync(logFile, "progress\n", "utf8");

  seed(workspaceRoot, {
    id: "task-with-log",
    status: "running",
    pid: process.pid,
    logFile,
    updatedAt: "2020-01-01T00:00:00.000Z"
  });
  for (let i = 0; i < 60; i += 1) {
    seed(workspaceRoot, { id: `task-x-${i}`, status: "completed", updatedAt: `2026-07-09T01:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }

  assert.equal(fs.existsSync(logFile), true, "the live worker's log survives");
});

test("terminal jobs are still capped", () => {
  const workspaceRoot = freshWorkspace();
  for (let i = 0; i < 70; i += 1) {
    seed(workspaceRoot, { id: `task-t-${String(i).padStart(3, "0")}`, status: "completed", updatedAt: `2026-07-09T02:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }
  assert.equal(listJobs(workspaceRoot).length, 50);
});

test("queued jobs count as active for the pruner too", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-queued", status: "queued", updatedAt: "2020-01-01T00:00:00.000Z" });
  for (let i = 0; i < 60; i += 1) {
    seed(workspaceRoot, { id: `task-c-${i}`, status: "cancelled", updatedAt: `2026-07-09T03:${String(i % 60).padStart(2, "0")}:00.000Z` });
  }
  assert.ok(listJobs(workspaceRoot).some((job) => job.id === "task-queued"));
});

// ------------------------------------------------------------------ C11

// reaper 가 "queued && pid 없음" 을 죽음으로 취급했다. job 은 worker 가 pid 를 기록하기
// *전에* queued 이므로, 동시에 들어온 `status` 호출이 단지 dispatch 중이던 job 을
// terminal 로 만들 수 있었다. C10(--wait 경로 reap)이 그 창을 넓혔고, 그래서 둘이 함께
// 들어간다.

test("a freshly queued job is not reaped while dispatch is still in flight", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-dispatching", status: "queued", pid: null, updatedAt: new Date().toISOString() });

  const reaped = reapDeadJobs(workspaceRoot);
  assert.deepEqual(reaped, [], "dispatch grace window respected");
  assert.equal(listJobs(workspaceRoot)[0].status, "queued");
});

test("a queued job whose dispatch never landed is terminalized as dispatch_lost", () => {
  const workspaceRoot = freshWorkspace();
  const stale = new Date(Date.now() - QUEUED_DISPATCH_GRACE_MS - 1000).toISOString();
  seed(workspaceRoot, { id: "task-ambiguous", status: "queued", pid: null, updatedAt: stale, dispatchState: "broker-ambiguous" });

  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped.length, 1);
  assert.equal(reaped[0].reason, "dispatch_lost");

  const [job] = listJobs(workspaceRoot);
  assert.equal(job.status, "failed");
  assert.equal(job.failureReason, "reaper:dispatch_lost");
  assert.match(job.errorMessage, /never confirmed a spawn|stayed queued without a worker/);
  assert.match(job.errorMessage, /nothing was executed/, "tells the user it is safe to retry");
});

test("the grace window can be driven deterministically", () => {
  const workspaceRoot = freshWorkspace();
  const t0 = Date.parse("2026-07-09T00:00:00.000Z");
  seed(workspaceRoot, { id: "task-grace", status: "queued", pid: null, updatedAt: new Date(t0).toISOString() });

  assert.deepEqual(reapDeadJobs(workspaceRoot, { nowMs: t0 + QUEUED_DISPATCH_GRACE_MS - 1 }), [], "inside the window");
  const reaped = reapDeadJobs(workspaceRoot, { nowMs: t0 + QUEUED_DISPATCH_GRACE_MS + 1 });
  assert.equal(reaped[0]?.reason, "dispatch_lost", "past the window");
});

test("a queued job with no usable timestamp is reaped immediately", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-notime", status: "queued", pid: null, updatedAt: undefined, createdAt: undefined });
  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped[0]?.reason, "dispatch_lost");
});

test("a running job with a dead pid is still reaped as process_died, not dispatch_lost", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-dead", status: "running", pid: DEAD_PID, updatedAt: new Date().toISOString() });
  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped.length, 1);
  assert.match(reaped[0].reason, /process_died|pid_reused/);
});

test("a running job with no pid at all keeps the old no_pid_recorded reason", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-nopid", status: "running", pid: null, updatedAt: new Date().toISOString() });
  const reaped = reapDeadJobs(workspaceRoot);
  assert.equal(reaped[0]?.reason, "no_pid_recorded", "the grace window is a queued-only concept");
});

// ------------------------------------------------------------------ C10

// `status`/`--tail`/`--watch` 는 reap 했지만 `--wait` 과 `resolveResultJob` 은 하지
// 않았다. 외부에서 죽은 worker 는 `running` 으로 남아, `result --wait` 은 자신의
// timeout 까지 polling 하고 `result` 는 영원히 "아직 끝난 job 없음" 을 보고했다.

test("resolveResultJob reaps a dead job so the result is retrievable", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, {
    id: "task-killed",
    status: "running",
    pid: DEAD_PID,
    updatedAt: new Date().toISOString(),
    sessionId: null
  });

  // 수정 전에는 "No finished Codex jobs found for this repository yet." 를 던졌다.
  const { job } = resolveResultJob(workspaceRoot, "task-killed");
  assert.equal(job.id, "task-killed");
  assert.equal(job.status, "failed", "the reaper terminalized it during resolution");
});

test("resolveResultJob leaves a genuinely running job alone", () => {
  const workspaceRoot = freshWorkspace();
  seed(workspaceRoot, { id: "task-alive", status: "running", pid: process.pid, updatedAt: new Date().toISOString() });
  // `resolveResultJob` 은 terminal job 만 매칭하므로 살아있는 job 은 "not found" 다.
  // 이 테스트의 요점은 부수효과다: reap 이 그 job 을 건드리면 안 된다.
  assert.throws(() => resolveResultJob(workspaceRoot, "task-alive"), /No job found/i);
  assert.equal(listJobs(workspaceRoot)[0].status, "running", "not reaped");
});
