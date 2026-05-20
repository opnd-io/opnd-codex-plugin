import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import { listJobs, readJobFile, resolveJobFile, resolveTaskSessionFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function testEnv(binDir, dataDir) {
  return {
    ...buildEnv(binDir),
    CLAUDE_PLUGIN_DATA: dataDir,
    CODEX_PLUGIN_TELEMETRY_DISABLED: "1",
    CODEX_PLUGIN_SUPPRESS_V2_NOTICE: "1"
  };
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
}

function latestTaskJob(workspace) {
  const jobs = listJobs(workspace).filter((job) => job.jobClass === "task");
  assert.ok(jobs.length > 0, "task job recorded");
  return jobs[0];
}

function withPluginData(dataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("pair defaults to foreground read-only with structured output schema", () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir("codex-plugin-data-");
  const binDir = makeTempDir("codex-plugin-bin-");
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "pair", "--json", "Review this narrow change."], {
    cwd: workspace,
    env: testEnv(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastThreadStart.sandbox, "read-only");
  assert.equal(fakeState.lastThreadStart.approvalPolicy, "never");
  assert.ok(fakeState.lastTurnStart.outputSchema?.properties?.verdict, "output schema forwarded");
  assert.match(fakeState.lastTurnStart.prompt, /Codex Pair Programming Profile/);
});

test("capsule background tasks keep the queued request prompt out of the job payload", () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir("codex-plugin-data-");
  const binDir = makeTempDir("codex-plugin-bin-");
  installFakeCodex(binDir);
  const capsuleDir = path.join(workspace, ".claude", "cache", "codex-capsules");
  fs.mkdirSync(capsuleDir, { recursive: true });
  const capsulePath = path.join(capsuleDir, "task.md");
  fs.writeFileSync(capsulePath, "---\nprofile_id: pair\nprofile_version: 1\n---\nCapsule prompt body.\n", "utf8");

  const result = run("node", [SCRIPT, "task", "--background", "--json", "--capsule", capsulePath, "--task-key", "capsule-smoke"], {
    cwd: workspace,
    env: testEnv(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const stored = withPluginData(dataDir, () => readJobFile(resolveJobFile(workspace, payload.jobId)));
  assert.equal(stored.request.prompt, null);
  assert.equal(stored.request.promptSource, "capsule");
  assert.equal(typeof stored.request.capsuleHash, "string");
  assert.equal(stored.taskKey, "capsule-smoke");
});

test("task-key stores a reusable session and result --digest renders the compact handoff", () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir("codex-plugin-data-");
  const binDir = makeTempDir("codex-plugin-bin-");
  installFakeCodex(binDir);
  const env = testEnv(binDir, dataDir);

  const first = run("node", [SCRIPT, "task", "--json", "--task-key", "triage-case", "--output-profile", "triage", "Summarize the risk."], {
    cwd: workspace,
    env
  });
  assert.equal(first.status, 0, first.stderr);

  const job = withPluginData(dataDir, () => latestTaskJob(workspace));
  const sessionFile = withPluginData(dataDir, () => resolveTaskSessionFile(workspace, "triage-case"));
  assert.ok(fs.existsSync(sessionFile), "task session registry written");
  const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(session.threadId, job.threadId);

  const digest = run("node", [SCRIPT, "result", "--digest", job.id], {
    cwd: workspace,
    env
  });
  assert.equal(digest.status, 0, digest.stderr);
  assert.match(digest.stdout, /# Codex Result Digest/);
  assert.match(digest.stdout, /Task key: triage-case/);

  const second = run("node", [SCRIPT, "task", "--json", "--task-key", "triage-case", "--output-profile", "triage", "Summarize the risk."], {
    cwd: workspace,
    env
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFakeState(binDir).lastThreadResume.threadId, session.threadId);
});
