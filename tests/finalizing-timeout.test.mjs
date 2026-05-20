import { test } from "node:test";
import assert from "node:assert/strict";

import { __testHooks } from "../plugins/opnd-codex/scripts/lib/codex.mjs";

// PR-1.3 (#183) regression — a TurnCaptureState that observes phase="finalizing"
// must surface a deterministic failure if the turn never reaches a terminal
// state within the configured timeout. Otherwise jobs remain status="running"
// forever when a spark-model turn or a cancel-without-interrupt drops the final
// turn notification.

const { createTurnCaptureState, armFinalizingPhaseTimerIfNeeded } = __testHooks;

test("finalizing-phase timer fails the turn after the configured deadline", async () => {
  const state = createTurnCaptureState("thread-test", { finalizingTimeoutMs: 50 });

  armFinalizingPhaseTimerIfNeeded(state, "finalizing");
  assert.ok(state.finalizingPhaseTimer, "timer is armed when phase first reaches finalizing");
  assert.ok(state.finalizingStartedAt, "finalizingStartedAt is recorded");

  await assert.rejects(state.completion, (error) => {
    assert.match(error.message, /stuck in phase=finalizing/);
    assert.match(error.message, /0s/); // 50ms rounds to 0s in the message
    return true;
  });
  assert.equal(state.completed, true, "state is marked completed after fail");
  assert.equal(state.finalizingPhaseTimer, null, "timer is cleared on fail");
});

test("finalizing-phase timer does not fire when the turn completes before the deadline", async () => {
  const state = createTurnCaptureState("thread-test", { finalizingTimeoutMs: 5000 });

  armFinalizingPhaseTimerIfNeeded(state, "finalizing");
  assert.ok(state.finalizingPhaseTimer, "timer armed");

  __testHooks.completeTurn(state, { id: "turn-1", status: "completed" });

  const resolved = await state.completion;
  assert.equal(resolved.completed, true);
  assert.equal(state.finalizingPhaseTimer, null, "completeTurn clears the timer");
});

test("finalizing-phase timer is a no-op when phase is not finalizing", () => {
  const state = createTurnCaptureState("thread-test", { finalizingTimeoutMs: 50 });
  armFinalizingPhaseTimerIfNeeded(state, "investigating");
  assert.equal(state.finalizingPhaseTimer, null, "non-finalizing phase does not arm timer");
});

test("finalizing-phase arm is idempotent — second call does not reset the timer", () => {
  const state = createTurnCaptureState("thread-test", { finalizingTimeoutMs: 60_000 });
  armFinalizingPhaseTimerIfNeeded(state, "finalizing");
  const firstTimer = state.finalizingPhaseTimer;
  const firstStart = state.finalizingStartedAt;
  armFinalizingPhaseTimerIfNeeded(state, "finalizing");
  assert.equal(state.finalizingPhaseTimer, firstTimer, "timer object preserved");
  assert.equal(state.finalizingStartedAt, firstStart, "start timestamp preserved");
  __testHooks.clearFinalizingPhaseTimer(state);
});

test("finalizing-phase timeout can be disabled by setting a non-positive timeout", () => {
  const state = createTurnCaptureState("thread-test", { finalizingTimeoutMs: 0 });
  armFinalizingPhaseTimerIfNeeded(state, "finalizing");
  assert.equal(state.finalizingPhaseTimer, null, "timeout=0 disables the gate");
});
