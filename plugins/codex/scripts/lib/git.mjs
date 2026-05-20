import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef, tipRef = "HEAD") {
  // PR-7.5 (#114) — tipRef defaults to HEAD for the legacy "review my current
  // branch against base" flow, but can be overridden so the user can review a
  // remote ref (e.g. origin/feature-branch) without checking it out first.
  //
  // PR-G-C (manual port of upstream PR #290) — pass `--end-of-options`
  // before any user-controlled ref so a dash-prefixed value (`-X`, `--foo`)
  // cannot be silently re-interpreted as a git flag. Hardens the same
  // class of git ref-injection footgun the upstream PR targets without
  // changing the success path.
  const mergeBase = gitChecked(cwd, ["merge-base", "--end-of-options", tipRef, baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..${tipRef}`,
    reviewRange: `${baseRef}...${tipRef}`,
    tipRef
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

// PR-4.7 (#280) — detect whether cwd is a git worktree (i.e. .git is a
// pointer file rather than a directory). Returns null when not a worktree
// or the lookup fails; the caller surfaces this in the review prompt so
// Codex does not waste sandbox-declined commands probing `.git`, `safe.directory`,
// or `--git-dir=` tricks before its first `git diff` succeeds.
export function detectWorktreeContext(cwd) {
  try {
    const gitDir = git(cwd, ["rev-parse", "--git-dir"]);
    const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
    if (gitDir.status !== 0 || commonDir.status !== 0) {
      return null;
    }
    const gitDirPath = gitDir.stdout.trim();
    const commonDirPath = commonDir.stdout.trim();
    // A linked worktree's git-dir lives under .git/worktrees/<name>/ of the
    // common dir. When gitDir and commonDir agree, this is the main worktree.
    const isLinkedWorktree = gitDirPath !== commonDirPath && /[\\/]worktrees[\\/]/.test(gitDirPath);
    if (!isLinkedWorktree) {
      return null;
    }
    return {
      gitDir: gitDirPath,
      commonDir: commonDirPath
    };
  } catch {
    return null;
  }
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const tipRef = options.branch ?? options.tip ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  // PR-7.5 (#114) — `--branch <ref>` reviews the given ref against the default
  // branch (or against --base if also supplied) without checking out the ref
  // locally. Useful for daily PR review: pass `origin/feature-x` and read the
  // adversarial output without disrupting the current working tree.
  if (tipRef) {
    const effectiveBase = baseRef ?? detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff: ${tipRef} against ${effectiveBase}`,
      baseRef: effectiveBase,
      tipRef,
      explicit: true
    };
  }

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const tipRef = options.tipRef ?? "HEAD";
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef, tipRef);
  const currentBranch = getCurrentBranch(cwd);
  // PR-G-C (manual port of upstream PR #290) — same `--end-of-options`
  // ref-injection guard as buildBranchComparison. `commitRange` is built
  // from user-controlled `baseRef` / `tipRef`, so it inherits the same
  // hazard (`-X..HEAD`, `--foo...HEAD`, etc.) and gets the same guard.
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", "--end-of-options", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", "--end-of-options", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", "--end-of-options", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", "--end-of-options", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  const lines = [];
  if (options.includeDiff !== false) {
    lines.push("Use the repository context below as primary evidence.");
  } else {
    lines.push(
      "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings."
    );
  }

  // PR-4.7 (#280) — when the workspace is a git worktree, surface that fact
  // up front so Codex does not waste 10+ sandbox-declined commands probing
  // for the gitdir pointer file and trying --git-dir / safe.directory tricks.
  // The worktree's git operations already work in plain form (`git diff`,
  // `git status`) because the worktree shares the parent repo's object store.
  if (options.worktreeContext) {
    lines.push(
      "Note: this workspace is a git linked worktree. Plain git commands (e.g. `git diff <ref>`, `git status`) work directly from this cwd; the worktree shares objects with the parent repository. Do NOT pass `--git-dir=...`, `--work-tree=...`, or `safe.directory` overrides — they are unnecessary and the sandbox will decline most of them."
    );
  }
  return lines.join("\n");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  // PR-4.7 (#280) — detect from the user-provided cwd, not the resolved
  // repoRoot, so the worktree pointer hits before we normalize away.
  const worktreeContext = detectWorktreeContext(cwd);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    // PR-7.5 (#114) — tipRef defaults to HEAD; --branch <ref> overrides it
    // so the review diff range becomes mergeBase..<remote-ref> instead of
    // mergeBase..HEAD, letting users review a remote branch without checkout.
    const tipRef = target.tipRef ?? "HEAD";
    const comparison = buildBranchComparison(repoRoot, target.baseRef, tipRef);
    // PR-G-C (manual port of upstream PR #290) — `comparison.commitRange` is
    // built from user-controlled `baseRef` / `tipRef`, so both git diff
    // invocations below need the same `--end-of-options` ref-injection guard
    // as collectBranchContext (git.mjs:325-338).
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", "--end-of-options", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", "--end-of-options", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, tipRef });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff, worktreeContext }),
    worktreeContext,
    ...details
  };
}
