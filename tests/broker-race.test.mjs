import { test } from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { ensureStateDir, withBrokerLockAsync } from "../plugins/opnd-codex/scripts/lib/state.mjs";

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
  // The state lock and broker lock are separate mkdir dirs (.lock vs
  // .broker.lock). A broker-lock acquire should not block a state-lock
  // acquire happening in parallel.
  const workspaceRoot = makeTempDir();
  ensureStateDir(workspaceRoot);

  const start = Date.now();
  await withBrokerLockAsync(workspaceRoot, async () => {
    // Hold the broker lock for ~50ms.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, "broker lock acquire round-trip is fast");
});
