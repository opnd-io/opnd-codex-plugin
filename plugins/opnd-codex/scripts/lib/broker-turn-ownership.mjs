// B2 — 공유 app-server broker 의 turn 소유권.
//
// broker 는 codex app-server 하나를 여러 client socket 에 다중화하므로, 동시에 진행할
// 수 있는 turn 은 최대 하나다. 두 변수가 이를 추적한다: 지금 JSON-RPC 응답을 기다리는
// socket, 그리고 그런 요청이 시작한 streaming turn 을 소유한 socket.
//
// 이 모듈이 막으려는 버그: 그 둘이 `await` 양쪽에서 대입됐다. `turn/completed` 는
// `turn/start` 응답보다 먼저 도착하는 일이 잦은데, 그럴 때 완료 핸들러는 해제할 stream
// 소유자를 찾지 못했고 — 그 뒤 await 다음의 대입이 소유자를 세웠다. 그것을 해제할 것이
// 남지 않아, 소유 socket 이 우연히 끊길 때까지 다른 모든 client 가 BROKER_BUSY 를 받았다.
//
// 전이를 한곳에 모으면 interleaving 이 async 함수 모양에 암묵적으로 숨지 않고 테스트
// 가능해진다.

/**
 * @typedef {object} TurnOwnership
 * @property {(socket: unknown) => boolean} isBusyFor
 * @property {(socket: unknown) => boolean} canRunTurnControl
 * @property {() => unknown} notificationTarget
 * @property {() => unknown} serverRequestTarget
 * @property {(socket: unknown, streaming: boolean, expectedThreadIds?: Set<string> | null) => void} beginRequest
 * @property {(socket: unknown, streaming: boolean, threadIds: Set<string> | null) => void} settleRequest
 * @property {(socket: unknown) => void} failRequest
 * @property {(target: unknown, threadId: string | null) => boolean} handleTurnCompleted
 * @property {(socket: unknown) => void} releaseSocket
 * @property {() => object} snapshot
 */

