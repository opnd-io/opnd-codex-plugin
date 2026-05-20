import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hashText } from "./task-identity.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const CAPSULE_DIR = path.join(".claude", "cache", "codex-capsules");
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAuthorization:\s*Bearer\s+\S+/i,
  /\bOPENAI_API_KEY\s*=/i,
  /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE)\s*=\s*[^\s]+/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bage1[0-9a-z]{20,}/,
  /\bSOPS\b/i
];

function normalizePath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function allowedCapsuleRoots(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  return [
    path.join(workspaceRoot, CAPSULE_DIR),
    path.join(os.homedir(), CAPSULE_DIR)
  ].map((root) => normalizePath(root));
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { metadata: {}, body: raw };
  }
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return { metadata: {}, body: raw };
  }
  const metadata = {};
  const header = normalized.slice(4, end);
  for (const line of header.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    metadata[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return { metadata, body: normalized.slice(end + "\n---\n".length) };
}

function assertNoSecrets(raw, capsulePath) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) {
      throw new Error(`Capsule ${capsulePath} appears to contain secret-like material; refusing to pass it to Codex.`);
    }
  }
}

export function readCapsule(cwd, capsulePath) {
  if (!capsulePath) {
    throw new Error("Missing --capsule <path>.");
  }
  const requested = path.isAbsolute(capsulePath) ? capsulePath : path.resolve(cwd, capsulePath);
  const realPath = normalizePath(requested);
  const roots = allowedCapsuleRoots(cwd);
  if (!roots.some((root) => isWithin(root, realPath))) {
    throw new Error(
      `Capsule path must stay under ${CAPSULE_DIR} in the workspace or user home. Received: ${capsulePath}`
    );
  }
  const raw = fs.readFileSync(realPath, "utf8");
  assertNoSecrets(raw, realPath);
  const parsed = parseFrontmatter(raw);
  return {
    path: realPath,
    raw,
    prompt: parsed.body.trim(),
    metadata: parsed.metadata,
    hash: hashText(raw),
    bodyHash: hashText(parsed.body),
    profileId: parsed.metadata.profile_id ?? parsed.metadata.profile ?? null,
    profileVersion: parsed.metadata.profile_version ?? null,
    profileHash: parsed.metadata.profile_hash ?? null
  };
}
