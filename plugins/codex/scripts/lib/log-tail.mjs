// PR-3.5 follow-up — incremental tail reader for `status --watch`.
//
// Extracted from codex-companion.mjs so the helper can be exercised
// directly by tests (the companion entrypoint runs `main()` at import
// time and cannot be imported as a library). The watch loop in
// codex-companion.mjs threads the same shared state into this helper
// every tick.
//
// The earlier dedup approach (`lastPrinted = new Set()` of printed line
// content) silently dropped legitimately-repeated lines: e.g. a heartbeat
// that emits `tick` every second, or two structurally identical progress
// lines. By switching to a byte-offset watermark we stream every newly
// appended line once and only once, regardless of content.
//
// Contract:
//   - First tick: caller invokes `readLogTailFromOffset(logFile, 0, "")`
//     once. The helper does a single stat + bounded read + LF split,
//     returning *all* complete lines plus the next watermark. Caller
//     slices `lines` to the visible window (e.g. last N) for display.
//     Subsequent ticks reuse the returned `nextOffset` and `pendingPartial`.
//   - Subsequent ticks: read bytes in `[lastOffset, fs.statSync().size)`,
//     concatenate with `pendingPartial`, split by LF, hold back the
//     trailing fragment (if no terminating newline) as the next-tick
//     `pendingPartial` so half-written lines do not surface as two
//     separate emissions.
//   - Truncate / external rotation (`stat.size < lastOffset`): reset to
//     0 + clear `pendingPartial`. Per-job logs are append-only so this
//     is theoretical, but cheap to support.
//   - Burst guard: a single tick is capped at the 8 MB ceiling so a
//     sudden flood does not block the event loop on a sync read. On
//     burst, we drop the leading partial line of the capped slice (same
//     torn-fragment guard `readLogTail` uses) and clear `pendingPartial`
//     since the buffered fragment is no longer contiguous with the new
//     read.
//   - Multi-byte UTF-8 safety (audit CDX-002): the caller can thread a
//     stateful `TextDecoder({ fatal: false })` via the `decoder`
//     option. When provided, the helper decodes with `{ stream: true }`
//     so a multi-byte char split across two ticks is buffered inside
//     the decoder and finalized on the next tick. When the decoder is
//     not provided, the helper falls back to `Buffer#toString("utf8")`
//     which finalizes immediately — fine for ASCII-only logs but
//     produces U+FFFD on multi-byte boundaries.

import fs from "node:fs";

export const READ_LOG_TAIL_FULL_READ_CAP_BYTES = 8 * 1024 * 1024;
export const READ_LOG_TAIL_PARTIAL_READ_BYTES = 256 * 1024;

/**
 * @param {string | null | undefined} logFile
 * @param {number} lastOffset
 * @param {string} pendingPartial
 * @param {{ decoder?: TextDecoder }} [options]
 * @returns {{ lines: string[], nextOffset: number, pendingPartial: string }}
 */
export function readLogTailFromOffset(logFile, lastOffset, pendingPartial, options = {}) {
  if (!logFile) {
    return { lines: [], nextOffset: lastOffset, pendingPartial };
  }
  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch {
    return { lines: [], nextOffset: lastOffset, pendingPartial };
  }
  if (stat.size < lastOffset) {
    // Truncate / rotation — reset watermark and drop the stale fragment.
    lastOffset = 0;
    pendingPartial = "";
  }
  if (stat.size === lastOffset) {
    return { lines: [], nextOffset: lastOffset, pendingPartial };
  }
  const readLen = stat.size - lastOffset;
  const cappedLen = Math.min(readLen, READ_LOG_TAIL_FULL_READ_CAP_BYTES);
  const start = stat.size - cappedLen;
  let buf;
  try {
    const fd = fs.openSync(logFile, "r");
    try {
      buf = Buffer.alloc(cappedLen);
      fs.readSync(fd, buf, 0, cappedLen, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], nextOffset: lastOffset, pendingPartial };
  }
  const decoded = options.decoder
    ? options.decoder.decode(buf, { stream: true })
    : buf.toString("utf8");
  let raw;
  if (cappedLen < readLen) {
    // Burst exceeded the per-tick cap: drop the leading partial line in
    // the decoded slice (same torn-line guard as readLogTail's
    // partial-read branch) and clear any stashed partial — those bytes
    // are gone.
    pendingPartial = "";
    raw = decoded;
    const firstNewline = raw.indexOf("\n");
    if (firstNewline >= 0) raw = raw.slice(firstNewline + 1);
  } else {
    raw = pendingPartial + decoded;
  }
  raw = raw.replace(/\r\n/g, "\n");
  const segments = raw.split("\n");
  // If the read ended on `\n`, the final segment is "" and pop() yields "".
  // If it ended mid-line, the final segment is the unfinished fragment and
  // becomes the next-tick partial buffer.
  const newPending = segments.pop() ?? "";
  return { lines: segments, nextOffset: stat.size, pendingPartial: newPending };
}
