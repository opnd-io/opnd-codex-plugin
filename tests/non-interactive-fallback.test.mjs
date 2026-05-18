import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PR-7.8 (#223) — every slash command that uses `AskUserQuestion` must
// document a deterministic fallback for the case where Claude Code is
// running in a non-interactive mode (`claude --print`, CI, etc.) where
// `AskUserQuestion` is not available. Without the fallback the command
// either hangs waiting on a tool that will never resolve, or makes a
// silent implicit choice the operator never sees.
//
// The four affected commands and their documented defaults:
//
//   review                → background (matches "recommend background in
//                           every other case" rule)
//   adversarial-review    → background (same)
//   rescue                → fresh thread (do not silently inherit a prior
//                           Codex session the operator may not know about)
//   setup                 → Skip for now (never globally `npm install -g`
//                           without explicit operator consent)
//
// Each command file must:
//   1. Mention `PR-7.8` and `#223` so a future maintainer can trace the
//      rule back to its rationale.
//   2. Name the trigger ("AskUserQuestion is not available", `claude --print`).
//   3. State the chosen default explicitly.
//   4. Tell the command to surface a one-line notice so the operator sees
//      the choice in the script output (otherwise the fallback is silent
//      and the user thinks the prompt just never fired).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = path.join(ROOT, "plugins", "codex", "commands");

function read(relativePath) {
  return fs.readFileSync(path.join(COMMANDS, relativePath), "utf8");
}

function assertDocumentsFallback(filename, expectedDefault) {
  const source = read(filename);
  assert.match(
    source,
    /Non-interactive fallback \(PR-7\.8, #223\)/,
    `${filename}: PR-7.8 (#223) section heading present`
  );
  assert.match(
    source,
    /`AskUserQuestion` is not available/,
    `${filename}: explicit trigger condition documented`
  );
  assert.match(
    source,
    /`claude --print`/,
    `${filename}: names the canonical non-interactive entrypoint`
  );
  assert.match(
    source,
    new RegExp(expectedDefault, "i"),
    `${filename}: documents the chosen default (${expectedDefault})`
  );
  assert.match(
    source,
    /Mention .* once/,
    `${filename}: requires a one-line operator-visible notice`
  );
}

test("review.md documents non-interactive fallback → background", () => {
  assertDocumentsFallback("review.md", "Default to \\*\\*background\\*\\*");
});

test("adversarial-review.md documents non-interactive fallback → background", () => {
  assertDocumentsFallback("adversarial-review.md", "Default to \\*\\*background\\*\\*");
});

test("rescue.md documents non-interactive fallback → fresh Codex thread", () => {
  assertDocumentsFallback("rescue.md", "starting a new Codex thread");
});

test("setup.md documents non-interactive fallback → Skip for now (no auto-install)", () => {
  assertDocumentsFallback("setup.md", "Default to \\*\\*Skip for now\\*\\*");
});

test("rescue.md fallback uses --fresh semantics, NOT --resume", () => {
  // Regression guard: the fallback must default to a brand-new Codex
  // session, not to silently resuming the last one. A non-interactive
  // operator may have no way to know a prior session exists, and
  // resuming it could leak history into a CI log or merge two unrelated
  // contexts.
  const source = read("rescue.md");
  // Extract the fallback block only — match from the heading until the
  // next top-level section heading (`Operating rules:` lives outside).
  const fallbackBlock = source.match(/Non-interactive fallback[\s\S]+?(?=\n\w[\w ]*:\n)/);
  assert.ok(fallbackBlock, "fallback block found");
  assert.match(fallbackBlock[0], /starting a new Codex thread/i, "fallback default is a new thread");
  assert.match(
    fallbackBlock[0],
    /equivalent to the user picking `--fresh`/i,
    "explicitly maps fallback to --fresh"
  );
  assert.doesNotMatch(
    fallbackBlock[0],
    /--resume\b(?!.*fallback exclusion)/,
    "fallback section must NOT recommend --resume"
  );
});

test("setup.md fallback never auto-installs without explicit operator consent", () => {
  // Regression guard: the fallback default in non-interactive mode must
  // be Skip, not Install. An auto-install would mean running a global
  // `npm install -g @openai/codex` in a shell the operator can't see —
  // an obvious supply-chain footgun.
  const source = read("setup.md");
  const fallbackBlock = source.match(/Non-interactive fallback[\s\S]+?Output rules:/);
  assert.ok(fallbackBlock, "fallback block found");
  assert.doesNotMatch(
    fallbackBlock[0],
    /npm install -g @openai\/codex` (?!manually)/,
    "fallback block does NOT auto-run the install"
  );
  assert.match(
    fallbackBlock[0],
    /run `npm install -g @openai\/codex` manually/i,
    "fallback points the operator at the manual install command"
  );
});

test("review.md + adversarial-review.md fallbacks pick background (not foreground)", () => {
  // Foreground in non-interactive mode would block the `claude --print`
  // call for the full review duration (~minutes). Background returns a
  // jobId immediately; the operator can poll with /codex:status. The
  // background-recommendation rule already exists for the interactive
  // path ("recommend background in every other case"); the fallback
  // must match that, not invert it.
  for (const file of ["review.md", "adversarial-review.md"]) {
    const source = read(file);
    const fallbackBlock = source.match(/Non-interactive fallback[\s\S]+?(?=\n##|\nForeground flow:|\nBackground flow:)/);
    assert.ok(fallbackBlock, `${file}: fallback block found`);
    assert.match(
      fallbackBlock[0],
      /Default to \*\*background\*\*/i,
      `${file}: fallback explicitly picks background`
    );
    assert.doesNotMatch(
      fallbackBlock[0],
      /Default to \*\*foreground\*\*/i,
      `${file}: fallback does NOT pick foreground (would block --print for minutes)`
    );
  }
});