/** @returns {TurnOwnership} */
export function createTurnOwnership() {
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  /** @type {Set<string> | null} */
  let activeStreamThreadIds = null;
  /** streaming 요청이 자신의 응답을 기다리는 동안 유지되는 잠정 claim. */
  let pendingStreamClaim = null;
  /**
   * 잠정 claim 이 밀어낸 stream 소유권.
   *
   * 이미 세워둔 stream 을 소유한 socket 은 자기 자신에 대해 busy 가 아니므로, 첫 turn 의
   * `turn/completed` 가 전달되기 전에 두 번째 `turn/start` 를 낼 수 있다. 무엇을 밀어냈는지
   * 기억하지 않으면 그 늦은 완료가 *새* turn 의 이른 완료처럼 보인다: claim 이 완료로
   * 표시되고, 이어 도착한 응답은 소유권 취득을 포기하며, turn 이 실제로 streaming 중인데도
   * broker 는 자신을 idle 로 보고한다 — 다른 client 가 같은 app-server 에서 동시 turn 을
   * 시작하게 둔다.
   *
   * 또한 streaming 요청이 reject 될 때 `failRequest` 가 이전 소유자를 되돌릴 수 있게 한다.
   * 이미 돌고 있던 stream 을 조용히 버리는 대신.
   */
  let supersededStream = null;

  function isBusyFor(socket) {
    // socket 은 자신이 *세워둔* stream 에 대해서는 결코 busy 가 아니다 — 그래서 다음 turn 을
    // 시작할 수 있다. 그러나 claim 이 아직 잠정인 동안에는 자신의 stream 에 대해서도 busy
    // 여야 한다: 그 창에서 두 번째 `beginRequest` 가 오면 단일 `pendingStreamClaim` /
    // `supersededStream` 슬롯을 덮어써, 아직 streaming 중인 turn 의 소유권을 해제할 수 있다.
    //
    // 오늘의 broker 는 그 상태에 도달할 수 없다 (`app-server-broker.mjs` 가 socket 별 chunk
    // 를 체인으로 직렬화하고, 그 메시지 루프는 다음 메시지를 읽기 전에 각 응답을 await 한다).
    // 따라서 이 줄은 프로덕션에서 발동하지 않는다. 미래의 호출자가 손상된 소유권 대신 잘
    // 정의된 BROKER_BUSY 를 받도록 존재한다 — busy gate 는 `beginRequest` 보다 먼저 돈다.
    if (pendingStreamClaim && pendingStreamClaim.socket === socket) {
      return true;
    }
    return Boolean(
      (activeRequestSocket && activeRequestSocket !== socket) ||
        (activeStreamSocket && activeStreamSocket !== socket)
    );
  }

  // *다른* socket 의 `turn/interrupt` / `turn/steer` 는 활성 stream 에 닿을 수 있지만,
  // 진행 중인 요청이 없을 때만 그렇다 — 아니면 두 요청이 같은 app-server 에서 경합한다.
  function canRunTurnControl(socket) {
    return Boolean(activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket);
  }

  function notificationTarget() {
    return activeRequestSocket ?? activeStreamSocket;
  }

  function serverRequestTarget() {
    return activeStreamSocket ?? activeRequestSocket;
  }

  /**
   * @param {unknown} socket
   * @param {boolean} streaming
   * @param {Set<string> | null} [expectedThreadIds]
   *   *요청 params* 만으로 유도할 수 있는 thread id 들. `turn/start` 는 자신의 `threadId` 를
   *   싣고 있으나 `review/start` 는 응답에서야 review thread 를 알게 되므로 불완전한 집합을
   *   (또는 아무것도) 넘길 수 있다. 오직 이 turn 의 완료와, 이 요청이 밀어낸 stream 의 늦은
   *   완료를 구분하는 데만 쓴다 — 완료를 아예 거부하는 데 쓰지 않는다.
   */
  function beginRequest(socket, streaming, expectedThreadIds = null) {
    activeRequestSocket = socket;
    if (!streaming) {
      return;
    }
    // 이 claim 이 무엇을 밀어냈는지 기억해, 그것에 대한 늦은 완료나 reject 된 요청을
    // 소유권을 손상시키지 않고 처리한다.
    supersededStream =
      activeStreamSocket === null ? null : { socket: activeStreamSocket, threadIds: activeStreamThreadIds };

    // await 하기 전에 claim 한다. `activeStreamThreadIds` 는 null 로 둔다: id 는 응답과
    // 함께야 도착한다. null 은 "잠정" 을 뜻한다.
    activeStreamSocket = socket;
    activeStreamThreadIds = null;
    pendingStreamClaim = { socket, completed: false, expected: expectedThreadIds ?? null };
  }

  function settleRequest(socket, streaming, threadIds) {
    if (streaming) {
      const completedEarly = pendingStreamClaim?.socket === socket && pendingStreamClaim.completed;
      pendingStreamClaim = null;
      supersededStream = null;
      if (completedEarly) {
        // turn 이 이미 끝났다. 소유권을 다시 잡지 말 것: 그것을 해제할 두 번째
        // `turn/completed` 는 오지 않는다.
        activeStreamSocket = null;
        activeStreamThreadIds = null;
      } else {
        activeStreamSocket = socket;
        activeStreamThreadIds = threadIds ?? null;
      }
    }
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
  }

  function failRequest(socket) {
    if (pendingStreamClaim?.socket === socket) {
      // streaming 요청이 reject 됐으므로 그 turn 은 시작조차 하지 않았다. 잠정 claim 이
      // 밀어낸 소유권을 되돌린다 — 그냥 버리면 app-server 에서 아직 도는 stream 이
      // orphan 이 된다.
      pendingStreamClaim = null;
      activeStreamSocket = supersededStream?.socket ?? null;
      activeStreamThreadIds = supersededStream?.threadIds ?? null;
      supersededStream = null;
    } else if (activeStreamSocket === socket) {
      // stream 소유자의 non-streaming 요청이 실패했다. 리팩터 이전 동작과 같다 — 정확히
      // 이 경우에 소유권을 비웠다.
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
  }

  /**
   * 완료가 회계 처리됐을 때 true 를 반환한다 (라우팅됐고, 해당하면 소유권 해제에 쓰였다).
   * 기록된 이른 완료는 `activeRequestSocket` 을 건드리지 않는다 — 진행 중에 비우면 다른
   * client 가 동시 turn 을 시작할 수 있다.
   */
  function handleTurnCompleted(target, threadId) {
    if (activeStreamSocket !== target) {
      return false;
    }

    if (pendingStreamClaim?.socket === target) {
      const expected = pendingStreamClaim.expected;
      // 이 요청이 밀어낸 stream 의 것이지, 요청 자신의 것이 아니다.
      // (둘이 thread id 를 공유하면 — 같은 thread 의 두 번째 `turn/start` — 구분할 수 없고
      // 완료는 claim 에 귀속된다. client 는 thread 위의 turn 을 직렬화하므로 그 순서는
      // 발생하지 않는다.)
      const belongsToSuperseded =
        Boolean(threadId) &&
        Boolean(supersededStream?.threadIds?.has(threadId)) &&
        !(expected && expected.has(threadId));
      if (belongsToSuperseded) {
        supersededStream = null;
        return true;
      }
      pendingStreamClaim.completed = true;
      return true;
    }

    if (threadId && activeStreamThreadIds && !activeStreamThreadIds.has(threadId)) {
      return false; // 다른 thread 의 완료
    }
    activeStreamSocket = null;
    activeStreamThreadIds = null;
    if (activeRequestSocket === target) {
      activeRequestSocket = null;
    }
    return true;
  }

  function releaseSocket(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
    if (pendingStreamClaim?.socket === socket) {
      pendingStreamClaim = null;
    }
    if (supersededStream?.socket === socket) {
      supersededStream = null;
    }
  }

  function snapshot() {
    return {
      activeRequestSocket,
      activeStreamSocket,
      activeStreamThreadIds: activeStreamThreadIds ? [...activeStreamThreadIds] : null,
      pendingStreamClaim: pendingStreamClaim
        ? { socket: pendingStreamClaim.socket, completed: pendingStreamClaim.completed }
        : null
    };
  }

  return {
    isBusyFor,
    canRunTurnControl,
    notificationTarget,
    serverRequestTarget,
    beginRequest,
    settleRequest,
    failRequest,
    handleTurnCompleted,
    releaseSocket,
    snapshot
  };
}
