import { test } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

// PR-2.2 (#124 / #145) regression — --full-access and the Claude Code naming
// twin --dangerously-skip-permissions must be accepted as boolean flags and
// imply both sandbox=danger-full-access and approval=never. Explicit sandbox
// / approval values must override the alias so the flag never silently
// overwrites a deliberate choice.

const VALUE_OPTIONS = ["model", "effort", "cwd", "prompt-file", "sandbox", "approval", "profile"];
const BOOLEAN_OPTIONS = [
  "json",
  "write",
  "resume-last",
  "resume",
  "fresh",
  "background",
  "full-access",
  "dangerously-skip-permissions"
];

test("--full-access is parsed as a boolean flag", () => {
  const parsed = parseArgs(["--full-access", "do", "something"], {
    valueOptions: VALUE_OPTIONS,
    booleanOptions: BOOLEAN_OPTIONS
  });
  assert.equal(parsed.options["full-access"], true);
  assert.deepEqual(parsed.positionals, ["do", "something"]);
});

test("--dangerously-skip-permissions is parsed as a boolean flag", () => {
  const parsed = parseArgs(["--dangerously-skip-permissions", "do", "something"], {
    valueOptions: VALUE_OPTIONS,
    booleanOptions: BOOLEAN_OPTIONS
  });
  assert.equal(parsed.options["dangerously-skip-permissions"], true);
});

test("source: handleTask treats --full-access as alias for danger-full-access + never approval", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  assert.match(source, /fullAccessAlias = Boolean\(options\["full-access"\] \|\| options\["dangerously-skip-permissions"\]\)/);
  assert.match(source, /sandbox = "danger-full-access"/);
  assert.match(source, /approvalPolicy = "never"/);
  assert.match(source, /running without sandbox or approvals/);
});

test("source: explicit --sandbox / --approval still win over the alias", async () => {
  const fs = await import("node:fs");
  const url = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8");

  // The guard `if (sandbox == null)` is the assertion: an explicit --sandbox
  // is left untouched. Same for approval via `if (!options.approval)`.
  assert.match(source, /if \(sandbox == null\) \{\s*sandbox = "danger-full-access";/m);
  assert.match(source, /if \(!options\.approval\) \{\s*approvalPolicy = "never";/m);
});
