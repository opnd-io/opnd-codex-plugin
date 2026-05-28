import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

function splitPathList(value, platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  return String(value ?? "")
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function windowsPathExts(env = process.env) {
  return String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function windowsCommandCandidates(command, env = process.env) {
  const hasPathSeparator = /[\\/]/.test(command);
  const searchDirs = hasPathSeparator ? [""] : splitPathList(env.PATH, "win32");
  const parsed = path.win32.parse(command);
  const extensions = parsed.ext ? [""] : windowsPathExts(env);
  const candidates = [];

  for (const dir of searchDirs) {
    const base = dir ? path.win32.join(dir, command) : command;
    for (const ext of extensions) {
      candidates.push(`${base}${ext}`);
    }
    if (!parsed.ext) {
      candidates.push(base);
    }
  }

  return candidates;
}

function resolveWindowsCommand(command, env = process.env) {
  for (const candidate of windowsCommandCandidates(command, env)) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.realpathSync.native?.(candidate) ?? fs.realpathSync(candidate);
      }
    } catch {
      // Ignore unreadable PATH entries and keep searching.
    }
  }
  return command;
}

function quoteWindowsCmdArg(value) {
  const text = String(value ?? "");
  if (!text) {
    return '""';
  }
  return `"${text.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

export function buildCommandInvocation(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args, shell: false, windowsVerbatimArguments: false };
  }

  const resolvedCommand = resolveWindowsCommand(command, options.env ?? process.env);
  const extension = path.win32.extname(resolvedCommand).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", ["call", quoteWindowsCmdArg(resolvedCommand), ...args.map(quoteWindowsCmdArg)].join(" ")],
      shell: false,
      windowsVerbatimArguments: true
    };
  }

  return {
    command: resolvedCommand,
    args,
    shell: false,
    windowsVerbatimArguments: false
  };
}

export function runCommand(command, args = [], options = {}) {
  const invocation = buildCommandInvocation(command, args, {
    env: options.env,
    platform: options.platform
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isProcessRunning(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isProcessRunningImpl = options.isProcessRunningImpl ?? ((targetPid) => isProcessRunning(targetPid, killImpl));

  if (platform === "win32") {
    // #331 — wrap via cmd.exe /d /s /c so MSYS/Git-Bash does not translate
    //         /PID to a filesystem path (e.g. C:/Program Files/Git/PID).
    const result = runCommandImpl("cmd.exe", ["/d", "/s", "/c", "taskkill", "/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }
    if (!result.error && !isProcessRunningImpl(pid)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
