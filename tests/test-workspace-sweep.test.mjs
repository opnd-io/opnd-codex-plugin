import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildTestChildEnv } from "../scripts/test-env.mjs";
import { makeTempDir, sweepTrackedBrokers, sweepTrackedWorkspaces, withTelemetryIsolation } from "./helpers.mjs";

// O3 — `makeTempDir()` 는 모든 workspace 를 등록했지만 아무도 제거하지 않았다. 그래서 전체
// `npm test` 한 번이 os.tmpdir() 에 `codex-plugin-test-*` 디렉터리를 약 400개 남겼다
// (누적 9,434개). sweep 은 broker 세션 dir 만 회수했다.
//
// `sweepTrackedBrokers()` 를 확장하는 것만으로는 고칠 수 없다: 그 함수는 공개 테스트 API 이고
// 실행 도중 호출되며, 그때 호출자는 자신의 workspace 를 아직 쓰고 있다. tests/teardown.test.mjs
// 가 바로 그것을 고정한다. 그래서 exit 전용 sweep 을 따로 둔다.

const HELPERS_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers.mjs")).href;

test("sweepTrackedBrokers still leaves the workspace alone (existing contract)", () => {
  const workspace = makeTempDir();
  sweepTrackedBrokers();
  assert.equal(fs.existsSync(workspace), true, "mid-run sweep must not delete a live workspace");
});

test("sweepTrackedWorkspaces removes the registered workspaces", () => {
  const a = makeTempDir();
  const b = makeTempDir();
  assert.equal(fs.existsSync(a), true);
  assert.equal(fs.existsSync(b), true);

  sweepTrackedWorkspaces();

  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), false);
});

test("sweepTrackedWorkspaces is idempotent and tolerates an already-deleted dir", () => {
  const workspace = makeTempDir();
  fs.rmSync(workspace, { recursive: true, force: true });
  sweepTrackedWorkspaces();
  sweepTrackedWorkspaces();
});

test("sweepTrackedWorkspaces removes a workspace that still has files in it", () => {
  const workspace = makeTempDir();
  fs.mkdirSync(path.join(workspace, "nested"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "nested", "file.txt"), "content", "utf8");
  sweepTrackedWorkspaces();
  assert.equal(fs.existsSync(workspace), false, "recursive removal");
});

test("a process that exits normally leaves no workspace behind", () => {
  // 요점이 exit 핸들러 자체이므로, 핸들러를 직접 부르지 말고 실제 자식 프로세스를 돌린다.
  const script = `
    import { makeTempDir } from ${JSON.stringify(HELPERS_URL)};
    const a = makeTempDir();
    const b = makeTempDir();
    process.stdout.write(JSON.stringify([a, b]));
  `;
  // makeTempDir 로 등록하지 않는다: 형제 테스트들이 sweepTrackedWorkspaces() 를 호출하는데,
  // 그러면 자식의 발밑에서 스크립트가 지워진다.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-sweepchild-"));
  const scriptFile = path.join(scriptDir, "child.mjs");
  fs.writeFileSync(scriptFile, script, "utf8");

  try {
    const result = spawnSync(process.execPath, [scriptFile], {
      encoding: "utf8",
      env: withTelemetryIsolation({ ...process.env })
    });
    assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);

    const [a, b] = JSON.parse(result.stdout);
    assert.equal(fs.existsSync(a), false, `workspace ${a} survived process exit`);
    assert.equal(fs.existsSync(b), false, `workspace ${b} survived process exit`);
  } finally {
    fs.rmSync(scriptDir, { recursive: true, force: true });
  }
});

