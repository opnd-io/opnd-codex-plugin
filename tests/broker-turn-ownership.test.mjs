import { test } from "node:test";
import assert from "node:assert/strict";

import { createTurnOwnership } from "../plugins/opnd-codex/scripts/lib/broker-turn-ownership.mjs";

// B2 — `turn/completed` 는 자신이 속한 `turn/start` 응답보다 먼저 도착할 수 있다. 예전
// broker 는 그 응답을 await 한 뒤에야 `activeStreamSocket` 을 대입했으므로, 이른 완료는
// 아무것도 해제하지 못했고 await 다음의 대입이 어떤 완료도 해제하지 않을 소유자를 세웠다.
// 그 뒤 소유자의 socket 이 우연히 닫힐 때까지 다른 모든 client 가 BROKER_BUSY 를 받았다.

const A = Symbol("socket-A");
const B = Symbol("socket-B");
const STREAMING = true;
const PLAIN = false;

test("an idle broker is busy for nobody", () => {
  const own = createTurnOwnership();
  assert.equal(own.isBusyFor(A), false);
  assert.equal(own.isBusyFor(B), false);
  assert.equal(own.notificationTarget(), null);
});

test("a plain request blocks other sockets only while it is in flight", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, PLAIN);
  assert.equal(own.isBusyFor(B), true);
  assert.equal(own.isBusyFor(A), false, "the owner is never busy for itself");

  own.settleRequest(A, PLAIN, null);
  assert.equal(own.isBusyFor(B), false, "released as soon as the response is sent");
});

test("a streaming turn keeps ownership until turn/completed arrives", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["thread-1"]));

  assert.equal(own.isBusyFor(B), true, "the stream owns the app-server");
  assert.equal(own.handleTurnCompleted(A, "thread-1"), true);
  assert.equal(own.isBusyFor(B), false, "released by the completion");
});

// ------------------------------------------------------- race

test("turn/completed arriving BEFORE the response does not wedge the broker", () => {
  const own = createTurnOwnership();

  own.beginRequest(A, STREAMING); //  → claims the stream up front
  // app-server 가 turn 전체를 stream 하고, `turn/start` 의 JSON-RPC 응답이 우리에게
  // 돌아오기 전에 끝난다.
  assert.equal(own.handleTurnCompleted(A, null), true, "the completion is recorded");
  assert.equal(
    own.snapshot().activeRequestSocket,
    A,
    "the in-flight request keeps the app-server to itself while awaiting"
  );
  assert.equal(own.isBusyFor(B), true, "B still cannot start a concurrent turn mid-flight");

  // 이제 응답이 도착한다.
  own.settleRequest(A, STREAMING, new Set(["thread-1"]));

  assert.equal(own.isBusyFor(B), false, "ownership is NOT resurrected — this is the bug");
  assert.deepEqual(own.snapshot(), {
    activeRequestSocket: null,
    activeStreamSocket: null,
    activeStreamThreadIds: null,
    pendingStreamClaim: null
  });
});

test("the normal ordering (response, then completion) still parks ownership on the stream", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["thread-1"]));
  assert.equal(own.isBusyFor(B), true);
  own.handleTurnCompleted(A, "thread-1");
  assert.equal(own.isBusyFor(B), false);
});

test("a completion for a different thread does not release the stream", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["thread-1"]));

  assert.equal(own.handleTurnCompleted(A, "thread-99"), false, "not ours");
  assert.equal(own.isBusyFor(B), true, "still owned");

  assert.equal(own.handleTurnCompleted(A, "thread-1"), true);
  assert.equal(own.isBusyFor(B), false);
});

test("during the provisional window any completion counts (only one turn can be in flight)", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  // review/start 는 응답에서야 reviewThreadId 를 알게 되므로, 여기서 id 는 정말로 모른다.
  // 완료를 받아들이는 것만이 타당한 선택이다.
  assert.equal(own.handleTurnCompleted(A, "some-thread-we-have-not-seen"), true);
  own.settleRequest(A, STREAMING, new Set(["some-thread-we-have-not-seen"]));
  assert.equal(own.isBusyFor(B), false);
});

// ------------------------------------------------------- 밀려난 stream
//
// 이미 세워둔 stream 을 소유한 socket 은 자기 자신에 대해 busy 가 아니므로, 첫 turn 의
// `turn/completed` 가 전달되기 전에 두 번째 streaming turn 을 시작할 수 있다. 잠정 claim
// 이 그 늦은 완료를 자기 것인 양 삼켜서는 안 된다 — 그러면 turn 이 실제로 streaming 중인데
// broker 가 자신을 idle 로 보고하고, 두 번째 client 가 같은 app-server 에서 동시 turn 을
// 시작할 수 있다.

