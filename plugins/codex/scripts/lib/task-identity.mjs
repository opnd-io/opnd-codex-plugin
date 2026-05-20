import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function hashBuffer(value, length = 64) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function hashText(value, length = 64) {
  return hashBuffer(String(value ?? ""), length);
}

export function sanitizeTaskKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || null;
}

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 5000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim();
    throw new Error(detail);
  }
  return String(result.stdout ?? "");
}

function readFileHash(filePath) {
  try {
    return hashBuffer(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

export function resolveCodexHomeIdentity(env = process.env) {
  const configured = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : null;
  const defaultHome = path.join(os.homedir(), ".codex");
  const effectiveHome =
    configured && String(env.CODEX_PLUGIN_USE_DEFAULT_HOME ?? "").trim() !== "1" ? configured : defaultHome;
  const candidates = [
    path.join(effectiveHome, "config.toml"),
    path.join(effectiveHome, "AGENTS.md"),
    path.join(effectiveHome, "version")
  ];
  const existing = candidates
    .map((filePath) => ({ filePath, hash: readFileHash(filePath) }))
    .filter((entry) => entry.hash);
  return {
    mode: configured ? "explicit" : "default",
    home: effectiveHome,
    hash: hashText(JSON.stringify(existing.map((entry) => [path.basename(entry.filePath), entry.hash])), 32)
  };
}

export function buildExecutionFingerprint(cwd, options = {}) {
  const codexHome = options.codexHome ?? resolveCodexHomeIdentity(options.env ?? process.env);
  const base = {
    version: 1,
    cwd: path.resolve(cwd),
    model: options.model ?? null,
    effort: options.effort ?? null,
    profile: options.profile ?? null,
    sandbox: options.sandbox ?? null,
    approvalPolicy: options.approvalPolicy ?? null,
    write: Boolean(options.write),
    outputProfile: options.outputProfile ?? null,
    codexHomeMode: codexHome.mode,
    codexHomeHash: codexHome.hash,
    git: null,
    gitProbeFailed: false
  };

  try {
    const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
    const head = runGit(cwd, ["rev-parse", "HEAD"]).trim();
    const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      maxBuffer: 32 * 1024 * 1024
    });
    let diffHash = null;
    try {
      diffHash = hashText(runGit(cwd, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], {
        timeoutMs: 15000,
        maxBuffer: 64 * 1024 * 1024
      }));
    } catch (error) {
      diffHash = `unavailable:${hashText(error.message, 16)}`;
    }
    base.git = {
      root: gitRoot,
      head,
      branch,
      statusHash: hashText(status),
      diffHash
    };
  } catch (error) {
    base.gitProbeFailed = true;
    base.gitError = error instanceof Error ? error.message : String(error);
  }

  return {
    ...base,
    hash: hashText(JSON.stringify(base))
  };
}

export function buildPromptFingerprint(prompt, options = {}) {
  return {
    version: 1,
    promptHash: hashText(prompt),
    capsuleHash: options.capsuleHash ?? null,
    contextHash: options.context ? hashText(options.context) : null,
    appendInstructionHash: options.appendInstruction ? hashText(options.appendInstruction) : null
  };
}
