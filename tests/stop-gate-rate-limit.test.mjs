import { test } from "node:test";
import assert from "node:assert/strict";

// PR-3.1 (#306 / #248 / #273) regression — the stop-review-gate hook must
// classify rate-limit / quota / timeout / empty-output failures as
// infrastructure errors (allow + warn), NOT as policy BLOCKs that trigger
// Claude Code's rewake loop. Otherwise hitting the ChatGPT 5h rate limit
// during a long session burns the user's CC token budget for no review.

test("stop-review-gate source: rate-limit signatures are recognized", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/stop-review-gate-hook.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /detectInfrastructureFailure/, "classifier helper present");
  assert.match(source, /RATE_LIMIT_SIGNATURES/, "signature set defined");
  // The signatures must cover at least the four canonical phrasings.
  assert.match(source, /\\brate.\?limit/i);
  assert.match(source, /\\b429\\b/);
  assert.match(source, /\\busage\\s\+limit/i);
  assert.match(source, /\\bquota\[ _\]\?exceeded/i);
});

test("stop-review-gate source: infrastructure failures emit decision=allow + warn", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/stop-review-gate-hook.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /buildAllowSkip/, "allow-skip builder present");
  // main() must check for `review.skipped` BEFORE the legacy ok:false → block.
  assert.match(source, /if \(review\.skipped\) \{/, "main checks skipped first");
  assert.match(source, /Stop-time review skipped/, "skip reason mentions stop-time review");
});

test("stop-review-gate source: ETIMEDOUT no longer maps directly to block", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/stop-review-gate-hook.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // The old "timed out after 15 minutes ... bypass the gate" wording came
  // with ok:false. It must now be inside detectInfrastructureFailure ->
  // buildAllowSkip, NOT a direct ok:false return.
  // Easiest check: the legacy "timed out after 15 minutes" prose is gone,
  // replaced by a structured timeout label.
  assert.doesNotMatch(
    source,
    /ok:\s*false,\s*reason:\s*\n?\s*"The stop-time Codex review task timed out/m,
    "timeout path no longer falls into the block branch directly"
  );
  assert.match(source, /type: "timeout"/, "timeout uses structured label");
});

test("stop-review-gate source: invalid JSON falls into allow-skip, not block", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/opnd-codex/scripts/stop-review-gate-hook.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // The catch block should call buildAllowSkip now.
  assert.match(
    source,
    /catch \{[\s\S]*?return buildAllowSkip\([\s\S]*?invalid JSON/m,
    "invalid JSON catch returns allow-skip"
  );
});