test("a late completion for the superseded stream is not credited to the new claim", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["old"]));
  own.settleRequest(A, STREAMING, new Set(["old"]));

  // `old` 의 완료가 아직 전달 중인데 A 가 새 turn 을 시작한다.
  own.beginRequest(A, STREAMING, new Set(["new"]));
  assert.equal(own.handleTurnCompleted(A, "old"), true, "routed to A, and retires the old stream");
  assert.equal(
    own.snapshot().pendingStreamClaim.completed,
    false,
    "the in-flight claim is NOT marked complete by someone else's completion"
  );

  own.settleRequest(A, STREAMING, new Set(["new"]));
  assert.equal(own.isBusyFor(B), true, "A still owns its live stream");
  assert.deepEqual(own.snapshot().activeStreamThreadIds, ["new"]);

  own.handleTurnCompleted(A, "new");
  assert.equal(own.isBusyFor(B), false, "released by its own completion");
});

test("an early completion of the NEW turn is still credited to the claim", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["old"]));
  own.settleRequest(A, STREAMING, new Set(["old"]));

  own.beginRequest(A, STREAMING, new Set(["new"]));
  assert.equal(own.handleTurnCompleted(A, "new"), true);
  assert.equal(own.snapshot().pendingStreamClaim.completed, true);

  own.settleRequest(A, STREAMING, new Set(["new"]));
  assert.equal(own.isBusyFor(B), false, "no ownership resurrected");
});

test("a completion whose thread is in BOTH the claim and the superseded set is credited to the claim", () => {
  // 같은 thread 위의 연속 turn 은 이 레이어에서 구분할 수 없다. client 는 thread 위의
  // turn 을 직렬화하므로 그 순서는 발생하지 않는다. 아닌 척하지 말고 문서화된 동작을
  // 고정한다.
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["t"]));
  own.settleRequest(A, STREAMING, new Set(["t"]));
  own.beginRequest(A, STREAMING, new Set(["t"]));
  assert.equal(own.handleTurnCompleted(A, "t"), true);
  assert.equal(own.snapshot().pendingStreamClaim.completed, true);
});

test("with no expected ids, an unknown completion still counts (review/start learns its thread late)", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["old"]));
  own.settleRequest(A, STREAMING, new Set(["old"]));

  own.beginRequest(A, STREAMING, null);
  // review thread id 는 응답에서만 알 수 있으므로 그 완료를 `expected` 와 대조할 수 없다.
  // 밀려난 thread 도 아니므로, 버리지 말고 claim 에 귀속시켜야 한다 (버리면 교착된다).
  assert.equal(own.handleTurnCompleted(A, "review-thread"), true);
  assert.equal(own.snapshot().pendingStreamClaim.completed, true);
});

// ------------------------------------------------------- 실패 경로

test("a failed streaming request releases the provisional claim", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.failRequest(A);
  assert.equal(own.isBusyFor(B), false, "a turn that never started must not own the broker");
  assert.equal(own.snapshot().pendingStreamClaim, null);
});

test("a failed streaming request restores the stream it superseded", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["old"]));
  own.settleRequest(A, STREAMING, new Set(["old"]));

  own.beginRequest(A, STREAMING, new Set(["new"]));
  own.failRequest(A); // app-server 가 turn/start 를 거부했다

  assert.equal(own.snapshot().activeStreamSocket, A, "the still-running old stream keeps its owner");
  assert.deepEqual(own.snapshot().activeStreamThreadIds, ["old"]);
  assert.equal(own.isBusyFor(B), true);

  own.handleTurnCompleted(A, "old");
  assert.equal(own.isBusyFor(B), false, "and it can still be released normally");
});

test("a failed plain request releases the request slot", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, PLAIN);
  own.failRequest(A);
  assert.equal(own.isBusyFor(B), false);
});

test("a failed request does not disturb another socket's live stream", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["t1"]));
  // B 는 여기까지 오지도 못한다 (isBusyFor(B) 가 true). 그래도 failRequest 는 방어적이어야
  // 한다: socket 교체 이후의 에러 경로에서도 이 함수에 도달한다.
  own.failRequest(B);
  assert.equal(own.snapshot().activeStreamSocket, A, "A still owns its stream");
});

