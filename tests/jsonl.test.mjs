import test from "node:test";
import assert from "node:assert/strict";

import { cleanProtocolLine } from "../plugins/codex/scripts/lib/jsonl.mjs";

// Manual port of upstream PR #24 + PR #311 tests, merged onto the v2.1.0
// base. The fork could not cherry-pick either PR cleanly (broker / locale
// hardening diverged), so the helper lives in `lib/jsonl.mjs` and the test
// suite covers both ANSI-strip (PR #24) and JSONL-prefix guard (PR #311).
// Audit trail: docs/upstream-tracking/2026-05-18-upstream-backlog-audit.md
// (axis R6 / Tier 1 Group A).

test("cleanProtocolLine returns null for empty / whitespace lines", () => {
  assert.equal(cleanProtocolLine(""), null);
  assert.equal(cleanProtocolLine("   "), null);
  assert.equal(cleanProtocolLine("\t\r\n"), null);
});

test("cleanProtocolLine returns null for non-string input", () => {
  assert.equal(cleanProtocolLine(undefined), null);
  assert.equal(cleanProtocolLine(null), null);
  assert.equal(cleanProtocolLine(42), null);
});

test("cleanProtocolLine passes through plain JSON object lines unchanged", () => {
  assert.equal(cleanProtocolLine('{"id":1,"result":{}}'), '{"id":1,"result":{}}');
  assert.equal(cleanProtocolLine('  {"a":1}  '), '{"a":1}');
});

test("cleanProtocolLine passes through plain JSON array lines unchanged", () => {
  assert.equal(cleanProtocolLine("[1,2,3]"), "[1,2,3]");
});

test("cleanProtocolLine strips bracketed-paste-mode ANSI prefix (issue #23)", () => {
  assert.equal(cleanProtocolLine('\x1b[?2004h{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('{"id":1}\x1b[?2004l'), '{"id":1}');
});

test("cleanProtocolLine strips CSI sequences whose final byte is not a letter", () => {
  // Bracketed-paste content markers use `~` (0x7E) as the final byte.
  // ECMA-48 CSI allows any final byte in 0x40..0x7E.
  assert.equal(cleanProtocolLine('\x1b[200~{"id":1}\x1b[201~'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b[@{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b[`{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips modifyOtherKeys (`>` parameter byte)", () => {
  assert.equal(cleanProtocolLine('\x1b[>4;2m{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b[>4;0m{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips OSC window-title sequences (BEL + ST terminator)", () => {
  assert.equal(cleanProtocolLine('\x1b]0;My Terminal\x07{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b]0;My Terminal\x1b\\{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips iTerm2/kitty shell-integration sequences", () => {
  assert.equal(cleanProtocolLine('\x1b]133;A\x07{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b]133;D;0\x07{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips OSC hyperlink sequences", () => {
  assert.equal(cleanProtocolLine('\x1b]8;params;uri\x07{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips DCS / SOS / PM / APC string sequences", () => {
  assert.equal(cleanProtocolLine('\x1bPfoo=bar\x1b\\{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b_Gfoo\x1b\\{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b^hello\x1b\\{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1bXdata\x1b\\{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine strips simple Fp / Fe / Fs escapes", () => {
  // Fp finals 0x30-0x3F (e.g. ESC 7 save cursor, ESC = keypad mode)
  assert.equal(cleanProtocolLine('\x1b7{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1b={"id":1}'), '{"id":1}');
  // Fe finals 0x40-0x5F (e.g. ESC M reverse index, ESC E next line)
  assert.equal(cleanProtocolLine('\x1bM{"id":1}'), '{"id":1}');
  assert.equal(cleanProtocolLine('\x1bE{"id":1}'), '{"id":1}');
  // Fs finals 0x60-0x7E (e.g. ESC c RIS full reset)
  assert.equal(cleanProtocolLine('\x1bc{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine handles mixed ANSI noise around a JSON record", () => {
  const line = '\x1b]0;zsh\x07\x1b[1;34m{"jsonrpc":"2.0","id":1}\x1b[0m';
  assert.equal(cleanProtocolLine(line), '{"jsonrpc":"2.0","id":1}');
});

test("cleanProtocolLine drops localized Windows taskkill prefix (issue #23 sibling)", () => {
  // CP-950 / Big5 mojibake of `taskkill /T /F` success message on zh-TW.
  // Not a valid JSON record — should be dropped silently rather than
  // tearing the broker connection down.
  assert.equal(cleanProtocolLine("���\\: PID 1234"), null);
});

test("cleanProtocolLine drops non-JSON prefix even when ANSI stripped to plain text", () => {
  // After ANSI strip the line still does not start with `{` or `[`.
  assert.equal(cleanProtocolLine("\x1b[1;34mhello world"), null);
  assert.equal(cleanProtocolLine("trailing log line without JSON"), null);
});

// NOTE: `\x1b{...}` (bare ESC immediately followed by JSON start `{`) is a
// theoretical corner case — in practice no terminal emitter produces ESC
// directly before `{`. The simple-escape branch of the regex
// (`\x1b[\x20-\x2f]*[\x30-\x7e]`) matches ECMA-48 escapes whose final byte
// is in 0x30-0x7E, which includes `{` (0x7B), so this input would lose the
// opening brace. JSON prefix guard then drops the line as garbage rather
// than producing a malformed JSON. Acceptable trade-off vs the cost of
// rewriting the regex to carve out `{` / `[` from the final byte class.

test("cleanProtocolLine: nF escape with intermediate byte stripped", () => {
  // ESC space F: intermediate 0x20, final 0x46.
  assert.equal(cleanProtocolLine('\x1b F{"id":1}'), '{"id":1}');
});

test("cleanProtocolLine: empty payload after strip returns null", () => {
  assert.equal(cleanProtocolLine("\x1b[0m"), null);
  assert.equal(cleanProtocolLine("\x1b[?2004h\x1b[?2004l"), null);
});
