import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  reapDeadJobs,
  upsertJob,
  writeJobFile,
  __resetPidGuardDegradedNotice,
  __setSpawnSyncForTests
} from "../plugins/opnd-codex/scripts/lib/state.mjs";
import {
  __resetTelemetryFailureState,
  resolveTelemetryFile
} from "../plugins/opnd-codex/scripts/lib/telemetry.mjs";
import { makeTempDir, initGitRepo } from "./helpers.mjs";

// O5 — 외부에서 죽은 worker(Windows 의 지배적 경우: subagent 의 Job Object 가 닫힐 때
// TerminateProcess)는 자신의 terminal 이벤트를 emit 할 수 없다. 그 전이가 관측되는
// 유일한 지점이 reaper 인데 아무것도 기록하지 않았고, 그래서 실행의 약 7% 가 terminal
// 이벤트 없는 `started` 로 남았다.

function telemetryEnv() {
  // makeTempDir 는 해당 dir 를 exit sweep 에 등록한다 (O3).
  const dataDir = makeTempDir("codex-plugin-test-reaptel-");
  return { dataDir, file: resolveTelemetryFile({ CODEX_PLUGIN_DATA_DIR: dataDir }) };
}

function readEvents(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function withTelemetry(dataDir, fn) {
  const prevDir = process.env.CODEX_PLUGIN_DATA_DIR;
  const prevDisabled = process.env.CODEX_PLUGIN_TELEMETRY_DISABLED;
  process.env.CODEX_PLUGIN_DATA_DIR = dataDir;
  delete process.env.CODEX_PLUGIN_TELEMETRY_DISABLED;
  try {
    return fn();
  } finally {
    if (prevDir === undefined) delete process.env.CODEX_PLUGIN_DATA_DIR;
    else process.env.CODEX_PLUGIN_DATA_DIR = prevDir;
    if (prevDisabled === undefined) delete process.env.CODEX_PLUGIN_TELEMETRY_DISABLED;
    else process.env.CODEX_PLUGIN_TELEMETRY_DISABLED = prevDisabled;
  }
}

function seedDeadJob(workspaceRoot, jobId, overrides = {}) {
  const record = {
    id: jobId,
    status: "running",
    phase: "running",
    kind: "task",
    jobClass: "task",
    traceId: "abc123abc123abc1",
    pid: 999999999, // 결코 살아있지 않은 pid
    startedAt: "2026-07-09T00:00:00.000Z",
    ...overrides
  };
  writeJobFile(workspaceRoot, jobId, record);
  upsertJob(workspaceRoot, record);
}

test("reapDeadJobs emits a terminated event for each job it reaps", () => {
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  const { dataDir, file } = telemetryEnv();

  const reaped = withTelemetry(dataDir, () => {
    seedDeadJob(workspaceRoot, "task-reaped-1");
    return reapDeadJobs(workspaceRoot);
  });

  assert.equal(reaped.length, 1, "job was reaped");

  const events = readEvents(file).filter((e) => e.event === "terminated");
  assert.equal(events.length, 1, "exactly one terminal event");
  const [event] = events;
  assert.equal(event.jobId, "task-reaped-1");
  assert.equal(event.phase, "terminated");
  assert.equal(event.jobClass, "task");
  assert.equal(event.traceId, "abc123abc123abc1", "correlates with the job's own trace");
  assert.match(event.extras.reason, /^reaper:(process_died|pid_reused|no_pid_recorded)$/);
});

test("the reap event carries elapsedMs so completion-time stats stay honest", () => {
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  const { dataDir, file } = telemetryEnv();

  withTelemetry(dataDir, () => {
    seedDeadJob(workspaceRoot, "task-reaped-2", { startedAt: "2026-07-09T00:00:00.000Z" });
    reapDeadJobs(workspaceRoot);
  });

  const [event] = readEvents(file).filter((e) => e.event === "terminated");
  assert.ok(Number.isFinite(event.elapsedMs), "elapsedMs present");
  assert.ok(event.elapsedMs > 0);
});

test("a job with no recorded startedAt omits elapsedMs rather than fabricating 0", () => {
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  const { dataDir, file } = telemetryEnv();

  withTelemetry(dataDir, () => {
    seedDeadJob(workspaceRoot, "task-reaped-3", { startedAt: undefined });
    reapDeadJobs(workspaceRoot);
  });

  const [event] = readEvents(file).filter((e) => e.event === "terminated");
  assert.equal("elapsedMs" in event, false, "no fabricated duration");
});

test("reaping nothing emits nothing", () => {
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  const { dataDir, file } = telemetryEnv();

  const reaped = withTelemetry(dataDir, () => reapDeadJobs(workspaceRoot));
  assert.deepEqual(reaped, []);
  assert.deepEqual(readEvents(file), []);
});

// C8 — OS birth-time probe 가 실패하면 isJobProcessAlive 는 pid 재사용을 감지하지 못하는
// 맨 liveness 검사로 조용히 폴백한다. 그 격하가 전혀 보이지 않았다.

test("a failed birth-time probe records the pid-guard downgrade once per process", () => {
  __resetPidGuardDegradedNotice();
  __resetTelemetryFailureState();
  const workspaceRoot = makeTempDir();
  initGitRepo(workspaceRoot);
  const { dataDir, file } = telemetryEnv();

  // `wmic` / `ps` 를 쓸 수 없는 호스트를 흉내낸다: probe 가 non-zero 를 반환해
  // getProcessStartTimeRaw 가 null 을 내놓는다.
  __setSpawnSyncForTests(() => ({ status: 1, stdout: "", stderr: "not found" }));
  try {
    withTelemetry(dataDir, () => {
      // 살아있는 pid(우리 자신) + 기록된 birth time 조합이 probe 경로를 강제한다.
      seedDeadJob(workspaceRoot, "task-live-guard", {
        pid: process.pid,
        processStartedAt: "some-recorded-birth-time"
      });
      reapDeadJobs(workspaceRoot);
      reapDeadJobs(workspaceRoot); // 두 번째 호출은 다시 emit 하면 안 된다
    });
  } finally {
    __setSpawnSyncForTests(null);
  }

  const degraded = readEvents(file).filter(
    (e) => e.event === "progress" && e.phase === "pid_guard_degraded"
  );
  assert.equal(degraded.length, 1, "warn-once: one event per process, not per probe");
  assert.equal(degraded[0].extras.pidGuard, "liveness-only");
  assert.equal(degraded[0].extras.platform, process.platform);

  // job 자체는 살아있는 것으로 취급된다(문서화된 폴백). 따라서 reap 되면 안 된다.
  const terminated = readEvents(file).filter((e) => e.event === "terminated");
  assert.deepEqual(terminated, [], "degraded guard does not cause a false reap");
  __resetPidGuardDegradedNotice();
});
