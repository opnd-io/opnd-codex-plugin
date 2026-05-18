#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { cleanProtocolLine } from "./lib/jsonl.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

// Cap accumulated JSONL bytes per client socket to bound broker heap if a peer sends
// an unterminated huge frame. Real Codex messages stay well under this in practice.
const MAX_JSONL_LINE_BYTES = 16 * 1024 * 1024;

// Maximum wait for a broker→client RPC roundtrip. The client should answer interactive
// approval / patch / tool requests quickly; if the socket stays alive but silent the
// pending promise would otherwise leak forever.
const SERVER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
// Single periodic sweep interval (one timer for ALL pending server requests) — avoids
// per-request setTimeout overhead under sustained traffic.
const SERVER_TIMEOUT_SWEEP_MS = 15 * 1000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isActiveTurnControlRequest(message) {
  return message?.method === "turn/interrupt" || message?.method === "turn/steer";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const sockets = new Set();
  const pendingServerRequests = new Map();
  let nextServerRequestId = 1;

  /** @type {NodeJS.Timer | null} */
  let serverTimeoutSweepHandle = null;

  function ensureServerTimeoutSweep() {
    if (serverTimeoutSweepHandle) {
      return;
    }
    serverTimeoutSweepHandle = setInterval(() => {
      const now = Date.now();
      for (const [id, pending] of pendingServerRequests) {
        if (pending.deadline && pending.deadline <= now) {
          pendingServerRequests.delete(id);
          pending.reject(
            new Error(
              `Broker server request "${pending.method}" timed out after ${SERVER_REQUEST_TIMEOUT_MS}ms.`
            )
          );
        }
      }
      if (pendingServerRequests.size === 0 && serverTimeoutSweepHandle) {
        clearInterval(serverTimeoutSweepHandle);
        serverTimeoutSweepHandle = null;
      }
    }, SERVER_TIMEOUT_SWEEP_MS);
    serverTimeoutSweepHandle.unref?.();
  }

  function rejectSocketServerRequests(socket, error) {
    for (const [id, pending] of pendingServerRequests.entries()) {
      if (pending.socket !== socket) {
        continue;
      }
      pendingServerRequests.delete(id);
      pending.reject(error);
    }
    if (pendingServerRequests.size === 0 && serverTimeoutSweepHandle) {
      clearInterval(serverTimeoutSweepHandle);
      serverTimeoutSweepHandle = null;
    }
  }

  function rejectAllPendingServerRequests(error) {
    for (const [id, pending] of pendingServerRequests.entries()) {
      pendingServerRequests.delete(id);
      pending.reject(error);
    }
  }

  function forwardServerRequest(message) {
    const target = activeStreamSocket ?? activeRequestSocket;
    if (!target || target.destroyed) {
      throw new Error(`No active broker client can handle server request: ${message.method}`);
    }

    const id = `server-${nextServerRequestId++}`;
    return new Promise((resolve, reject) => {
      pendingServerRequests.set(id, {
        socket: target,
        resolve,
        reject,
        method: message.method,
        deadline: Date.now() + SERVER_REQUEST_TIMEOUT_MS
      });
      ensureServerTimeoutSweep();
      try {
        send(target, {
          id,
          method: message.method,
          params: message.params ?? {}
        });
      } catch (sendError) {
        // Synchronous send failure would otherwise leave the pending entry in the map
        // until the next sweep tick (SERVER_TIMEOUT_SWEEP_MS). Reject + delete immediately.
        pendingServerRequests.delete(id);
        if (pendingServerRequests.size === 0 && serverTimeoutSweepHandle) {
          clearInterval(serverTimeoutSweepHandle);
          serverTimeoutSweepHandle = null;
        }
        reject(sendError);
      }
    });
  }

  const appClient = await CodexAppServerClient.connect(cwd, {
    disableBroker: true,
    serverRequestHandler: forwardServerRequest
  });

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    // Reject any in-flight server-side RPCs and tear down the sweep timer so the broker
    // exits cleanly even if the event loop is otherwise idle.
    rejectAllPendingServerRequests(new Error("Broker is shutting down."));
    if (serverTimeoutSweepHandle) {
      clearInterval(serverTimeoutSweepHandle);
      serverTimeoutSweepHandle = null;
    }
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_JSONL_LINE_BYTES && buffer.indexOf("\n") === -1) {
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `JSONL frame exceeds ${MAX_JSONL_LINE_BYTES} bytes without a newline.`)
        });
        buffer = "";
        socket.destroy();
        return;
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        // PR-G-A (#23 / upstream #24 + #311) — strip terminal/locale
        // noise (ANSI / OSC, Windows CP-950 taskkill prefix) before
        // JSON.parse so a single garbage byte from a TTY-inherited
        // subprocess does not poison the broker connection.
        const candidate = cleanProtocolLine(line);
        if (candidate === null) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(candidate);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === undefined) {
          const pending = pendingServerRequests.get(message.id);
          if (!pending || pending.socket !== socket) {
            continue;
          }
          pendingServerRequests.delete(message.id);
          if (message.error) {
            pending.reject(new Error(message.error.message ?? "Broker server request failed."));
          } else {
            pending.resolve(message.result ?? {});
          }
          if (pendingServerRequests.size === 0 && serverTimeoutSweepHandle) {
            clearInterval(serverTimeoutSweepHandle);
            serverTimeoutSweepHandle = null;
          }
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowActiveTurnControlDuringActiveStream =
          isActiveTurnControlRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowActiveTurnControlDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowActiveTurnControlDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      rejectSocketServerRequests(socket, new Error("Broker client disconnected before server request was resolved."));
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      rejectSocketServerRequests(socket, new Error("Broker client errored before server request was resolved."));
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  startIdleWatchdog({ sockets, shutdown: () => shutdown(server) });

  server.listen(listenTarget.path);
}

