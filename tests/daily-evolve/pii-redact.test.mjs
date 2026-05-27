/**
 * pii-redact.test.mjs — lib/pii-redact.mjs unit test (Phase 3)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  redactEmails,
  redactTokens,
  redactAbsolutePaths,
  redactAll,
  containsPii,
  REDACT_MARKERS,
  EMAIL_PATTERN,
  TOKEN_PATTERNS,
  ABSOLUTE_PATH_PATTERNS,
} from "../../plugins/opnd-codex/scripts/daily-evolve/lib/pii-redact.mjs";

test("redactEmails — RFC 5322 simplified pattern", () => {
  assert.equal(redactEmails("contact: foo@example.com"), `contact: ${REDACT_MARKERS.EMAIL}`);
  assert.equal(redactEmails("a.b+c@sub.co.kr"), REDACT_MARKERS.EMAIL);
  // 다중 매칭
  assert.equal(
    redactEmails("alice@a.com and bob@b.com"),
    `${REDACT_MARKERS.EMAIL} and ${REDACT_MARKERS.EMAIL}`,
  );
  // 비 string 안전
  assert.equal(redactEmails(null), null);
  assert.equal(redactEmails(123), 123);
});

test("redactTokens — GitHub PAT / OpenAI / Slack / 40-hex", () => {
  // GitHub PAT classic (ghp_*)
  assert.equal(
    redactTokens("token: ghp_" + "A".repeat(36)),
    `token: ${REDACT_MARKERS.TOKEN}`,
  );
  // OpenAI sk-*
  assert.equal(
    redactTokens("OPENAI_API_KEY=sk-abc123def456ghi789jkl"),
    `OPENAI_API_KEY=${REDACT_MARKERS.TOKEN}`,
  );
  // Slack
  assert.equal(
    redactTokens("xoxb-12345-67890-abcde"),
    REDACT_MARKERS.TOKEN,
  );
  // 40-hex (git SHA + token 도 매칭 — 보수적)
  assert.equal(
    redactTokens("abcdef0123456789abcdef0123456789abcdef01"),
    REDACT_MARKERS.TOKEN,
  );
});

test("redactAbsolutePaths — Windows / POSIX home / Users / tmp", () => {
  // Windows
  assert.equal(
    redactAbsolutePaths("path: C:\\Users\\alice\\project"),
    `path: ${REDACT_MARKERS.ABSOLUTE_PATH}`,
  );
  // POSIX home
  assert.equal(
    redactAbsolutePaths("/home/bob/foo"),
    REDACT_MARKERS.ABSOLUTE_PATH,
  );
  assert.equal(
    redactAbsolutePaths("/Users/charlie/Documents/x"),
    REDACT_MARKERS.ABSOLUTE_PATH,
  );
  // tmp
  assert.equal(
    redactAbsolutePaths("output: /tmp/alice/").startsWith("output: <path>"),
    true,
  );
  // 상대 경로 보존
  const rel = "src/foo.mjs";
  assert.equal(redactAbsolutePaths(rel), rel);
});

test("redactAll — 모든 PII 동시 mask + hits 카운트", () => {
  const input = "User foo@example.com saved ghp_" + "B".repeat(36) + " at /home/foo/data";
  const { redacted, hits } = redactAll(input);
  assert.equal(hits.email, 1);
  assert.equal(hits.token, 1);
  assert.equal(hits.path, 1);
  assert.ok(redacted.includes("<email>"));
  assert.ok(redacted.includes("<token>"));
  assert.ok(redacted.includes("<path>"));
});

test("redactAll — PII 없는 input 그대로", () => {
  const safe = "just some normal text without secrets";
  const { redacted, hits } = redactAll(safe);
  assert.equal(redacted, safe);
  assert.deepEqual(hits, { email: 0, token: 0, path: 0 });
});

test("redactAll — non-string input 안전", () => {
  const { redacted, hits } = redactAll(null);
  assert.equal(redacted, null);
  assert.deepEqual(hits, { email: 0, token: 0, path: 0 });
});

test("containsPii — email/token/path 1+ 시 true", () => {
  assert.equal(containsPii("hello world"), false);
  assert.equal(containsPii("contact me at foo@bar.com"), true);
  assert.equal(containsPii("ghp_" + "C".repeat(36)), true);
  assert.equal(containsPii("path /home/alice/x"), true);
  // multi-call reset lastIndex (regex global flag 함정)
  assert.equal(containsPii("a@b.com"), true);
  assert.equal(containsPii("a@b.com"), true);
  // null 안전
  assert.equal(containsPii(null), false);
  assert.equal(containsPii(undefined), false);
});

test("REDACT_MARKERS — grep 친화적 고정 토큰", () => {
  assert.equal(REDACT_MARKERS.EMAIL, "<email>");
  assert.equal(REDACT_MARKERS.TOKEN, "<token>");
  assert.equal(REDACT_MARKERS.ABSOLUTE_PATH, "<path>");
});
