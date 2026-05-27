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
} from "../plugins/opnd-codex/scripts/lib/state.mjs";

// #338 — resolveStateDir reads `CODEX_PLUGIN_DATA_DIR ?? CLAUDE_PLUGIN_DATA`.
// Tests that exercise a specific resolution path must control BOTH vars so a
// value injected by the surrounding Claude Code session does not leak in.
// Returns a restore fn. (see docs/TROUBLESHOOTING.md #14)
function snapshotPluginDataEnv() {
  const saved = {
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    CODEX_PLUGIN_DATA_DIR: process.env.CODEX_PLUGIN_DATA_DIR
  };
  delete process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CODEX_PLUGIN_DATA_DIR;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const restoreEnv = snapshotPluginDataEnv();

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    restoreEnv();
  }
});

test("resolveStateDir migrates tmpdir state to the plugin data dir", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const restoreEnv = snapshotPluginDataEnv();

  // Write state to the tmpdir fallback (simulates a /opnd-codex:* Bash command
  // run without CLAUDE_PLUGIN_DATA).
  const fallbackStateDir = resolveStateDir(workspace);
  const fallbackStateFile = resolveStateFile(workspace);
  fs.mkdirSync(fallbackStateDir, { recursive: true });
  const stateContent = JSON.stringify({ version: 1, config: { stopReviewGate: true }, jobs: [] });
  fs.writeFileSync(fallbackStateFile, `${stateContent}\n`, "utf8");

  // Now set CLAUDE_PLUGIN_DATA (simulates a subsequent hook context).
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.equal(fs.existsSync(path.join(stateDir, "state.json")), true);
    const migrated = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    assert.equal(migrated.config.stopReviewGate, true);
  } finally {
    restoreEnv();
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const restoreEnv = snapshotPluginDataEnv();
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
    restoreEnv();
  }
});

test("#338 — resolveStateDir prefers CODEX_PLUGIN_DATA_DIR over CLAUDE_PLUGIN_DATA", () => {
  const workspace = makeTempDir();
  const namespacedDir = makeTempDir();
  const genericDir = makeTempDir();
  const restoreEnv = snapshotPluginDataEnv();
  process.env.CLAUDE_PLUGIN_DATA = genericDir;
  process.env.CODEX_PLUGIN_DATA_DIR = namespacedDir;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(namespacedDir, "state")), true);
    assert.equal(stateDir.startsWith(genericDir), false);
  } finally {
    restoreEnv();
  }
});

test("#338 — SessionStart hook exports CODEX_PLUGIN_DATA_DIR, not CLAUDE_PLUGIN_DATA, into the shared env file", () => {
  const src = fs.readFileSync(
    new URL("../plugins/opnd-codex/scripts/session-lifecycle-hook.mjs", import.meta.url),
    "utf8"
  );
  // handleSessionStart must append the codex-namespaced var into CLAUDE_ENV_FILE.
  assert.match(src, /appendEnvVar\(CODEX_PLUGIN_DATA_DIR_ENV,/);
  // It must NOT append the generic CLAUDE_PLUGIN_DATA (PLUGIN_DATA_ENV) — that
  // hijacks every other plugin's per-plugin scoping (the #338 leak).
  assert.doesNotMatch(src, /appendEnvVar\(PLUGIN_DATA_ENV,/);
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