test("closing the owning socket releases everything", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.releaseSocket(A);
  assert.equal(own.isBusyFor(B), false);
  assert.deepEqual(own.snapshot().pendingStreamClaim, null);
});

test("closing an unrelated socket changes nothing", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["t1"]));
  own.releaseSocket(B);
  assert.equal(own.snapshot().activeStreamSocket, A);
});

// ------------------------------------------------------- turn control + 라우팅

test("turn control from another socket is allowed against a parked stream", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["t1"]));

  assert.equal(own.canRunTurnControl(B), true, "B may interrupt A's parked stream");
  assert.equal(own.canRunTurnControl(A), false, "A is the owner, not a controller");
});

test("turn control is refused while a request is still in flight", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  // 잠정 claim 은 세워졌지만 응답은 아직 도착하지 않았다: 같은 app-server 에 대한 두 번째
  // 요청은 경합한다.
  assert.equal(own.canRunTurnControl(B), false);
});

// ------------------------------------------------------- 단일 claim 불변식
//
// `pendingStreamClaim` 과 `supersededStream` 은 슬롯이 하나씩이다. 첫 요청이 아직 잠정인
// 동안 같은 socket 에서 두 번째 `beginRequest` 가 오면 둘 다 덮어써, 아직 streaming 중인
// turn 의 소유권을 해제할 수 있다. broker 는 그 상태에 도달할 수 없지만 (socket 별 chunk
// 가 체인으로 묶이고, 메시지 루프는 다음 메시지를 읽기 전에 각 응답을 await 한다),
// 모듈이 정확성 속성을 호출자의 규율에 의존해서는 안 된다.

test("a socket is busy for ITSELF while its own streaming claim is provisional", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["t1"]));
  assert.equal(own.isBusyFor(A), true, "the busy gate blocks a second overlapping request");
  assert.equal(own.isBusyFor(B), true);
});

test("a socket is NOT busy for its own parked stream — that is how it starts the next turn", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["t1"]));
  own.settleRequest(A, STREAMING, new Set(["t1"]));
  assert.equal(own.isBusyFor(A), false, "the claim is settled; A may supersede its own stream");
  assert.equal(own.isBusyFor(B), true);
});

test("a plain in-flight request does not make the socket busy for itself", () => {
  // *streaming* claim 만 잠정 슬롯을 차지한다.
  const own = createTurnOwnership();
  own.beginRequest(A, PLAIN);
  assert.equal(own.isBusyFor(A), false);
});

test("the busy flag clears on failRequest and releaseSocket too", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING, new Set(["t1"]));
  own.failRequest(A);
  assert.equal(own.isBusyFor(A), false);

  own.beginRequest(A, STREAMING, new Set(["t1"]));
  own.releaseSocket(A);
  assert.equal(own.isBusyFor(A), false);
});

test("notifications go to the in-flight requester, then to the stream owner", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  assert.equal(own.notificationTarget(), A, "in-flight request wins");

  own.settleRequest(A, STREAMING, new Set(["t1"]));
  assert.equal(own.notificationTarget(), A, "then the parked stream owner");

  own.handleTurnCompleted(A, "t1");
  assert.equal(own.notificationTarget(), null);
});

test("server-side requests are routed to the stream owner first", () => {
  const own = createTurnOwnership();
  own.beginRequest(A, STREAMING);
  own.settleRequest(A, STREAMING, new Set(["t1"]));
  own.beginRequest(A, PLAIN); // 예: 같은 socket 의 turn/interrupt
  assert.equal(own.serverRequestTarget(), A);
});

test("handleTurnCompleted is a no-op for a socket that owns nothing", () => {
  const own = createTurnOwnership();
  assert.equal(own.handleTurnCompleted(A, "t1"), false);
  own.beginRequest(A, PLAIN);
  assert.equal(own.handleTurnCompleted(A, "t1"), false, "a plain request has no stream to complete");
});

test("back-to-back streaming turns on the same socket do not accumulate state", () => {
  const own = createTurnOwnership();
  for (const threadId of ["t1", "t2", "t3"]) {
    own.beginRequest(A, STREAMING);
    own.settleRequest(A, STREAMING, new Set([threadId]));
    own.handleTurnCompleted(A, threadId);
  }
  assert.deepEqual(own.snapshot(), {
    activeRequestSocket: null,
    activeStreamSocket: null,
    activeStreamThreadIds: null,
    pendingStreamClaim: null
  });
  assert.equal(own.isBusyFor(B), false);
});
