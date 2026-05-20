import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { collectReviewContext, detectWorktreeContext, resolveReviewTarget } from "../plugins/opnd-codex/scripts/lib/git.mjs";

// PR-4.7 (#280) — when the workspace is a git linked worktree, surface the
// fact in the review prompt's collection guidance so Codex does not waste
// 10+ sandbox-declined commands probing for `--git-dir`, `safe.directory`,
// and gitdir pointer files before running a working `git diff`.

test("detectWorktreeContext returns null for a non-worktree checkout", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = detectWorktreeContext(repo);
  assert.equal(result, null, "main worktree (not linked) returns null");
});

test("detectWorktreeContext returns gitDir + commonDir for a linked worktree", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["branch", "feature/wt"], { cwd: repo });

  const wtParent = makeTempDir();
  const wtPath = path.join(wtParent, "wt");
  const addResult = run("git", ["worktree", "add", wtPath, "feature/wt"], { cwd: repo });
  if (addResult.status !== 0) {
    // git worktree may not be available in all CI sandboxes — skip gracefully.
    return;
  }

  const context = detectWorktreeContext(wtPath);
  assert.ok(context, "linked worktree is detected");
  assert.ok(/worktrees/.test(context.gitDir), "gitDir points inside parent .git/worktrees");
  assert.notEqual(context.gitDir, context.commonDir, "gitDir and commonDir differ");
});

test("collectReviewContext mentions the worktree hint in collectionGuidance when applicable", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  run("git", ["branch", "feature/wt"], { cwd: repo });

  const wtParent = makeTempDir();
  const wtPath = path.join(wtParent, "wt");
  const addResult = run("git", ["worktree", "add", wtPath, "feature/wt"], { cwd: repo });
  if (addResult.status !== 0) {
    return; // skip when git worktree unavailable
  }

  fs.writeFileSync(path.join(wtPath, "README.md"), "x\nchanged\n");
  const target = resolveReviewTarget(wtPath, { scope: "working-tree" });
  const context = collectReviewContext(wtPath, target);
  assert.match(
    context.collectionGuidance,
    /git linked worktree/i,
    "collectionGuidance surfaces the worktree hint"
  );
  assert.ok(context.worktreeContext, "worktreeContext is returned in the context");
});

test("collectReviewContext does NOT include the worktree hint for a normal repo", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "x\nchanged\n");

  const target = resolveReviewTarget(repo, { scope: "working-tree" });
  const context = collectReviewContext(repo, target);
  assert.doesNotMatch(
    context.collectionGuidance,
    /git linked worktree/i,
    "collectionGuidance does not mention worktrees in a normal repo"
  );
  assert.equal(context.worktreeContext, null);
});
