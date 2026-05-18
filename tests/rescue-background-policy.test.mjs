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

  // PR-3.6 (#122): hint is now under an explicit "Long-running hint (#122)"
  // heading and spells out the poll commands the user should run next.
  assert.match(
    agent,
    /Long-running hint \(#122\)/,
    "agent labels the hint with the originating issue"
  );
  assert.match(
    agent,
    /~?600 ?s/i,
    "agent mentions the 600s Bash ceiling"
  );
  assert.match(
    agent,
    /re-issu(?:e|ing) the same request with `--background`/i,
    "agent recommends re-issue with --background"
  );
  assert.match(
    agent,
    /`\/codex:status <jobId>`.*`\/codex:status --wait <jobId>`/is,
    "agent points at both status and status --wait"
  );
  assert.match(
    agent,
    /`\/codex:result <jobId>`.*`\/codex:result --wait <jobId>`/is,
    "agent points at both result and result --wait"
  );
  assert.match(
    agent,
    /still run the original foreground request/i,
    "agent forwards foreground even after the hint"
  );
  assert.match(
    agent,
    /do not switch modes on the user's behalf/i,
    "agent explicitly bans silent mode switch"
  );
});

test("agent: codex-rescue 'Codex output handling' allows the hint as the single exception to no-commentary", () => {
  const agent = read("agents/codex-rescue.md");

  // PR-3.6: the old "Response style: no commentary before or after" rule was
  // in direct contradiction with PR-3.3's "surface a one-line hint before
  // task". The section has been renamed and now spells out the carve-out
  // explicitly.
  assert.match(
    agent,
    /Codex output handling/,
    "section renamed from 'Response style' to 'Codex output handling'"
  );
  assert.match(
    agent,
    /Return the forwarded `codex-companion` output verbatim/i,
    "verbatim return rule still in force"
  );
  assert.match(
    agent,
    /only.*Claude-side text allowed in the response is the single-line long-running routing notice/i,
    "the long-running hint is the documented exception"
  );
  assert.match(
    agent,
    /place it \*\*before\*\* the verbatim Codex output; never append text after the output/i,
    "hint goes strictly before, never after"
  );
  // Old contradictory wording removed.
  assert.doesNotMatch(
    agent,
    /^Response style:$/m,
    "old 'Response style:' heading removed"
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

  // PR-3.6: section heading carries the originating issue + the hint now
  // names the four poll commands explicitly.
  assert.match(
    skill,
    /Foreground runtime hint \(long-running heuristic, #122\)/,
    "hint section heading carries the #122 reference"
  );
  assert.match(skill, /~?600 ?s/i, "600s mentioned");
  assert.match(
    skill,
    /`\/codex:status <jobId>`.*`\/codex:status --wait <jobId>`/is,
    "skill points at both status and status --wait"
  );
  assert.match(
    skill,
    /`\/codex:result <jobId>`.*`\/codex:result --wait <jobId>`/is,
    "skill points at both result and result --wait"
  );
  assert.match(
    skill,
    /never auto-switch on the user's behalf/i,
    "explicit ban on silent mode switch"
  );
  assert.match(
    skill,
    /not a hard `--background` auto-promote: that would re-introduce the #324 stub-return failure mode/i,
    "skill cross-references the #324 stub-return reason"
  );
});

test("readme: 'Start Something Long-Running' documents the 600s ceiling + poll commands", () => {
  // PR-3.6 + PR-8.1 (#122 / #213 first slice): the README workflow section
  // now matches what the agent + SKILL spell out, so users have one
  // authoritative reference instead of three near-duplicates.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /### Start Something Long-Running/, "section heading present");
  assert.match(readme, /~?600 ?s/i, "600s mentioned");
  assert.match(
    readme,
    /will surface a one-line notice/i,
    "README mentions the agent-side hint"
  );
  assert.match(
    readme,
    /\/codex:status --wait task-/,
    "README documents status --wait"
  );
  assert.match(
    readme,
    /\/codex:result --wait task-/,
    "README documents result --wait"
  );
  assert.match(
    readme,
    /\/codex:cancel task-/,
    "README documents cancel"
  );
});

test("readme: 'v2.0.0 Defaults & First-Run Setup' covers sandbox + auth migration", () => {
  // PR-8.1 first slice — surface the BREAKING #1 + #2 opt-outs + the auth
  // migration path right in the README so a first-time install does not have
  // to dig through docs/MIGRATION_v2.0.md.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(readme, /## v2\.0\.0 Defaults & First-Run Setup/, "section heading present");
  assert.match(
    readme,
    /CODEX_PLUGIN_SANDBOX_DEFAULT=read-only/,
    "sandbox opt-out documented"
  );
  assert.match(
    readme,
    /CODEX_PLUGIN_USE_DEFAULT_HOME=1/,
    "home isolation opt-out documented"
  );
  assert.match(
    readme,
    /cp ~\/\.codex\/auth\.json ~\/\.codex\/claude-code\/auth\.json/,
    "auth migration Option A documented"
  );
  assert.match(
    readme,
    /CODEX_HOME="\$HOME\/\.codex\/claude-code" codex login/,
    "auth migration Option B documented"
  );
  assert.match(
    readme,
    /CODEX_PLUGIN_SUPPRESS_V2_NOTICE=1/,
    "first-run notice suppression documented"
  );
  assert.match(
    readme,
    /\[`docs\/MIGRATION_v2\.0\.md`\]\(docs\/MIGRATION_v2\.0\.md\)/,
    "links out to MIGRATION_v2.0.md"
  );
  assert.match(
    readme,
    /\[`docs\/TROUBLESHOOTING\.md`\]\(docs\/TROUBLESHOOTING\.md\)/,
    "links out to TROUBLESHOOTING.md"
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
