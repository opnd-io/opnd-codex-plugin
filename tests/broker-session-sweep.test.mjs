import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  SESSION_DIR_ADOPTION_GRACE_MS,
  sweepDeadBrokerSessionDirs,
  teardownBrokerSession
} from "../plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs";
import { makeTempDir } from "./helpers.mjs";

/** 디렉터리가 유예 창을 넘길 만큼 오래 전에 만들어진 것처럼 꾸민다. */
function ageOut(dir) {
  const past = new Date(Date.now() - SESSION_DIR_ADOPTION_GRACE_MS - 60_000);
  fs.utimesSync(dir, past, past);
}

// B3 — `cxc-*` broker 세션 dir 를 지우는 코드가 아무데도 없었다. idle self-exit 경로의
// `shutdown()` 은 `teardownBrokerSession()` 을 부르지 않았고, hard kill 은 shutdown 을
// 통째로 건너뛰었으며, `teardownBrokerSession` 자신은 비재귀 `rmdirSync` 를 써서 남은
// broker.log 앞에서 조용히 실패했다. 한 사용자의 %TEMP% 에 dir 112개가 쌓였다.
//
// broker 는 스스로 뒤처리할 수 없으므로(Windows 에서 broker.log 를 계속 열고 있다),
// 다음 spawn 이 죽은 세션을 회수한다.

function makeSession(tmpdir, name, { pid = null, withLog = true } = {}) {
  const dir = path.join(tmpdir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pid !== null) {
    fs.writeFileSync(path.join(dir, "broker.pid"), `${pid}\n`, "utf8");
  }
  if (withLog) {
    fs.writeFileSync(path.join(dir, "broker.log"), "broker idle — self-exiting\n", "utf8");
  }
  return dir;
}

test("a session dir whose pid is gone is swept", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const dead = makeSession(tmpdir, "cxc-dead1", { pid: 999999999 });

  const swept = sweepDeadBrokerSessionDirs("cxc-", tmpdir);

  assert.equal(swept, 1);
  assert.equal(fs.existsSync(dead), false);
});

test("an aged session dir with no pid file at all is swept", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const orphan = makeSession(tmpdir, "cxc-nopid", { pid: null });
  ageOut(orphan);

  sweepDeadBrokerSessionDirs("cxc-", tmpdir);
  assert.equal(fs.existsSync(orphan), false, "clean shutdown unlinks broker.pid; the dir must still go");
});

test("a JUST-CREATED session dir with no pid file yet is NOT swept", () => {
  // 문제가 되는 race: `createBrokerSessionDir()` 는 mkdtemp 를 하고 `broker.pid` 는
  // spawn 된 broker 자식만 쓴다. 다른 workspace 의 동시 spawn 이 바로 그 창에서 이 sweep
  // 을 돌린다 — cwd 별 broker lock 은 그것을 직렬화하지 않는다. 거기서 지우면 살아있는
  // 세션의 endpoint 와 로그가 파괴된다.
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const brandNew = makeSession(tmpdir, "cxc-racing", { pid: null, withLog: false });

  const swept = sweepDeadBrokerSessionDirs("cxc-", tmpdir);

  assert.equal(swept, 0);
  assert.equal(fs.existsSync(brandNew), true, "a session still being set up must survive");
});

test("the adoption grace is driven by the directory's own timestamp", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const dir = makeSession(tmpdir, "cxc-grace", { pid: null });
  ageOut(dir);
  const birth = fs.statSync(dir).mtimeMs;

  assert.equal(
    sweepDeadBrokerSessionDirs("cxc-", tmpdir, birth + SESSION_DIR_ADOPTION_GRACE_MS - 1),
    0,
    "inside the window"
  );
  assert.equal(fs.existsSync(dir), true);

  assert.equal(
    sweepDeadBrokerSessionDirs("cxc-", tmpdir, birth + SESSION_DIR_ADOPTION_GRACE_MS + 1),
    1,
    "past the window"
  );
  assert.equal(fs.existsSync(dir), false);
});

test("a fresh dir with a LIVE pid is never swept regardless of age", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const live = makeSession(tmpdir, "cxc-fresh-live", { pid: process.pid });
  sweepDeadBrokerSessionDirs("cxc-", tmpdir, Date.now() + 10 * SESSION_DIR_ADOPTION_GRACE_MS);
  assert.equal(fs.existsSync(live), true);
});

test("a fresh dir with a DEAD pid is swept immediately — the pid file removes the ambiguity", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const dead = makeSession(tmpdir, "cxc-fresh-dead", { pid: 999999999 });
  assert.equal(sweepDeadBrokerSessionDirs("cxc-", tmpdir), 1, "no grace needed once we know the owner");
  assert.equal(fs.existsSync(dead), false);
});

test("a session dir belonging to a LIVE broker is left alone", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const live = makeSession(tmpdir, "cxc-live", { pid: process.pid });

  const swept = sweepDeadBrokerSessionDirs("cxc-", tmpdir);

  assert.equal(swept, 0);
  assert.equal(fs.existsSync(live), true, "never reap a running broker's session");
});

test("a garbage pid file is treated as dead, not as a live broker", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const dir = path.join(tmpdir, "cxc-garbage");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "broker.pid"), "not-a-number\n", "utf8");

  sweepDeadBrokerSessionDirs("cxc-", tmpdir);
  assert.equal(fs.existsSync(dir), false);
});

test("the sweep only touches directories matching the prefix", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const unrelated = path.join(tmpdir, "something-else");
  fs.mkdirSync(unrelated, { recursive: true });
  const loose = path.join(tmpdir, "cxc-not-a-dir");
  fs.writeFileSync(loose, "", "utf8");

  sweepDeadBrokerSessionDirs("cxc-", tmpdir);

  assert.equal(fs.existsSync(unrelated), true, "non-matching dir untouched");
  assert.equal(fs.existsSync(loose), true, "a matching *file* is not a session dir");
});

test("the sweep removes a session dir that still contains files", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcsweep-");
  const dead = makeSession(tmpdir, "cxc-withlog", { pid: 999999999, withLog: true });
  fs.writeFileSync(path.join(dead, "extra.sock"), "", "utf8");

  sweepDeadBrokerSessionDirs("cxc-", tmpdir);
  assert.equal(fs.existsSync(dead), false, "recursive removal; rmdirSync would have failed here");
});

test("the sweep tolerates a missing tmpdir", () => {
  assert.equal(sweepDeadBrokerSessionDirs("cxc-", path.join(makeTempDir(), "does-not-exist")), 0);
});

test("teardownBrokerSession removes a session dir that still has a log in it", () => {
  const tmpdir = makeTempDir("codex-plugin-test-cxcteardown-");
  const sessionDir = makeSession(tmpdir, "cxc-teardown", { pid: null });
  // teardown 이 모르는 파일을 흉내낸다 — 예전 rmdirSync 는 여기서 포기했다.
  fs.writeFileSync(path.join(sessionDir, "stray.tmp"), "x", "utf8");

  teardownBrokerSession({
    endpoint: null,
    pidFile: path.join(sessionDir, "broker.pid"),
    logFile: path.join(sessionDir, "broker.log"),
    sessionDir,
    pid: null,
    killProcess: () => {}
  });

  assert.equal(fs.existsSync(sessionDir), false);
});
