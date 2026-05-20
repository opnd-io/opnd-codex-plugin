import { test } from "node:test";
import assert from "node:assert/strict";

// PR-3.4 (#279 / #207) regression — `--background` for /opnd-codex:review must
// actually queue a background job, not silently run foreground. The
// task-worker must recognize the queued review and dispatch executeReviewRun
// instead of executeTaskRun.

test("codex-companion source: handleReviewCommand reads options.background and queues", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // Look at the handleReviewCommand block specifically: it must check
  // options.background BEFORE the foreground dispatch.
  const handleReviewMatch = source.match(/async function handleReviewCommand[\s\S]+?^\}/m);
  assert.ok(handleReviewMatch, "handleReviewCommand block found");
  const block = handleReviewMatch[0];
  assert.match(block, /if \(options\.background\) \{/, "handleReviewCommand reads options.background");
  assert.match(block, /enqueueBackgroundTask\(cwd, queued, reviewRequest\)/, "queues the review");
  assert.match(block, /renderQueuedTaskLaunch\(payload\)/, "returns queued payload");
});

test("codex-companion source: handleTaskWorker dispatches reviews via executeReviewRun", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  const workerMatch = source.match(/async function handleTaskWorker[\s\S]+?^\}/m);
  assert.ok(workerMatch, "handleTaskWorker block found");
  const block = workerMatch[0];
  assert.match(block, /isReviewRun = typeof request\.reviewName === "string"/, "isReviewRun discriminator wired");
  assert.match(block, /isReviewRun\s*\?\s*executeReviewRun/, "review branch dispatches executeReviewRun");
  assert.match(block, /:\s*executeTaskRun/, "task branch keeps executeTaskRun");
});

test("codex-companion source: queued review carries reviewName so the worker can discriminate", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  const handleReviewMatch = source.match(/async function handleReviewCommand[\s\S]+?^\}/m);
  assert.ok(handleReviewMatch);
  const block = handleReviewMatch[0];
  assert.match(block, /reviewName: config\.reviewName/, "reviewName included in queued request");
});
