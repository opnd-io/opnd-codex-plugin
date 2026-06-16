import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { makeTempDir } from "./helpers.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/opnd-codex/scripts/lib/broker-endpoint.mjs";
import { sendBrokerSpawnWorker } from "../plugins/opnd-codex/scripts/lib/broker-lifecycle.mjs";

// #18 — sendBrokerSpawnWorker is the client half of the broker-routed worker
// spawn that lets a background task-worker escape a nested subagent Job Object.
// These tests exercise the socket RPC deterministically with a fake server;
// the real broker-side spawn (worker escaping the kill-on-close job) is verified
// out-of-band with a Win32 job-object probe.

function startFakeBroker(onMessage) {
  const sessionDir = makeTempDir();
  const endpoint = createBrokerEndpoint(sessionDir);
  const target = parseBrokerEndpoint(endpoint);
  const received = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        if (msg) {
          received.push(msg);
          const reply = onMessage(msg, socket);
          if (reply !== undefined && reply !== null) {
            socket.write(`${JSON.stringify(reply)}\n`);
          }
        }
        nl = buffer.indexOf("\n");
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(target.path, () => {
      resolve({
        endpoint,
        received,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          })
      });
    });
  });
}

test("sendBrokerSpawnWorker returns the broker result and forwards params", async () => {
  const fake = await startFakeBroker((msg) => ({ id: msg.id, result: { pid: 4321 } }));
  try {
    const result = await sendBrokerSpawnWorker(fake.endpoint, {
      cwd: "C:/work",
      jobId: "task-abc",
      env: { CODEX_PLUGIN_DATA_DIR: "C:/data" }
    });
    assert.deepEqual(result, { pid: 4321 });
    assert.equal(fake.received.length, 1);
    assert.equal(fake.received[0].method, "broker/spawnWorker");
    assert.equal(fake.received[0].params.jobId, "task-abc");
    assert.equal(fake.received[0].params.cwd, "C:/work");
    assert.equal(fake.received[0].params.env.CODEX_PLUGIN_DATA_DIR, "C:/data");
  } finally {
    await fake.close();
  }
});

test("sendBrokerSpawnWorker returns null when the broker replies with an error (safe to local-spawn)", async () => {
  // An explicit error reply means the broker did NOT spawn a worker, so the
  // caller is free to local-spawn — this must be `null`, NOT ambiguous.
  const fake = await startFakeBroker((msg) => ({
    id: msg.id,
    error: { code: -32000, message: "spawn failed" }
  }));
  try {
    const result = await sendBrokerSpawnWorker(fake.endpoint, { cwd: "C:/work", jobId: "task-err" });
    assert.equal(result, null);
  } finally {
    await fake.close();
  }
});

test("sendBrokerSpawnWorker passes a pid-less result through verbatim (NOT ambiguous)", async () => {
  // A `{result:{}}` (broker replied but no pid) is a definite reply, so it must
  // resolve to the raw result `{}` — NOT `{ambiguous:true}`. The caller's
  // `Number(result.pid)` is NaN → it then local-spawns. This guards against a
  // refactor turning a no-pid reply into the double-spawn-guard path.
  const fake = await startFakeBroker((msg) => ({ id: msg.id, result: {} }));
  try {
    const result = await sendBrokerSpawnWorker(fake.endpoint, { cwd: "C:/work", jobId: "task-nopid" });
    assert.deepEqual(result, {});
    assert.notEqual(result?.ambiguous, true);
  } finally {
    await fake.close();
  }
});

test("sendBrokerSpawnWorker returns null when no broker is listening (never connected)", async () => {
  const sessionDir = makeTempDir();
  const endpoint = createBrokerEndpoint(sessionDir); // nothing listening on it
  const result = await sendBrokerSpawnWorker(endpoint, { cwd: "C:/work", jobId: "task-none" }, 200);
  assert.equal(result, null);
});

test("sendBrokerSpawnWorker returns { ambiguous: true } on connected-but-no-reply", async () => {
  // Connected but silent: the broker MAY have spawned a worker, so the caller
  // must NOT local-spawn. This is the double-spawn guard (#18 HIGH-2).
  const fake = await startFakeBroker(() => undefined); // accept but never respond
  try {
    const start = Date.now();
    const result = await sendBrokerSpawnWorker(fake.endpoint, { cwd: "C:/work", jobId: "task-hang" }, 200);
    assert.deepEqual(result, { ambiguous: true });
    assert.ok(Date.now() - start >= 150, "respected the timeout window");
  } finally {
    await fake.close();
  }
});
