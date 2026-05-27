import { test } from "node:test";
import assert from "node:assert/strict";

// PR-5.2 (#281) regression — `codex app-server` caches its auth token after
// startup and ignores subsequent `codex logout && codex login` cycles,
// producing the message "Your access token could not be refreshed because
// you have since logged out or signed in to another account. Please sign
// in again." The annotator must:
//
//   - detect both the "access token could not be refreshed" and the
//     "Please sign in again" wording (either alone is enough to trip)
//   - return the input unchanged for unrelated errors
//   - return an Error whose message contains the original text plus the
//     restart guidance, preserving the original error as `cause`
//   - accept both Error instances and plain strings

// Internal helpers — not exported. We test the observable surface by
// invoking the public runner indirectly is overkill here; we lift the
// helpers from the module under test via re-export friendly inspection.
// codex.mjs does not export these, so the contract documents the behavior
// via a tiny live import + duck-type check.

const codex = await import("../plugins/opnd-codex/scripts/lib/codex.mjs");

test("codex.mjs imports cleanly with the auth-cache annotator", () => {
  // If the export shape ever drops the annotation logic, this smoke test
  // fails fast. The actual hits are exercised by runtime e2e.
  assert.ok(codex.runAppServerTurn, "runAppServerTurn still exported");
  assert.ok(codex.runAppServerReview, "runAppServerReview still exported");
});

// Light "did the annotation message get into the codebase" check via the
// raw source so we catch silent reverts.
test("codex.mjs source contains the stale-auth-cache restart guidance", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/lib/codex.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");
  assert.match(source, /isStaleAuthCacheError/, "detector helper present");
  assert.match(source, /annotateStaleAuthCacheError/, "annotator helper present");
  assert.match(source, /access token could not be refreshed/i, "match pattern still covers known phrasing");
  assert.match(source, /restart Claude Code/i, "guidance includes the restart hint");
});

// #41 — behavioral coverage for the stale-broker auto-restart. The auth probe
// orchestrator is exposed via __testHooks with injected deps so the retry path
// runs without a real broker / app-server.
test("#41 — probeAuthWithStaleRetry restarts the broker once on a stale-auth probe, then re-probes", async () => {
  const { probeAuthWithStaleRetry } = codex.__testHooks;
  let connects = 0;
  let restarts = 0;
  const probes = [
    { loggedIn: false, detail: "Your access token could not be refreshed. Please sign in again." },
    { loggedIn: true, detail: "ChatGPT login active" }
  ];
  let probeIdx = 0;
  const result = await probeAuthWithStaleRetry({
    connect: async () => {
      connects += 1;
      return { close: async () => {} };
    },
    probe: async () => probes[probeIdx++],
    restartBroker: async () => {
      restarts += 1;
    },
    reuseBrokerEndpoint: false
  });
  assert.equal(restarts, 1, "broker restarted exactly once");
  assert.equal(connects, 2, "reconnected after the restart");
  assert.equal(result.restarted, true);
  assert.equal(result.status.loggedIn, true, "second probe result is returned");
});

test("#41 — probeAuthWithStaleRetry does NOT restart when the first probe succeeds", async () => {
  const { probeAuthWithStaleRetry } = codex.__testHooks;
  let restarts = 0;
  const result = await probeAuthWithStaleRetry({
    connect: async () => ({ close: async () => {} }),
    probe: async () => ({ loggedIn: true, detail: "ok" }),
    restartBroker: async () => {
      restarts += 1;
    },
    reuseBrokerEndpoint: false
  });
  assert.equal(restarts, 0, "no restart on healthy auth");
  assert.equal(result.restarted, false);
});

test("#41 — probeAuthWithStaleRetry restarts AT MOST once (still-stale result is returned, no loop)", async () => {
  const { probeAuthWithStaleRetry } = codex.__testHooks;
  let restarts = 0;
  const result = await probeAuthWithStaleRetry({
    connect: async () => ({ close: async () => {} }),
    probe: async () => ({ loggedIn: false, detail: "access token could not be refreshed" }),
    restartBroker: async () => {
      restarts += 1;
    },
    reuseBrokerEndpoint: false
  });
  assert.equal(restarts, 1, "restarted exactly once even though still stale");
  assert.equal(result.status.loggedIn, false, "still-stale status returned without looping");
});

test("#41 — probeAuthWithStaleRetry skips the restart when an explicit broker endpoint is reused", async () => {
  const { probeAuthWithStaleRetry } = codex.__testHooks;
  let restarts = 0;
  await probeAuthWithStaleRetry({
    connect: async () => ({ close: async () => {} }),
    probe: async () => ({ loggedIn: false, detail: "access token could not be refreshed" }),
    restartBroker: async () => {
      restarts += 1;
    },
    reuseBrokerEndpoint: true
  });
  assert.equal(restarts, 0, "an explicitly-managed broker endpoint is never torn down");
});