// Self-exit when the broker has been idle (no connected sockets) for a long stretch. The
// broker is `detached: true` + `child.unref()`-d, so when the parent Claude session is
// killed hard (no SessionEnd fired) the broker would otherwise persist forever. This is
// the fallback safety net; SessionEnd still drives graceful shutdown in the normal path.
//
// PR-1.7 (#193) — defaults tightened from 30→10min grace + 5→2min interval so an orphan
// broker is reaped within ~12min instead of ~35min in the worst case. Both knobs are
// configurable via env so deployments with very long-running brokers can opt out:
//
//   CODEX_BROKER_IDLE_GRACE_MS=<ms>       (default 600000 — 10 min)
//   CODEX_BROKER_IDLE_INTERVAL_MS=<ms>    (default 120000 — 2 min)
function clampPositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}
const IDLE_WATCHDOG_INTERVAL_MS = clampPositiveInt(
  process.env.CODEX_BROKER_IDLE_INTERVAL_MS,
  2 * 60 * 1000
);
const IDLE_WATCHDOG_GRACE_MS = clampPositiveInt(
  process.env.CODEX_BROKER_IDLE_GRACE_MS,
  10 * 60 * 1000
);

function startIdleWatchdog({ sockets, shutdown }) {
  let lastActiveAt = Date.now();
  const refresh = () => {
    lastActiveAt = Date.now();
  };
  const timer = setInterval(async () => {
    if (sockets.size > 0) {
      refresh();
      return;
    }
    if (Date.now() - lastActiveAt < IDLE_WATCHDOG_GRACE_MS) {
      return;
    }
    process.stderr.write(`broker idle for ${IDLE_WATCHDOG_GRACE_MS}ms — self-exiting\n`);
    try {
      await shutdown();
    } catch {
      // ignore — best-effort, process.exit forces termination below
    }
    process.exit(0);
  }, IDLE_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
