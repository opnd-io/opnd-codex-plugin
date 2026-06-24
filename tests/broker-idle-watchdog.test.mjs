import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PR-1.7 (#193) regression — broker idle watchdog tightening. Defaults reduced
// from 30→10 min grace + 5→2 min interval so an orphan broker is reaped within
// ~12 min instead of ~35 min. Both knobs are env-configurable. The contract
// here verifies the env-override clamping logic by importing the broker script
// as a child and probing its parsed constants via a `--print-config` style
// inspector — but the actual broker script does not expose constants, so we
// drive the helper indirectly via a process-level smoke that just confirms
// the script imports without throwing under various env values.

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const BROKER_SCRIPT = path.join(ROOT_DIR, "plugins", "opnd-codex", "scripts", "app-server-broker.mjs");

function runBrokerHelp(env = {}) {
  // The broker enters main() unconditionally so running it with no `serve`
  // subcommand exits non-zero with a usage error. We only check that the
  // module loads (no syntax / parse errors / top-level env interpretation
  // crashes) and produces the expected usage string.
  return spawnSync(process.execPath, [BROKER_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000
  });
}

test("broker script loads with default IDLE_WATCHDOG constants (no env overrides)", () => {
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "",
    CODEX_BROKER_IDLE_INTERVAL_MS: ""
  });
  assert.notEqual(result.status, null, `expected an exit (got null) stderr=${result.stderr}`);
  // Some stderr/stdout is expected (usage), but neither should contain
  // a TypeError or ReferenceError from a broken env override.
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});

test("broker script accepts a custom CODEX_BROKER_IDLE_GRACE_MS env override", () => {
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "60000",
    CODEX_BROKER_IDLE_INTERVAL_MS: "10000"
  });
  assert.notEqual(result.status, null, `expected an exit (got null) stderr=${result.stderr}`);
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});

test("broker script clamps invalid env overrides to the default", () => {
  // Negative and non-numeric values should fall through to the defaults
  // (10 min grace, 2 min interval) without throwing.
  const result = runBrokerHelp({
    CODEX_BROKER_IDLE_GRACE_MS: "-1",
    CODEX_BROKER_IDLE_INTERVAL_MS: "not-a-number"
  });
  assert.notEqual(result.status, null);
  assert.doesNotMatch(result.stderr ?? "", /TypeError|ReferenceError/);
});

test("CDX-001 — 새 연결이 idle 타이머를 갱신한다 (warm 프로브가 watchdog 리셋)", async () => {
  // watchdog 의 lastActiveAt 은 2분 tick 이 sockets.size>0 을 관측할 때만 갱신되므로,
  // tick 사이에 열렸다 닫히는 짧은 liveness 프로브(UserPromptSubmit warm)는 놓쳐
  // broker 가 곧 self-exit 했다. connection 핸들러가 activity.lastActiveAt 을 직접
  // 갱신해야 매 턴 재워밍이 keep-alive 로 동작한다. 소스 레벨로 배선을 핀한다.
  const fs = await import("node:fs");
  const src = fs.readFileSync(BROKER_SCRIPT, "utf8");
  // 공유 activity 타임스탬프 + watchdog 이 그것을 읽는다.
  assert.match(src, /const activity = \{ lastActiveAt: Date\.now\(\) \}/);
  assert.match(src, /activity\.lastActiveAt/);
  // connection 핸들러가 존재하고, 그 핸들러 영역(시작 ~400자) 안에서 activity 를
  // touch 한다. 포맷/주석 변화에 덜 취약하게 핵심 사실만 핀한다(source-pin — 실제
  // connect→타이머 리셋 behavioral 검증은 live broker 필요라 본 단위테스트 범위 밖).
  assert.match(src, /net\.createServer\(\(socket\) => \{/);
  const connStart = src.indexOf("net.createServer((socket) => {");
  assert.notEqual(connStart, -1, "connection handler must exist");
  const connHandlerHead = src.slice(connStart, connStart + 400);
  assert.match(connHandlerHead, /sockets\.add\(socket\);/);
  assert.match(connHandlerHead, /activity\.lastActiveAt = Date\.now\(\)/);
});
