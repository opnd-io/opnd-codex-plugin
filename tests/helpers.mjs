import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { buildCommandInvocation, terminateProcessTree } from "../plugins/opnd-codex/scripts/lib/process.mjs";
import { loadBrokerSession } from "../plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs";

// 테스트가 만든 모든 workspace 와 broker 세션 dir 를 추적해, 프로세스 종료 시 살아남은
// 것들을 쓸어낸다. `sweepTrackedBrokers` 는 cxc-* broker 세션 dir 를 (upstream #163),
// `sweepTrackedWorkspaces` 는 workspace 자체를 담당한다.
//
// O3 — 둘은 의도적으로 분리돼 있다. `sweepTrackedBrokers()` 는 공개 테스트 API 이고
// *실행 도중* 에 호출된다 (tests/teardown.test.mjs 참조). 그 시점에 호출자의 workspace 를
// 발밑에서 지우면 버그다. 따라서 workspace 제거는 exit/signal 핸들러에서만 돌고, 그 뒤에는
// 아무도 그 디렉터리를 참조할 수 없다. 이 분리 이전에는 workspace 가 추적만 되고 제거되지
// 않아 `os.tmpdir()` 에 실행당 약 400개가 쌓였다.
const trackedTestWorkspaces = new Set();
const trackedBrokerSessionDirs = new Set();
let sweepHooksInstalled = false;

function installSweepHooks() {
  if (sweepHooksInstalled) {
    return;
  }
  sweepHooksInstalled = true;
  const handler = () => {
    sweepTrackedBrokers();
    sweepTrackedWorkspaces();
  };
  process.on("exit", handler);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, () => {
        sweepTrackedBrokers();
        sweepTrackedWorkspaces();
        process.exit(130);
      });
    } catch {
      // ignore platform-unsupported signals
    }
  }
}

export function makeTempDir(prefix = "codex-plugin-test-") {
  installSweepHooks();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedTestWorkspaces.add(dir);
  return dir;
}

// Tests that spawn real brokers (via codex-companion task/review) can record the
// session dir so cleanup can find and kill the broker.pid even if the test itself
// throws before its own teardown runs.
export function trackBrokerSessionDir(sessionDir) {
  if (sessionDir) {
    trackedBrokerSessionDirs.add(sessionDir);
  }
}

function readPidFile(pidFile) {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killBrokerPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return;
  }
  try {
    terminateProcessTree(pid, { platform: process.platform });
  } catch {
    // best-effort — broker may already be gone
  }
}

function removeBrokerSessionDir(sessionDir) {
  if (!sessionDir) {
    return;
  }
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // ignore — leftover artifacts are tolerable
  }
}

// broker 세션 dir 만 kill + 제거한다. 테스트 도중 아무 때나 호출해도 안전하다: 호출자의
// workspace 디렉터리는 살아남는다 (tests/teardown.test.mjs 가 고정). workspace 는 등록된
// 채로 남아 exit 핸들러가 나중에 제거할 수 있다.
export function sweepTrackedBrokers() {
  // First: sessionDirs that tests explicitly registered.
  for (const sessionDir of trackedBrokerSessionDirs) {
    const pidFile = path.join(sessionDir, "broker.pid");
    killBrokerPid(readPidFile(pidFile));
    removeBrokerSessionDir(sessionDir);
  }
  trackedBrokerSessionDirs.clear();

  // Second: any test workspace whose broker.json points at a sessionDir we missed.
  for (const workspace of trackedTestWorkspaces) {
    let session;
    try {
      session = loadBrokerSession(workspace);
    } catch {
      session = null;
    }
    if (session) {
      if (Number.isFinite(session.pid)) {
        killBrokerPid(session.pid);
      } else if (session.pidFile) {
        killBrokerPid(readPidFile(session.pidFile));
      }
      removeBrokerSessionDir(session.sessionDir);
    }
  }
}

// O3 — workspace 자체를 제거한다. exit/signal 핸들러 전용: 그 시점이면 어떤 테스트도 그것을
// 읽고 있지 않다. 장수 스위트가 정말 원한다면 실행 도중 디스크를 회수할 수 있도록 export
// 하지만, 트리 안에서 직접 호출하는 곳은 없다.
export function sweepTrackedWorkspaces() {
  for (const workspace of trackedTestWorkspaces) {
    try {
      // Windows 는 프로세스가 아직 열고 있는 디렉터리의 unlink 를 거부한다 — 방금 죽인
      // broker 나 worker 가 `terminateProcessTree` 반환 후 수 밀리초 동안 workspace 를 cwd 로
      // 잡고 있을 수 있다. rmSync 는 EBUSY/EPERM/ENOTEMPTY 에서 재시도하므로, 일시적임을 아는
      // race 때문에 디렉터리를 남기느니 몇 번 더 시도하게 둔다.
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // 남은 디렉터리는 견딜 수 있지만, exit 핸들러 밖으로 나가는 throw 는 그렇지 않다.
    }
  }
  trackedTestWorkspaces.clear();
}

// Exposed for tests that want to release a workspace early (e.g. between
// reproductions inside a single test process).
export function untrackTestWorkspace(workspace) {
  trackedTestWorkspaces.delete(workspace);
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

// O1 — 스위트가 spawn 한 자식 프로세스는 개발자 셸에 설정된 telemetry 목적지를 그대로
// 상속했다. Claude Code 세션 안에서 그것은 *실제* ledger 이므로, 기록된 이벤트의 73% 가
// fixture 로 밝혀졌고 (`task-test-sigterm` 하나가 `terminated` 이벤트 72건) 스트림에서
// 계산한 모든 비율이 틀렸다.
//
// 이제 격리가 기본값이고 명시적으로 opt-out 해야 한다: 실제 write 를 관찰하려는 테스트는
// 변수를 직접 세우고("" 또는 "0"), 아래 키 존재 검사가 그것을 건드리지 않는다.
export function withTelemetryIsolation(env) {
  if (!env) {
    return env;
  }
  // truthiness 가 아니라 키 존재로 판단한다: 실제 write 를 원하는 테스트는 `""` 나 `"0"` 로
  // opt-out 한다. 그러나 `{ KEY: undefined }` 는 값 없는 존재이고 — `spawnSync` 는 자식에게
  // 문자열 "undefined" 를 그대로 건네며, `isTelemetryDisabled` 는 그것을 "비활성 아님" 으로
  // 읽는다. 부재로 취급한다.
  if (
    "CODEX_PLUGIN_TELEMETRY_DISABLED" in env &&
    env.CODEX_PLUGIN_TELEMETRY_DISABLED !== undefined
  ) {
    return env;
  }
  return { ...env, CODEX_PLUGIN_TELEMETRY_DISABLED: "1" };
}

export function run(command, args, options = {}) {
  const env = withTelemetryIsolation(options.env);
  const invocation = buildCommandInvocation(command, args, {
    env,
    platform: process.platform
  });
  return spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    input: options.input,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
