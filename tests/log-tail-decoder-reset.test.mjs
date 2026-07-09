import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  readLogTailFromOffset,
  READ_LOG_TAIL_FULL_READ_CAP_BYTES
} from "../plugins/opnd-codex/scripts/lib/log-tail.mjs";
// 종료 시 스윕(O3)이 회수하도록 helper 를 통해 등록한다.
import { makeTempDir } from "./helpers.mjs";

// O10 — tail reader 는 byte stream 불연속에서 watermark 를 리셋하고 `pendingPartial`
// 을 버리지만, 호출자의 streaming TextDecoder 가 절반만 디코딩된 multi-byte 시퀀스를
// 붙들고 있게 두었다. 그 남은 lead byte 가 다음 read 의 첫 글자에 달라붙었다.
//
// 이 버그는 telemetry 회전(O7)이 append 대상 파일을 잘라내면서 프로덕션에서 도달
// 가능해졌다.

function freshLog() {
  return path.join(makeTempDir("codex-plugin-test-tail-"), "job.log");
}

test("Node's TextDecoder really does carry state across stream decodes", () => {
  // 이 수정이 존재하는 이유인 플랫폼 동작을 고정한다. 언젠가 이것이 사실이 아니게
  // 되면 아래 reset 은 dead code 가 되므로 재검토해야 한다.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  assert.equal(decoder.decode(Buffer.from([0xe2]), { stream: true }), "");
  assert.equal(decoder.decode(Buffer.from("A\n"), { stream: true }), "�A\n");
});

test("truncation resets the decoder so the next line is not corrupted", () => {
  const logFile = freshLog();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // 첫 tick 이 3바이트 문자(U+2713 = E2 9C 93) 중간에서 끝난다.
  fs.writeFileSync(logFile, Buffer.from([0x61, 0x62, 0x63, 0x0a, 0xe2]));
  const first = readLogTailFromOffset(logFile, 0, "", { decoder });
  assert.deepEqual(first.lines, ["abc"]);
  assert.equal(first.decoderReset, false);

  // 파일이 회전되어 더 짧은 파일로 교체된다: decoder 가 기다리던 두 continuation
  // byte 는 영영 오지 않는다.
  // (같은 크기로 교체하면 크기 기반 watermark 로는 보이지 않는다 — 이 reader 의 알려진
  // 한계이며, 이 수정이 바꾸는 것이 아니다.)
  fs.writeFileSync(logFile, "OK\n");
  const second = readLogTailFromOffset(logFile, first.nextOffset, first.pendingPartial, { decoder });

  assert.equal(second.decoderReset, true, "discontinuity is reported");
  assert.deepEqual(second.lines, ["OK"], "no U+FFFD glued onto the new line");
  assert.equal(second.nextOffset, fs.statSync(logFile).size);
});

test("a burst past the read cap also resets the decoder", () => {
  const logFile = freshLog();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  // 정상 read 로 대기 중인 continuation byte 를 심는다.
  fs.writeFileSync(logFile, Buffer.from([0x78, 0x0a, 0xe2]));
  const first = readLogTailFromOffset(logFile, 0, "", { decoder });
  assert.equal(first.decoderReset, false);

  // 이제 tick 당 상한보다 많이 append 해 reader 가 건너뛰게 한다. 실제 8 MB 를 쓰는
  // 비용은 충분히 싸고, mock 이 아니라 진짜 분기를 실행한다.
  // reader 는 상한 슬라이스의 첫(잘린) 라인을 의도적으로 버리므로, 살아남을 것이
  // 있으려면 burst 가 그 뒤에 완전한 라인을 포함해야 한다.
  const burst = Buffer.concat([
    Buffer.alloc(READ_LOG_TAIL_FULL_READ_CAP_BYTES, 0x62),
    Buffer.from("\nTAIL\n", "utf8")
  ]);
  fs.appendFileSync(logFile, burst);

  const second = readLogTailFromOffset(logFile, first.nextOffset, first.pendingPartial, { decoder });
  assert.equal(second.decoderReset, true, "cap overrun is a discontinuity too");
  assert.deepEqual(second.lines, ["TAIL"], "torn leading line dropped, complete line kept");
  assert.ok(
    second.lines.every((line) => !line.includes("�")),
    "no replacement character leaked into the surviving lines"
  );
});

test("a contiguous multi-byte character split across ticks is still stitched together", () => {
  // 수정 자체에 대한 회귀 가드: *매* tick 마다 리셋하면 decoder 옵션이 존재하는 이유인
  // CDX-002 동작이 깨진다.
  const logFile = freshLog();
  const decoder = new TextDecoder("utf-8", { fatal: false });

  fs.writeFileSync(logFile, Buffer.from([0xe2, 0x9c])); // ✓ 의 앞 2바이트
  const first = readLogTailFromOffset(logFile, 0, "", { decoder });
  assert.deepEqual(first.lines, []);
  assert.equal(first.decoderReset, false);

  fs.appendFileSync(logFile, Buffer.from([0x93, 0x0a])); // 마지막 바이트 + newline
  const second = readLogTailFromOffset(logFile, first.nextOffset, first.pendingPartial, { decoder });
  assert.equal(second.decoderReset, false, "growth is not a discontinuity");
  assert.deepEqual(second.lines, ["✓"], "character survives the tick boundary");
});

test("readLogTailFromOffset reports decoderReset even without a decoder", () => {
  const logFile = freshLog();
  fs.writeFileSync(logFile, "one\ntwo\n");
  const first = readLogTailFromOffset(logFile, 0, "");
  assert.equal(first.decoderReset, false);

  fs.writeFileSync(logFile, "x\n");
  const second = readLogTailFromOffset(logFile, first.nextOffset, first.pendingPartial);
  assert.equal(second.decoderReset, true);
  assert.deepEqual(second.lines, ["x"]);
});

test("missing file and unchanged file report no discontinuity", () => {
  assert.deepEqual(readLogTailFromOffset(null, 0, ""), {
    lines: [],
    nextOffset: 0,
    pendingPartial: "",
    decoderReset: false
  });

  const logFile = freshLog();
  fs.writeFileSync(logFile, "a\n");
  const first = readLogTailFromOffset(logFile, 0, "");
  const second = readLogTailFromOffset(logFile, first.nextOffset, first.pendingPartial);
  assert.equal(second.decoderReset, false);
  assert.deepEqual(second.lines, []);
});
