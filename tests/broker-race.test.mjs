import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { ensureStateDir, loadState, updateState, withBrokerLockAsync } from "../plugins/opnd-codex/scripts/lib/state.mjs";

// PR-1.4 (#286 race 3) regression — broker.json read-modify-write must be
// serialized across concurrent callers via a dedicated mkdir-based lock so
// that two parallel /opnd-codex:* invocations from the same cwd never both spawn
// a fresh broker.

test("withBrokerLockAsync serializes concurrent critical sections", async () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  let inFlight = 0;
  let peak = 0;
  let total = 0;

  const work = async () => {
    return withBrokerLockAsync(workspaceRoot, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield to the event loop a couple of times so concurrent callers get
      // a chance to interleave if the lock is broken.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      total += 1;
      inFlight -= 1;
      return total;
    });
  };

  const results = await Promise.all([work(), work(), work(), work(), work()]);
  assert.equal(peak, 1, "at most one critical section at a time");
  assert.equal(total, 5, "all critical sections ran");
  assert.deepEqual(results.slice().sort(), [1, 2, 3, 4, 5], "every caller observed a unique counter");
});

test("withBrokerLockAsync releases the lock when the body throws", async () => {
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  await assert.rejects(
    withBrokerLockAsync(workspaceRoot, async () => {
      throw new Error("body error");
    }),
    /body error/
  );

  // Second call must be able to acquire (no leftover lock).
  const after = await withBrokerLockAsync(workspaceRoot, async () => "ok");
  assert.equal(after, "ok");
});

test("withBrokerLockAsync is independent of withStateLock (no cross-blocking)", async () => {
  // state lock 과 broker lock 은 서로 다른 mkdir dir 다 (`.lock` vs `.broker.lock`).
  // broker lock 을 쥔 채로도 state lock 을 잡을 수 있어야 한다.
  //
  // 예전 본문은 broker lock 왕복 시간을 재고 `elapsed < 1000` 을 assert 했다. state lock 은
  // 건드리지도 않았으므로 이름이 주장하는 성질을 검증하지 않았고, 전체 스위트의 spawn 부하
  // 아래서 1.3초가 나와 실패했다. 벽시계 임계값은 hang 가드일 수는 있어도 정확성 게이트가
  // 아니다.
  //
  // 대신 결정적인 신호를 쓴다: 두 락이 얽혀 있으면 `acquireStateLock` 이 재시도를 소진하고
  // *throw* 한다. 따라서 "throw 하지 않고 끝난다" 가 곧 독립성이다.
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  let stateLockTaken = false;
  await withBrokerLockAsync(workspaceRoot, async () => {
    // broker lock 을 쥔 채로 state lock 을 요구한다. `updateState` 가 그것을 잡는다.
    updateState(workspaceRoot, (state) => {
      state.config.stopReviewGate = true;
    });
    stateLockTaken = true;
  });

  assert.equal(stateLockTaken, true, "the state lock was acquired while the broker lock was held");
  assert.equal(loadState(workspaceRoot).config.stopReviewGate, true, "and the mutation landed");

  // broker lock 이 정상 반환됐는지 — 남은 lock dir 가 있으면 여기서 재취득이 실패한다.
  assert.equal(await withBrokerLockAsync(workspaceRoot, async () => "ok"), "ok");
});
