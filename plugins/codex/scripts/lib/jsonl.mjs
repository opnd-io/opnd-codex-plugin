/**
 * Helpers for reading the Codex app-server JSONL protocol.
 *
 * Manual port of upstream PR #311 (drop non-JSONL garbage on stdout)
 * fused with the more complete ANSI grammar from upstream PR #24
 * (full ECMA-48 escape repertoire). Both upstream PRs target the same
 * `JSON.parse(line)` call sites in `app-server.mjs` + `app-server-broker.mjs`
 * but neither could be cherry-picked cleanly onto the v2.1.0 base
 * because the surrounding broker / locale / TextDecoder code diverged
 * substantially. See `docs/upstream-tracking/2026-05-18-upstream-backlog-audit.md`
 * (axis R6 / Tier 1 Group A) for the audit trail.
 *
 * The codex CLI's app-server occasionally emits non-JSON bytes on stdout
 * that have nothing to do with the protocol. Two known sources:
 *
 *   1. Terminal / shell init noise — e.g. zsh writes the bracketed-paste
 *      marker `\x1b[?2004h` when a subprocess inherits the parent's TTY
 *      (issue #23).
 *
 *   2. Localized OS messages on Windows non-English locales. On zh-TW
 *      (CP-950 / Big5), when `codex.exe` runs `taskkill /T /F` to clean
 *      up a failed MCP child and inadvertently routes taskkill's stdout
 *      to its own stdout, we see the bytes `A6 A8 A5 5C 3A 20 50 49 44 ...`
 *      ("成功: PID 為 xxxx ...") which decode under UTF-8 as
 *      `���\: PID ...`.
 *
 * Both cases historically tore the broker connection down with
 * `Failed to parse codex app-server JSONL: Unexpected token …`. The
 * client never recovered because `handleExit` rejects every in-flight
 * request before any subsequent valid record arrives.
 *
 * `cleanProtocolLine` is the conservative guard:
 *
 *   - Strip ANSI escape sequences (CSI / OSC / DCS / SOS / PM / APC /
 *     simple Fp-Fe-Fs escapes / lone ESC).
 *   - Trim whitespace.
 *   - Require the first remaining character to be `{` or `[`. JSONL
 *     records cannot start with anything else, so any other prefix is
 *     definitively garbage and is dropped.
 *
 * Lines that pass these checks are still parsed with `JSON.parse`; if
 * that fails the caller surfaces a real protocol error as before.
 */

// ANSI escape grammar from upstream PR #24 (ECMA-48 complete):
//
//   CSI:    ESC [ <param bytes 0x30-0x3F>* <intermediate bytes 0x20-0x2F>* <final 0x40-0x7E>
//           param bytes include digits, ;, :, <, =, >, ? — not just [0-9;?]
//           e.g. ESC[?2004h (bracketed paste), ESC[>4;2m (modifyOtherKeys), ESC[200~ (paste wrapper)
//   OSC:    ESC ] <any> (BEL | ESC \)
//           e.g. ESC]0;title BEL (terminal title), ESC]133;A BEL (shell integration)
//   String: ESC [P|X|^|_] <any> (BEL | ESC \) — DCS / SOS / PM / APC
//   Simple: ESC <intermediate bytes 0x20-0x2F>* <final byte 0x30-0x7E>
//           Fp (0x30-0x3F): ESC 7/8 (save/restore cursor), ESC = / ESC > (keypad)
//           Fe (0x40-0x5F): ESC c (reset), ESC M (reverse index), ESC D/E
//           Fs (0x60-0x7E): standardized single functions
//   Lone:   bare ESC fallback (e.g. truncated sequences)
//
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE =
  /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b[PX^_].*?(?:\x07|\x1b\\)|\x1b\].*?(?:\x07|\x1b\\)|\x1b[\x20-\x2f]*[\x30-\x7e]|\x1b/g;

/**
 * Returns a JSON-shaped candidate string for the given raw line, or
 * `null` if the line should be skipped because it cannot be valid JSONL.
 *
 * Accepts arbitrary input — non-string values short-circuit to `null` so
 * callers don't have to type-check before invoking.
 *
 * @param {unknown} rawLine
 * @returns {string | null}
 */
export function cleanProtocolLine(rawLine) {
  if (typeof rawLine !== "string") {
    return null;
  }
  const cleaned = rawLine.replace(ANSI_ESCAPE_RE, "").trim();
  if (!cleaned) {
    return null;
  }
  const firstChar = cleaned.charCodeAt(0);
  if (firstChar !== 0x7b /* { */ && firstChar !== 0x5b /* [ */) {
    return null;
  }
  return cleaned;
}
