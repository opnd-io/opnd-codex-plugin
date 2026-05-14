import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateJobFile,
  updateState,
  writeJobFile
} from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("updateState does not overwrite an invalid existing state file", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{\"jobs\":[", "utf8");

  assert.throws(
    () =>
      updateState(workspace, (state) => {
        state.jobs.push({ id: "job-new" });
      }),
    /Unexpected end of JSON input/
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{\"jobs\":[");
  assert.deepEqual(loadState(workspace).jobs, []);
});

test("writeJobFile writes complete JSON readable by readJobFile", () => {
  const workspace = makeTempDir();
  const jobFile = writeJobFile(workspace, "job-atomic", {
    id: "job-atomic",
    status: "running",
    nested: { ok: true }
  });

  assert.deepEqual(readJobFile(jobFile), {
    id: "job-atomic",
    status: "running",
    nested: { ok: true }
  });
});

test("updateJobFile merges against the latest job file contents", () => {
  const workspace = makeTempDir();
  const jobFile = writeJobFile(workspace, "job-merge", {
    id: "job-merge",
    status: "running",
    phase: "starting",
    pendingApprovals: [{ id: "approval-1", status: "pending" }]
  });

  updateJobFile(workspace, "job-merge", (job) => ({
    ...job,
    pendingApprovals: [{ id: "approval-1", status: "approved" }]
  }));

  updateJobFile(workspace, "job-merge", (job) => ({
    ...job,
    phase: "waiting-approval"
  }));

  assert.deepEqual(readJobFile(jobFile).pendingApprovals, [{ id: "approval-1", status: "approved" }]);
});

test("state lock cleanup removes locks left by exited owners", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), ".lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner"), "999999999\n2026-01-01T00:00:00.000Z\n", "utf8");

  const jobFile = writeJobFile(workspace, "job-after-stale-lock", {
    id: "job-after-stale-lock",
    status: "running"
  });

  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(readJobFile(jobFile).id, "job-after-stale-lock");
});
