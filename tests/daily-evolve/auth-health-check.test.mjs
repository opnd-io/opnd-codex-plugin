/**
 * auth-health-check.test.mjs — lib/auth-health-check.mjs unit test (Phase 1.5a)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSetupJson,
  decideDegrade,
  buildFailureMessage,
  computeExpiryStreak,
  shouldEscalate,
  HEALTH_STATUS,
  DEGRADE_ACTION,
  EXPIRY_STREAK_ALERT_DAYS,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/auth-health-check.mjs";

test("parseSetupJson — 모든 4 상태 true → READY", () => {
  const result = parseSetupJson({
    ready: true,
    codex: { available: true, loggedIn: true, verified: true },
  });
  assert.equal(result.status, HEALTH_STATUS.READY);
});

test("parseSetupJson — codex.available false → CLI_UNAVAILABLE", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: false },
  });
  assert.equal(result.status, HEALTH_STATUS.CLI_UNAVAILABLE);
});

test("parseSetupJson — loggedIn false → NOT_LOGGED_IN + hint", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true, loggedIn: false },
  });
  assert.equal(result.status, HEALTH_STATUS.NOT_LOGGED_IN);
  assert.match(result.details.hint, /codex logout && codex login/);
});

test("parseSetupJson — loggedIn true + verified false → NOT_VERIFIED", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true, loggedIn: true, verified: false },
  });
  assert.equal(result.status, HEALTH_STATUS.NOT_VERIFIED);
});

test("parseSetupJson — codex.* 모두 true 단 ready=false → UNKNOWN (advisory)", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true, loggedIn: true, verified: true },
  });
  assert.equal(result.status, HEALTH_STATUS.UNKNOWN);
});

test("parseSetupJson — JSON string input parse", () => {
  const json = JSON.stringify({ ready: true, codex: { available: true, loggedIn: true, verified: true } });
  const result = parseSetupJson(json);
  assert.equal(result.status, HEALTH_STATUS.READY);
});

test("parseSetupJson — invalid JSON / null → UNKNOWN", () => {
  assert.equal(parseSetupJson("{ broken json").status, HEALTH_STATUS.UNKNOWN);
  assert.equal(parseSetupJson(null).status, HEALTH_STATUS.UNKNOWN);
  assert.equal(parseSetupJson(undefined).status, HEALTH_STATUS.UNKNOWN);
  assert.equal(parseSetupJson(123).status, HEALTH_STATUS.UNKNOWN);
});

test("decideDegrade — READY → PROCEED", () => {
  assert.equal(decideDegrade(HEALTH_STATUS.READY), DEGRADE_ACTION.PROCEED);
});

test("decideDegrade — NOT_LOGGED_IN / NOT_VERIFIED / UNKNOWN / CLI_UNAVAILABLE → FALLBACK_HEURISTIC", () => {
  assert.equal(decideDegrade(HEALTH_STATUS.NOT_LOGGED_IN), DEGRADE_ACTION.FALLBACK_HEURISTIC);
  assert.equal(decideDegrade(HEALTH_STATUS.NOT_VERIFIED), DEGRADE_ACTION.FALLBACK_HEURISTIC);
  assert.equal(decideDegrade(HEALTH_STATUS.UNKNOWN), DEGRADE_ACTION.FALLBACK_HEURISTIC);
  assert.equal(decideDegrade(HEALTH_STATUS.CLI_UNAVAILABLE), DEGRADE_ACTION.FALLBACK_HEURISTIC);
});

test("buildFailureMessage — READY → null", () => {
  assert.equal(buildFailureMessage({ status: HEALTH_STATUS.READY }), null);
  assert.equal(buildFailureMessage(null), null);
});

test("buildFailureMessage — NOT_LOGGED_IN 메시지 + hint", () => {
  const msg = buildFailureMessage({
    status: HEALTH_STATUS.NOT_LOGGED_IN,
    details: { hint: "codex logout && codex login" },
  });
  assert.match(msg, /인증 만료/);
  assert.match(msg, /codex logout && codex login/);
});

test("buildFailureMessage — CLI_UNAVAILABLE 메시지", () => {
  const msg = buildFailureMessage({ status: HEALTH_STATUS.CLI_UNAVAILABLE });
  assert.match(msg, /CLI 미설치/);
  assert.match(msg, /npm install -g @openai\/codex/);
});

test("buildFailureMessage — NOT_VERIFIED / UNKNOWN", () => {
  assert.match(buildFailureMessage({ status: HEALTH_STATUS.NOT_VERIFIED }), /verified=false/);
  assert.match(buildFailureMessage({ status: HEALTH_STATUS.UNKNOWN }), /parse 실패/);
});

test("computeExpiryStreak — 연속 expired 카운트 (newest first)", () => {
  const runs = [
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
    { auth_health: { status: HEALTH_STATUS.NOT_VERIFIED } },
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
    { auth_health: { status: HEALTH_STATUS.READY } },
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
  ];
  // newest 3개가 expired (NOT_LOGGED_IN/NOT_VERIFIED/NOT_LOGGED_IN), 4번째에서 READY 라 break
  assert.equal(computeExpiryStreak(runs), 3);
});

test("computeExpiryStreak — 첫 entry READY → 0", () => {
  const runs = [{ auth_health: { status: HEALTH_STATUS.READY } }];
  assert.equal(computeExpiryStreak(runs), 0);
});

test("computeExpiryStreak — auth_health 부재 entry → break", () => {
  const runs = [
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
    {}, // auth_health 부재 — break
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
  ];
  assert.equal(computeExpiryStreak(runs), 1);
});

test("computeExpiryStreak — 빈/null 안전", () => {
  assert.equal(computeExpiryStreak([]), 0);
  assert.equal(computeExpiryStreak(null), 0);
});

test("shouldEscalate — streak < ALERT_DAYS → false", () => {
  const r = shouldEscalate(EXPIRY_STREAK_ALERT_DAYS - 1);
  assert.equal(r.shouldEscalate, false);
});

test("shouldEscalate — streak ≥ ALERT_DAYS → true", () => {
  const r = shouldEscalate(EXPIRY_STREAK_ALERT_DAYS);
  assert.equal(r.shouldEscalate, true);
  assert.match(r.reason, /streak/);
  assert.match(r.reason, /재인증 ping/);
});

test("shouldEscalate — invalid input safe", () => {
  assert.equal(shouldEscalate(NaN).shouldEscalate, false);
  assert.equal(shouldEscalate(undefined).shouldEscalate, false);
});

test("EXPIRY_STREAK_ALERT_DAYS === 3", () => {
  assert.equal(EXPIRY_STREAK_ALERT_DAYS, 3);
});
