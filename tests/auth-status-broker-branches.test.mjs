/**
 * auth-status-broker-branches.test.mjs — Codex R1 M2 regression
 *
 * lib/codex.mjs 의 getCodexAuthStatusFromClient catch 분기 직접 검증:
 * - BROKER_BUSY_RPC_CODE (-32001) → loggedIn: null + transient: true
 * - timeout / ECONNRESET / EPIPE pattern → loggedIn: null + transient: true (recovery hint cross-platform 포함)
 * - 기타 error → 기존 loggedIn: false 동작 보존
 *
 * 본 세션 (2026-05-28) 직접 발견 + 복구:
 * - "Shared Codex broker is busy." → BROKER_BUSY_RPC_CODE -32001
 * - "codex app-server account/read timed out after 1800000ms." → timeout regex
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const codex = await import("../plugins/opnd-codex/scripts/lib/codex.mjs");
const { getCodexAuthStatusFromClient, BROKER_BUSY_RPC_CODE } = codex.__testHooks;

function makeMockClient(error) {
  return {
    async request() {
      throw error;
    },
  };
}

test("getCodexAuthStatusFromClient — BROKER_BUSY_RPC_CODE → loggedIn:null + transient:true", async () => {
  const brokerBusy = Object.assign(new Error("Shared Codex broker is busy."), { rpcCode: BROKER_BUSY_RPC_CODE });
  const result = await getCodexAuthStatusFromClient(makeMockClient(brokerBusy), "/tmp");
  assert.equal(result.loggedIn, null, "loggedIn must be null (not false — false-negative 회피)");
  assert.equal(result.transient, true, "transient field must be present");
  assert.match(result.detail, /Broker busy/);
  assert.match(result.detail, /Retry setup/);
});

test("getCodexAuthStatusFromClient — account/read timeout → loggedIn:null + transient:true + cross-platform recovery hint", async () => {
  const timeoutErr = new Error("codex app-server account/read timed out after 1800000ms.");
  const result = await getCodexAuthStatusFromClient(makeMockClient(timeoutErr), "/tmp");
  assert.equal(result.loggedIn, null, "loggedIn must be null (broker stuck != logged out)");
  assert.equal(result.transient, true, "transient field must be present");
  assert.match(result.detail, /Broker stuck/);
  assert.match(result.detail, /timed out after 1800000ms/);
  // Codex R1 LOW #3: cross-platform recovery hint
  assert.match(result.detail, /Windows PowerShell/, "Windows recovery hint 포함");
  assert.match(result.detail, /macOS\/Linux/, "macOS/Linux recovery hint 포함");
  assert.match(result.detail, /pkill -f 'codex\.\*app-server'/, "POSIX pkill 안내 포함");
});

test("getCodexAuthStatusFromClient — ECONNRESET / EPIPE 도 transient 처리", async () => {
  for (const msg of ["socket hang up: ECONNRESET", "write EPIPE", "Connection timeout"]) {
    const err = new Error(msg);
    const result = await getCodexAuthStatusFromClient(makeMockClient(err), "/tmp");
    assert.equal(result.transient, true, `${msg} → transient: true`);
    assert.equal(result.loggedIn, null, `${msg} → loggedIn: null`);
  }
});

test("getCodexAuthStatusFromClient — 일반 error → 기존 loggedIn:false 동작 보존 (회귀 보호)", async () => {
  const ordinaryErr = new Error("permission denied");
  const result = await getCodexAuthStatusFromClient(makeMockClient(ordinaryErr), "/tmp");
  assert.equal(result.loggedIn, false, "ordinary error → loggedIn: false (기존 동작)");
  assert.notEqual(result.transient, true, "ordinary error → transient: not set (or false)");
  assert.equal(result.detail, "permission denied");
});

test("getCodexAuthStatusFromClient — string error (non-Error) 도 안전 처리", async () => {
  const result = await getCodexAuthStatusFromClient(makeMockClient("raw string error"), "/tmp");
  assert.equal(result.loggedIn, false);
  assert.equal(result.detail, "raw string error");
});

test("BROKER_BUSY_RPC_CODE === -32001 (JSON-RPC error code 보존)", () => {
  assert.equal(BROKER_BUSY_RPC_CODE, -32001, "JSON-RPC error code -32001 정합");
});
