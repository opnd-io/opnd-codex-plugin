import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PR-3.3 (#324) regression — codex-rescue agent + codex-cli-runtime SKILL must
// share one rule on --background / --wait: respect the user's explicit choice,
// otherwise foreground, and never silently auto-promote a foreground rescue
// to background based on perceived complexity. Auto-promotion was the source
// of the "stub return" failure mode: the subagent ran its own Bash in
// background while the parent thread was still expecting a foreground reply,
// so the parent received an empty string instead of Codex output.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("agent: codex-rescue declares the unified background policy (no auto-promote)", () => {
  const agent = read("agents/codex-rescue.md");

  assert.match(
    agent,
    /Background policy \(#324 — unified rule\)/,
    "unified rule heading present"
  );
  assert.match(
    agent,
    /honor the user's explicit `--background` or `--wait` choice/i,
    "respects explicit user choice"
  );
  assert.match(
    agent,
    /When neither is present, always run foreground/i,
    "default is foreground when neither flag is passed"
  );
  assert.match(
    agent,
    /Never auto-promote a foreground request to background/i,
    "explicit ban on auto-promotion"
  );
});

test("agent: codex-rescue removes the stale 'complicated → background' heuristic", () => {
  const agent = read("agents/codex-rescue.md");

  assert.doesNotMatch(
    agent,
    /prefer foreground for a small, clearly bounded rescue request/i,
    "stale 'prefer foreground for small' wording removed"
  );
  assert.doesNotMatch(
    agent,
    /looks complicated, open-ended, multi-step, or likely to keep Codex running for a long time, prefer background execution/i,
    "stale 'complicated → background' wording removed"
  );
});

test("agent: codex-rescue surfaces the 600s foreground hint without switching modes", () => {
  const agent = read("agents/codex-rescue.md");

  assert.match(
    agent,
    /600 ?s Bash limit applies to foreground rescues/i,
    "agent mentions the 600s Bash limit"
  );
  assert.match(
    agent,
    /re-issue with `--background`/i,
    "agent recommends user re-issues with --background"
  );
  // The hint must say "still run foreground" so the agent does not silently
  // upgrade.
  assert.match(
    agent,
    /still run foreground exactly as requested/i,
    "agent forwards foreground even after the hint"
  );
});

test("skill: codex-cli-runtime declares the unified --background / --wait policy", () => {
  const skill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(
    skill,
    /`--background` \/ `--wait` policy \(#324 — unified rule\)/,
    "SKILL contains unified-rule heading"
  );
  assert.match(
    skill,
    /command-layer routing flags/i,
    "SKILL describes flags as command-layer routing"
  );
  assert.match(
    skill,
    /Strip both `--background` and `--wait` from the natural-language task text/i,
    "SKILL strips flags from prompt text"
  );
  assert.match(
    skill,
    /Strip both from the argv passed to `task`/i,
    "SKILL strips flags from task argv (rescue chain backgrounds at Agent layer)"
  );
});

test("skill: codex-cli-runtime forbids subagent-level auto-background", () => {
  const skill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(
    skill,
    /Do not infer `--background` from prompt length, perceived complexity/i,
    "SKILL bans inference from prompt length / complexity"
  );
  assert.match(
    skill,
    /The subagent must never independently choose `run_in_background: true`/i,
    "SKILL bans subagent-level run_in_background election"
  );
});

test("skill: codex-cli-runtime documents the foreground 600s hint surface", () => {
  const skill = read("skills/codex-cli-runtime/SKILL.md");

  assert.match(skill, /Foreground runtime hint/, "hint section heading present");
  assert.match(skill, /600 ?s/, "600s mentioned");
  assert.match(
    skill,
    /never auto-switch on the user's behalf/i,
    "explicit ban on silent mode switch"
  );
});

test("skill: codex-cli-runtime worktree guard overrides explicit --background", () => {
  const skill = read("skills/codex-cli-runtime/SKILL.md");

  // Per #198 the worktree guard is the only place an explicit user
  // --background may be dropped — make sure that exception is still spelled
  // out clearly so a future cleanup doesn't accidentally re-enable bg in
  // worktrees.
  assert.match(
    skill,
    /Worktree isolation guard \(#198\)/i,
    "worktree guard heading still present"
  );
  assert.match(
    skill,
    /never use `--background` and never `run_in_background` the Bash call — even if the user passed `--background`/i,
    "worktree guard explicitly overrides user --background"
  );
});

test("agent: worktree guard mirrors the SKILL exception", () => {
  const agent = read("agents/codex-rescue.md");

  assert.match(
    agent,
    /Worktree isolation guard \(#198\)/i,
    "agent retains the worktree guard"
  );
  assert.match(
    agent,
    /never run in background even if `--background` was passed/i,
    "agent worktree guard overrides user --background"
  );
});

test("docs alignment: /codex:rescue command keeps its own command-layer semantics", () => {
  // PR-8.5 consistency audit — the /codex:rescue command file must still
  // describe --background as a Claude-side execution flag and must NOT
  // forward it to `task`. This guards against accidental drift between the
  // command-layer policy and the SKILL's "strip from argv" statement.
  const command = read("commands/rescue.md");

  assert.match(
    command,
    /If the request includes `--background`, run the `codex:codex-rescue` subagent in the background/i,
    "/codex:rescue command maps --background to subagent run_in_background"
  );
  assert.match(
    command,
    /Do not forward them to `task`/i,
    "/codex:rescue command keeps --background / --wait off the task argv"
  );
});
