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

// Schema reference (실측): plugins/opnd-codex/scripts/codex-companion.mjs buildSetupReport
//   { ready, codex: {available, detail}, auth: {available, loggedIn, verified, detail, authMethod, source}, ... }
// 본 fixture 들은 실제 schema 와 정합. 21 unit test 모두 R1 review 통과 후 교정됨.

test("parseSetupJson — 모든 4 상태 true → READY", () => {
  const result = parseSetupJson({
    ready: true,
    codex: { available: true },
    auth: { available: true, loggedIn: true, verified: true },
  });
  assert.equal(result.status, HEALTH_STATUS.READY);
});

test("parseSetupJson — codex.available false → CLI_UNAVAILABLE", () => {
  // full schema 명시 (CLI_UNAVAILABLE check 가 first short-circuit 이지만,
  // 향후 check 순서 변경 회귀 보호 + R2 review LOW finding "all fixtures use auth schema" 기준 통과)
  const result = parseSetupJson({
    ready: false,
    codex: { available: false },
    auth: { available: false, loggedIn: false, verified: false },
  });
  assert.equal(result.status, HEALTH_STATUS.CLI_UNAVAILABLE);
});

test("parseSetupJson — auth.loggedIn false → NOT_LOGGED_IN + hint", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: { available: true, loggedIn: false, verified: false },
  });
  assert.equal(result.status, HEALTH_STATUS.NOT_LOGGED_IN);
  assert.match(result.details.hint, /codex logout && codex login/);
});

test("parseSetupJson — auth.loggedIn true + verified false → NOT_VERIFIED", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: { available: true, loggedIn: true, verified: false },
  });
  assert.equal(result.status, HEALTH_STATUS.NOT_VERIFIED);
});

test("parseSetupJson — issue #2: staleHomeAuth → NOT_VERIFIED with auth.json sync hint (not subscription)", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: { available: true, loggedIn: true, verified: false, staleHomeAuth: true },
  });
  assert.equal(result.status, HEALTH_STATUS.NOT_VERIFIED);
  // remedy must point at the dual-home sync, NOT "subscription/plan 확인".
  assert.match(result.details.hint, /cp ~\/\.codex\/auth\.json|CODEX_PLUGIN_USE_DEFAULT_HOME/);
  assert.doesNotMatch(result.details.hint, /subscription/i);
  assert.match(result.details.reason, /dual-home|stale/i);
});

test("parseSetupJson — auth.* 모두 true 단 ready=false → UNKNOWN (advisory)", () => {
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: { available: true, loggedIn: true, verified: true },
  });
  assert.equal(result.status, HEALTH_STATUS.UNKNOWN);
});

test("parseSetupJson — JSON string input parse", () => {
  const json = JSON.stringify({
    ready: true,
    codex: { available: true },
    auth: { available: true, loggedIn: true, verified: true },
  });
  const result = parseSetupJson(json);
  assert.equal(result.status, HEALTH_STATUS.READY);
});

test("parseSetupJson — raw 필드 제거 (PII leakage 차단)", () => {
  // R1 review HIGH #2: auth.detail 의 'ChatGPT login active for {email}' 같은 PII 가
  // ledger 의 auth_health.raw 로 영구 저장되는 것 차단. parseSetupJson 결과에 raw 없음.
  const result = parseSetupJson({
    ready: true,
    codex: { available: true, detail: "codex-cli 0.134.0" },
    auth: { available: true, loggedIn: true, verified: true, detail: "ChatGPT login active for user@example.com", authMethod: "chatgpt" },
  });
  assert.equal(result.status, HEALTH_STATUS.READY);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "raw"), false, "raw 필드는 제거되어야 함");
  // details 에도 PII 포함 안 됨 (reason / hint 만)
  const detailsSerialized = JSON.stringify(result.details);
  assert.equal(/user@example\.com/.test(detailsSerialized), false, "email 누설 안 됨");
  assert.equal(/ChatGPT login/.test(detailsSerialized), false, "auth.detail 누설 안 됨");
});

test("parseSetupJson — auth.transient true → TRANSIENT (broker busy 분기, NOT_LOGGED_IN 와 구분)", () => {
  // lib/codex.mjs 의 BROKER_BUSY_RPC_CODE 분기와 정합 — broker busy 시 actual auth state 불명
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: {
      available: true,
      loggedIn: null,
      transient: true,
      detail: "Broker busy — actual auth state unknown. Retry setup --json after broker init completes (typically 5-30s).",
      source: "app-server",
    },
  });
  assert.equal(result.status, HEALTH_STATUS.TRANSIENT);
  assert.match(result.details.hint, /wait broker init|retry/);
});

test("parseSetupJson — auth.loggedIn null (transient implicit) → TRANSIENT", () => {
  // auth.transient field 없어도 auth.loggedIn === null 만으로 TRANSIENT 인식
  const result = parseSetupJson({
    ready: false,
    codex: { available: true },
    auth: { available: true, loggedIn: null },
  });
  assert.equal(result.status, HEALTH_STATUS.TRANSIENT);
});

test("decideDegrade — TRANSIENT → PROCEED (broker init 후 재시도 가능)", () => {
  // TRANSIENT 는 일시적이라 FALLBACK_HEURISTIC 으로 degrade 하지 않고 정상 진행
  // (다음 Codex 호출에서 broker init 완료 후 actual 작동 가능)
  assert.equal(decideDegrade(HEALTH_STATUS.TRANSIENT), DEGRADE_ACTION.PROCEED);
});

test("buildFailureMessage — TRANSIENT 메시지 (broker busy + NOT_LOGGED_IN 구분 명시)", () => {
  const msg = buildFailureMessage({
    status: HEALTH_STATUS.TRANSIENT,
    details: { hint: "wait broker init (5-30s) and retry" },
  });
  assert.match(msg, /broker busy/);
  assert.match(msg, /transient/);
  assert.match(msg, /NOT_LOGGED_IN.*구분/);
});

test("computeExpiryStreak — TRANSIENT 는 streak 에 포함 안 됨 (broker busy 는 actual expired 아님)", () => {
  const runs = [
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
    { auth_health: { status: HEALTH_STATUS.TRANSIENT } }, // break — TRANSIENT 는 not expired
    { auth_health: { status: HEALTH_STATUS.NOT_LOGGED_IN } },
  ];
  assert.equal(computeExpiryStreak(runs), 1);
});

test("parseSetupJson — real-shape with extra fields → 정상 처리 (R1 LOW regression)", () => {
  // R1 review LOW: 실제 setup --json shape (node/npm/sessionRuntime/nextSteps 등 추가 필드)
  // 가 들어와도 parseSetupJson 은 codex + auth + ready 만 본다. 추가 필드 무시 robust.
  // 회귀 보호 — buildSetupReport schema 가 확장되어도 parser 가 깨지지 않음.
  const realShape = {
    ready: false,
    node: { available: true, detail: "v24.13.1" },
    npm: { available: true, detail: "9.8.1" },
    codex: { available: true, detail: "codex-cli 0.134.0; advanced runtime available" },
    auth: {
      available: true,
      loggedIn: false,
      detail: "The active provider requires OpenAI authentication",
      source: "app-server",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: true,
      provider: null,
    },
    sessionRuntime: { mode: "shared", endpoint: "pipe:..." },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: ["Run `!codex login`."],
  };
  const result = parseSetupJson(realShape);
  assert.equal(result.status, HEALTH_STATUS.NOT_LOGGED_IN);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "raw"), false, "raw 없음 — sessionRuntime/nextSteps noise 가 ledger 에 안 들어감");
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