test("the exit sweep also runs after an uncaught throw", () => {
  const script = `
    import fs from "node:fs";
    import { makeTempDir } from ${JSON.stringify(HELPERS_URL)};
    const dir = makeTempDir();
    fs.writeFileSync(process.env.SWEEP_PROBE_FILE, dir, "utf8");
    throw new Error("boom");
  `;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-sweepthrow-"));
  const scriptFile = path.join(tmp, "child.mjs");
  const probeFile = path.join(tmp, "dir.txt");
  fs.writeFileSync(scriptFile, script, "utf8");

  try {
    const result = spawnSync(process.execPath, [scriptFile], {
      encoding: "utf8",
      env: withTelemetryIsolation({ ...process.env, SWEEP_PROBE_FILE: probeFile })
    });
    assert.notEqual(result.status, 0, "child throws");

    const dir = fs.readFileSync(probeFile, "utf8");
    assert.equal(fs.existsSync(dir), false, "process.on('exit') still fires on an uncaught throw");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// O1 — 자식 env 격리.

// 세션 신원 누출. `helpers.run()` 은 `options.env` 가 없으면 spawnSync 에 env 를 넘기지
// 않으므로 자식이 부모 env 를 통째로 상속한다. 개발자의 Claude Code 세션 안에서 돌리면
// `CODEX_COMPANION_SESSION_ID` 가 흘러들고, `filterJobsForCurrentSession` 이 sessionId 없는
// fixture 를 전부 걸러내 `status` / `result` 테스트 3건이 실패했다. CI 에는 그 변수가 없어
// 통과하므로, 오랫동안 Windows fake-codex 문제로 잘못 귀인돼 있었다.
test("buildTestChildEnv strips the inherited Claude session identity", () => {
  const env = buildTestChildEnv({
    PATH: "/usr/bin",
    CODEX_COMPANION_SESSION_ID: "sess-from-the-developers-editor",
    CODEX_COMPANION_TRANSCRIPT_PATH: "C:\\Users\\me\\.claude\\projects\\x.jsonl"
  });
  assert.equal("CODEX_COMPANION_SESSION_ID" in env, false);
  assert.equal("CODEX_COMPANION_TRANSCRIPT_PATH" in env, false);
  assert.equal(env.PATH, "/usr/bin", "unrelated variables survive");
});

test("buildTestChildEnv gives session identity no opt-out", () => {
  // telemetry 는 명시적 값으로 opt-out 할 수 있지만, 상속된 세션 신원은 언제나 오염이다.
  const env = buildTestChildEnv({ CODEX_COMPANION_SESSION_ID: "" });
  assert.equal("CODEX_COMPANION_SESSION_ID" in env, false);
});

test("buildTestChildEnv disables telemetry by default but lets a test opt out", () => {
  assert.equal(buildTestChildEnv({}).CODEX_PLUGIN_TELEMETRY_DISABLED, "1");
  assert.equal(
    buildTestChildEnv({ CODEX_PLUGIN_TELEMETRY_DISABLED: "" }).CODEX_PLUGIN_TELEMETRY_DISABLED,
    "",
    "an explicit value in the caller's env wins"
  );
});

test("buildTestChildEnv keeps CODEX_PLUGIN_DATA_DIR", () => {
  // 그 변수는 job/state 디렉터리도 해석한다. 옮기면 스위트가 무엇을 테스트하는지가 달라진다.
  assert.equal(buildTestChildEnv({ CODEX_PLUGIN_DATA_DIR: "/data" }).CODEX_PLUGIN_DATA_DIR, "/data");
});

test("withTelemetryIsolation disables telemetry by default", () => {
  assert.equal(withTelemetryIsolation({ PATH: "/usr/bin" }).CODEX_PLUGIN_TELEMETRY_DISABLED, "1");
});

test("withTelemetryIsolation never overrides an explicit choice", () => {
  assert.equal(
    withTelemetryIsolation({ CODEX_PLUGIN_TELEMETRY_DISABLED: "" }).CODEX_PLUGIN_TELEMETRY_DISABLED,
    "",
    "a test that wants a real write keeps its empty opt-out"
  );
  assert.equal(
    withTelemetryIsolation({ CODEX_PLUGIN_TELEMETRY_DISABLED: "0" }).CODEX_PLUGIN_TELEMETRY_DISABLED,
    "0"
  );
});

test("withTelemetryIsolation passes through a nullish env untouched", () => {
  assert.equal(withTelemetryIsolation(undefined), undefined);
  assert.equal(withTelemetryIsolation(null), null);
});

test("withTelemetryIsolation treats a present-but-undefined value as absent", () => {
  // `{ KEY: undefined }` 는 spawnSync 에 문자열 "undefined" 로 도착하고, isTelemetryDisabled
  // 는 그것을 "비활성 아님" 으로 읽는다 — 조용한 누출.
  const env = withTelemetryIsolation({ CODEX_PLUGIN_TELEMETRY_DISABLED: undefined });
  assert.equal(env.CODEX_PLUGIN_TELEMETRY_DISABLED, "1");
});

test("the preload isolates telemetry for every test process", () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "telemetry-isolation.mjs");
  const env = { ...process.env };
  delete env.CODEX_PLUGIN_TELEMETRY_DISABLED;

  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, "-e", "process.stdout.write(String(process.env.CODEX_PLUGIN_TELEMETRY_DISABLED))"],
    { encoding: "utf8", env }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1");
});

test("the preload respects an explicit opt-out", () => {
  const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), "telemetry-isolation.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, "-e", "process.stdout.write(String(process.env.CODEX_PLUGIN_TELEMETRY_DISABLED))"],
    { encoding: "utf8", env: { ...process.env, CODEX_PLUGIN_TELEMETRY_DISABLED: "" } }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "an explicitly empty value survives the preload");
});
