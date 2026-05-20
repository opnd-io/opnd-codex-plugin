import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

// PR-1.6 (#247) — sync fs.readFileSync(0, "utf8") crashes with EAGAIN whenever
// the parent (Claude Code, an MCP host, certain CI runners) hands us a stdin
// file descriptor that is not in blocking mode. The original sync helper is
// preserved for callers that already gate on isTTY in environments known to
// be safe (e.g. internal smoke scripts), but the async variant should be
// preferred everywhere parent stdio behavior is not under our control.
export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}

/**
 * Async, event-based stdin drain with a hard timeout. Safe for hook scripts
 * that may be spawned with a stdin fd that never closes (Windows Git Bash
 * Stop hook, parallel sessions sharing a non-blocking pipe, etc.).
 *
 * Returns "" when stdin is a TTY, when no data arrives within the timeout, or
 * when stdin emits an error. Callers parse the result.
 */
export async function readStdinAsync({ timeoutMs = 5000 } = {}) {
  if (process.stdin.isTTY) {
    return "";
  }
  return await new Promise((resolve) => {
    const stream = process.stdin;
    let settled = false;
    const chunks = [];

    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk) => {
      chunks.push(chunk);
    };
    const onEnd = () => {
      settle(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => {
      // Treat read errors as "no input" so the caller can fall back to its
      // empty-input branch instead of crashing.
      settle(Buffer.concat(chunks).toString("utf8"));
    };

    function cleanup() {
      try {
        stream.removeListener("data", onData);
        stream.removeListener("end", onEnd);
        stream.removeListener("error", onError);
      } catch {
        // ignore
      }
      try {
        stream.pause();
      } catch {
        // ignore
      }
    }

    const timer = setTimeout(() => settle(Buffer.concat(chunks).toString("utf8")), timeoutMs);
    timer.unref?.();

    try {
      stream.on("data", onData);
      stream.on("end", onEnd);
      stream.on("error", onError);
      stream.resume();
    } catch {
      // If we cannot even attach listeners, give up gracefully.
      clearTimeout(timer);
      settle("");
    }
  });
}

/**
 * Convenience helper for hook scripts: read stdin async (with timeout),
 * trim, JSON.parse, and tolerate empty / malformed input by returning {}.
 * This collapses three repeated try/catch patterns at hook entrypoints.
 */
export async function readHookStdinJsonAsync({ timeoutMs = 5000 } = {}) {
  const raw = (await readStdinAsync({ timeoutMs })).trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
