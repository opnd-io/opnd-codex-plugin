/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { buildCommandInvocation, terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

// PR-4.5 mitigation (#310) — detect a non-UTF-8 host locale and inject a
// UTF-8 locale into the spawned codex env so its internal JSONL parser does
// not crash on a Big5 / GBK / EUC-* byte sequence emitted by some Codex
// CLI builds. The upstream root cause lives in the codex CLI itself
// (zh-TW reproducer is the most cited), but the plugin can mitigate
// end-to-end by forcing the codex subprocess to a UTF-8 locale even when
// the user's shell is something else.
//
// Behavior:
//   - Default ON. If the host LANG / LC_ALL is missing or non-UTF-8, the
//     spawned codex gets `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`. The user's
//     own shell env is untouched (we only mutate the child env).
//   - Opt out with `CODEX_PLUGIN_PRESERVE_LOCALE=1`. Users who depend on
//     localized codex output (translated messages, region-specific
//     formats) keep their original locale at the cost of the #310 crash
//     risk on non-UTF-8 systems.
//   - Idempotent. A pre-set UTF-8 locale (LANG=ja_JP.UTF-8, LC_ALL=…)
//     passes through unchanged — we only override when the existing
//     value is missing or non-UTF-8.
//
// Returns `{ env, applied }` where `applied` is true iff this call
// actually injected the override. Callers (the spawn path) can use the
// `applied` flag to surface a one-shot stderr notice the first time the
// override fires, so the user is not surprised by a silent locale
// rewrite affecting codex output.
const LOCALE_PRESERVE_ENV = "CODEX_PLUGIN_PRESERVE_LOCALE";

function looksUtf8Locale(value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (trimmed === "") return false;
  return /\.utf-?8\b/i.test(trimmed) || trimmed.toUpperCase() === "C.UTF-8" || trimmed === "POSIX.UTF-8";
}

// Audit finding #1 (HIGH) — POSIX precedence: LC_ALL > LC_CTYPE > LANG.
// LC_ALL=C with LANG=en_US.UTF-8 gives codex an effective C (non-UTF-8)
// locale, but the old `looksUtf8Locale(LC_ALL) || looksUtf8Locale(LANG)`
// check would short-circuit on LANG and skip the mitigation. Walk the
// precedence ladder explicitly and only consult the next variable when
// the current one is unset or empty.
function effectiveLocaleIsUtf8(baseEnv) {
  for (const key of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const value = baseEnv[key];
    if (value == null || String(value).trim() === "") continue;
    return looksUtf8Locale(value);
  }
  // Nothing set at all — codex CLI then reads the OS default. We treat
  // that as non-UTF-8 (the conservative choice) so the mitigation fires
  // on bare-bones shells too.
  return false;
}

export function applyUtf8LocaleOverride(targetEnv, baseEnv = targetEnv) {
  if (String(baseEnv[LOCALE_PRESERVE_ENV] ?? "").trim() === "1") {
    return { env: targetEnv, applied: false };
  }
  if (effectiveLocaleIsUtf8(baseEnv)) {
    return { env: targetEnv, applied: false };
  }
  // Audit finding #3 (LOW) — `C.UTF-8` is a glibc-ism. Modern Windows 10+
  // accepts it via the UCRT, but the codex CLI on Windows runs through
  // its own runtime layer that historically prefers `en_US.UTF-8`. On
  // POSIX `C.UTF-8` is the most portable UTF-8 sentinel (no locale data
  // files required). Use the platform-appropriate value.
  const override = process.platform === "win32" ? "en_US.UTF-8" : "C.UTF-8";
  return {
    env: { ...targetEnv, LC_ALL: override, LANG: override },
    applied: true
  };
}

// Module-level guard so the locale-override notice prints at most once per
// process even if buildPluginCodexEnv is called repeatedly (broker init +
// every retry path).
let localeOverrideNoticeEmitted = false;

// Test-only: reset the warn-once latch + the locale-override notice.
// Production callers never invoke this; tests use it to keep cases isolated.
//
// Audit finding #5 (LOW) — exposed from production source on purpose.
// The double-underscore prefix follows the repo's existing test-helper
// convention (see e.g. tests/state.test.mjs callers in lib/state.mjs).
// We do NOT gate behind NODE_ENV because the repo's normal test entrypoint
// (`node --test`) does not set it, and a NODE_ENV check would silently
// break the test suite without producing an actionable error.
export function __resetAppServerNoticeCache() {
  localeOverrideNoticeEmitted = false;
}

// PR-5.6 (#282) BREAKING — build the env we hand to plugin-spawned codex
// children. Adds CODEX_HOME=$HOME/.codex/claude-code/ so plugin sessions
// land in a dedicated home that Codex Desktop ignores. Restoring the
// shared home is a single env var: CODEX_PLUGIN_USE_DEFAULT_HOME=1.
//
// Exposed so the broker spawn path (broker-lifecycle.mjs) can build the
// same env. Pure function — no side effects, safe to call repeatedly
// (notice emission is gated by the module-level latch above).
export function buildPluginCodexEnv(baseEnv = process.env) {
  // Compose the home-isolation transform first, then the locale-override
  // transform on top. Both transforms are idempotent and only mutate the
  // child env (never the caller's).
  let result;
  if (String(baseEnv.CODEX_PLUGIN_USE_DEFAULT_HOME ?? "").trim() === "1") {
    result = { ...baseEnv };
  } else if (baseEnv.CODEX_HOME && String(baseEnv.CODEX_HOME).trim()) {
    // Honor a pre-set CODEX_HOME so the user can pin a custom location.
    result = { ...baseEnv };
  } else {
    const home = baseEnv.HOME ?? baseEnv.USERPROFILE;
    if (!home) {
      result = { ...baseEnv };
    } else {
      const pluginCodexHome = path.join(home, ".codex", "claude-code");
      try {
        fs.mkdirSync(pluginCodexHome, { recursive: true });
      } catch {
        // best-effort; codex CLI will surface a real error if it cannot use it
      }
      result = { ...baseEnv, CODEX_HOME: pluginCodexHome };
    }
  }

  // PR-4.5 mitigation — overlay the UTF-8 locale override.
  //
  // Audit finding #2 (MEDIUM) trade-off: the broker reuses one running
  // codex child for many requests, so this override is captured at broker
  // start and frozen for the broker's lifetime. Mid-session changes to
  // LANG / LC_ALL / CODEX_PLUGIN_PRESERVE_LOCALE require a broker restart
  // (sendBrokerShutdown or the idle-watchdog) to take effect. Documented
  // limitation; the realistic case is "user fixes locale, then resumes"
  // for which a restart is already needed.
  const localeResult = applyUtf8LocaleOverride(result, baseEnv);
  if (localeResult.applied && !localeOverrideNoticeEmitted) {
    // Audit finding #4 (LOW) trade-off: flip the latch BEFORE the write
    // so even a broken stderr collapses the notice attempt to "happens
    // once" rather than "retries forever and pollutes the log". The
    // "attempted-once" wording is intentional — see the helper comment.
    localeOverrideNoticeEmitted = true;
    const overrideTarget = process.platform === "win32" ? "en_US.UTF-8" : "C.UTF-8";
    try {
      process.stderr.write(
        `[codex-plugin-cc] non-UTF-8 host locale detected (LANG=${baseEnv.LANG ?? "<unset>"}, LC_ALL=${baseEnv.LC_ALL ?? "<unset>"}). ` +
          `Spawning codex with LANG=${overrideTarget} + LC_ALL=${overrideTarget} to avoid the #310 JSONL parser crash. ` +
          `Restore your host locale with CODEX_PLUGIN_PRESERVE_LOCALE=1.\n`
      );
    } catch {
      // best-effort; never break the spawn path because stderr is broken
    }
  }
  return localeResult.env;
}

/** @type {ClientInfo} */
//
// PR-5.1 (#199 / #276) — the previous default `name: "Claude Code"` collided
// with the upstream Codex CLI's allow-list for newer models. gpt-5.5 responded
// with 400 invalid_request_error when the plugin identified itself as a host
// product rather than its own client surface. The codex-namespaced identifier
// lets the upstream allow-list / telemetry treat the plugin as a first-class
// client without leaking the host app name through the API.
//
// `title` keeps "Codex Plugin" so users still see a recognizable label in any
// UI that surfaces it.
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "codex-plugin-cc",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

// Cap accumulated JSONL bytes to bound heap if the peer sends an unterminated huge frame.
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;
// Retain only the trailing slice of the child process stderr so a long-running broker
// does not accumulate stderr forever. 64 KiB is enough to capture the recent failure context.
const MAX_STDERR_BYTES = 64 * 1024;
// Maximum wait for an app-server RPC response. Long-running turn requests are normal,
// but a truly non-responsive child should not pin pending promises forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
// Single periodic sweep instead of per-request setTimeout — avoids libuv timer-wheel
// pressure under sustained RPC traffic on Windows (observed: per-request setTimeout
// slowed task --background full-suite tests from <15 s to >22 s).
const TIMEOUT_SWEEP_INTERVAL_MS = 30 * 1000;

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function appendBoundedStderr(existing, chunk, max = MAX_STDERR_BYTES) {
  const merged = existing + chunk;
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timeoutSweepHandle = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  ensureTimeoutSweep() {
    if (this.timeoutSweepHandle || this.closed) {
      return;
    }
    this.timeoutSweepHandle = setInterval(() => {
      const now = Date.now();
      for (const [id, pending] of this.pending) {
        if (pending.deadline && pending.deadline <= now) {
          this.pending.delete(id);
          pending.reject(
            createProtocolError(
              `codex app-server ${pending.method} timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`
            )
          );
        }
      }
      if (this.pending.size === 0 && this.timeoutSweepHandle) {
        clearInterval(this.timeoutSweepHandle);
        this.timeoutSweepHandle = null;
      }
    }, TIMEOUT_SWEEP_INTERVAL_MS);
    this.timeoutSweepHandle.unref?.();
  }

  clearTimeoutSweep() {
    if (this.timeoutSweepHandle) {
      clearInterval(this.timeoutSweepHandle);
      this.timeoutSweepHandle = null;
    }
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        method,
        deadline: Date.now() + DEFAULT_REQUEST_TIMEOUT_MS
      });
      this.ensureTimeoutSweep();
      try {
        this.sendMessage({ id, method, params });
      } catch (sendError) {
        // sendMessage failed synchronously — the pending entry would otherwise sit until
        // the next sweep tick (TIMEOUT_SWEEP_INTERVAL_MS). Reject immediately + delete.
        this.pending.delete(id);
        if (this.pending.size === 0) {
          this.clearTimeoutSweep();
        }
        reject(sendError);
      }
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    if (this.lineBuffer.length > MAX_JSONL_LINE_BYTES && this.lineBuffer.indexOf("\n") === -1) {
      const overflowError = createProtocolError(
        `Codex app-server JSONL frame exceeds ${MAX_JSONL_LINE_BYTES} bytes without a newline.`,
        { code: -32700 }
      );
      this.lineBuffer = "";
      this.handleExit(overflowError);
      return;
    }
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      if (this.pending.size === 0) {
        this.clearTimeoutSweep();
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  async handleServerRequest(message) {
    const handler = this.options.serverRequestHandler ?? null;
    if (!handler) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
      });
      return;
    }

    try {
      const result = await handler(message, this);
      this.sendMessage({ id: message.id, result: result ?? {} });
    } catch (error) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(error?.rpcCode ?? -32000, error instanceof Error ? error.message : String(error))
      });
    }
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.clearTimeoutSweep();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    // PR-5.5 (#251) — when the caller selected a Codex profile, pass it through
    // to the codex CLI via the `-c profile=<name>` config-override syntax so
    // the app-server picks up `[profiles.<name>]` from ~/.codex/config.toml
    // without requiring the user to flip their global default first.
    const codexArgs = ["app-server"];
    if (typeof this.options.profile === "string" && this.options.profile.trim()) {
      codexArgs.push("-c", `profile=${this.options.profile.trim()}`);
    }
    // PR-7.6 (#210) — pass through the Codex fast service tier via the
    // `-c service_tier=fast` config override, matching the codex CLI's
    // own /fast on equivalent. Trade ~2x credits for ~1.5x speed.
    if (this.options.fast) {
      codexArgs.push("-c", `service_tier=fast`);
    }
    // PR-5.6 (#282) BREAKING — plugin-launched codex children get a dedicated
    // CODEX_HOME so their sessions / history feed do not pollute the user's
    // Codex Desktop view. Default: $HOME/.codex/claude-code/. Restore legacy
    // shared home with CODEX_PLUGIN_USE_DEFAULT_HOME=1.
    const childEnv = buildPluginCodexEnv(this.options.env ?? process.env);
    const invocation = buildCommandInvocation("codex", codexArgs, {
      env: childEnv
    });
    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr = appendBoundedStderr(this.stderr, chunk);
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const detail =
        code === 0
          ? null
          : createProtocolError(`codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows, .cmd shims are launched through cmd.exe. Kill the
          // whole tree so the app-server child cannot outlive the wrapper.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}
