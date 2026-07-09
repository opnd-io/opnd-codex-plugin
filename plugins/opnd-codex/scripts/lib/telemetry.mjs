// PR-9.1 + PR-9.2 — cross-job 관측성을 위한 JSONL 이벤트 로그 + correlation id
// (trace.id). 세그먼트 안에서는 append-only, 크기 상한에서 회전한다 (아래 참조).
//
// 설계 제약 (load-bearing — 변경 전에 읽을 것):
//   - Telemetry 는 절대 호출자를 죽이면 안 된다. 모든 write 는 try/catch 와
//     `silentFail` 폴백으로 감싼다. telemetry write 실패는 job lifecycle 관점에서
//     no-op 이다.
//   - **회전 (v2.4.0):** `TELEMETRY_MAX_BYTES` 를 넘으면 현재 파일을
//     `events.jsonl.1` 로 rename 하고 새 파일을 시작한다. 회전 세그먼트는 정확히
//     1개만 유지한다. 모든 READER 는 둘 다, 오래된 것부터 읽어야 한다 —
//     `events.jsonl` 만 읽으면 이력이 조용히 사라진다. `codex-efficiency-report.mjs`
//     의 첫 버전이 바로 그 방식으로, 자기가 보고하던 `telemetry_write_failed`
//     마커를 undercount 했다. 사용자용 설명은 `docs/TROUBLESHOOTING.md` 에 있다.
//     회전은 맨 `renameSync` 다 — 목적지를 먼저 unlink 하면 안 된다. 두 writer 가
//     경합할 때 서로의 회전 세그먼트를 파괴한다.
//   - Telemetry 는 기본 활성이되 완전히 끄기 쉬워야 한다.
//     `CODEX_PLUGIN_TELEMETRY_DISABLED=1` 은 모든 public 진입점을 파일시스템 접근
//     이전에 short-circuit 한다. events.jsonl 부수효과를 원치 않는 CI 실행과 contract
//     test 에 유용하다.
//   - 로그 파일이 워크스페이스 간 공유되는 것은 의도다 — telemetry stream 의 존재
//     이유가 cross-job + cross-repo 분석이기 때문. 워크스페이스 스코프로 남아야 할
//     상태는 이미 `${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<hash>/` 에 있다.
//   - schema 는 버전이 있다. `SCHEMA_VERSION` 을 올리려면 모든 emit 지점과 contract
//     test 를 갱신해야 하므로, 추가적(additive) 변경은 새 필드를 `extras` 아래 둔다.
//   - **동시 append 안전성 (audit finding #1):** JSONL writer 는 단일 호출 라인
//     append 를 위해 `fs.appendFileSync` 에 의존한다. POSIX 에서는 `PIPE_BUF`
//     (4096 bytes) 미만 write 가 원자적이며, 현재 schema 가 만들 수 있는 모든 이벤트를
//     넉넉히 덮는다 (관측된 최장 라인 ~600 bytes). Windows 에는 다른 프로세스가 append
//     모드로 연 파일에 대한 `WriteFile` 의 원자적 append 보장이 문서화돼 있지 않다.
//     실제로 플러그인이 만드는 양(job 당 이벤트 1개, 최대 ~6개)에서는 Win11 + NTFS 에
//     interleave 를 관측한 적이 없다. 다만 이 stream 의 동시성을 높인다면 아래
//     `appendFileSync` 주위에 lib/state.mjs 의 lock 패턴을 추가하라 — async I/O 로
//     조용히 바꾸지 말 것. 경고 없이 여기 race 를 되살린다.
//   - **`extras` 필드명 예약 (audit finding #4):** 어떤 이벤트에서든 한 번
//     `extras` 안에 나타난 이름은 그 위치에 예약된다. 나중에 top-level known 필드로
//     승격시키면 모든 downstream consumer 가 동일한 `schemaVersion: 1` 아래에서 두
//     위치를 다 확인해야 하는데, 그렇게 하지 않는다 — 대신 SCHEMA_VERSION 을 올린다.
//     반대로 top-level 필드를 `extras` 로 강등시키지도 말 것.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// #338 — codex-namespaced plugin-data var (see session-lifecycle-hook.mjs).
const CODEX_PLUGIN_DATA_DIR_ENV = "CODEX_PLUGIN_DATA_DIR";
const DISABLE_ENV = "CODEX_PLUGIN_TELEMETRY_DISABLED";
const MAX_BYTES_ENV = "CODEX_PLUGIN_TELEMETRY_MAX_BYTES";
const FALLBACK_DATA_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const TELEMETRY_DIR_NAME = "telemetry";
const TELEMETRY_FILE_NAME = "events.jsonl";
export const TELEMETRY_ROTATED_SUFFIX = ".1";

// 회전 임계값. `log-tail.mjs` 의 READ_LOG_TAIL_FULL_READ_CAP_BYTES 와 의도적으로
// 일치시킨다: 그 크기를 넘으면 reader 가 조용히 windowed read 로 격하되므로,
// writer 를 그 이상 자라게 두면 tail 커맨드가 거짓을 말하기 시작한다.
export const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;

export const SCHEMA_VERSION = 1;

// 허용 이벤트 이름 — contract test 및 docs/TROUBLESHOOTING.md (telemetry 섹션) 와
// 동기 유지. 알 수 없는 이벤트도 emit 은 되지만(막지 않는다), stream 을 읽는 도구는
// 이 집합을 기대한다.
export const EVENT_NAMES = Object.freeze([
  "enqueued",      // job 생성 + 큐 등록 (background 경로)
  "started",       // job lifecycle 시작 (foreground 또는 worker pickup)
  "progress",      // phase 전이 또는 주요 진행 신호
  "completed",     // terminal 성공
  "failed",        // terminal 실패
  "cancelled",     // 사용자 취소
  "terminated",    // kill 됨 (SIGTERM / pid reaper)
  "timeout",       // finalizing phase 또는 외부 timeout
  // write 가 한 번 이상 실패한 뒤 첫 성공 write 에서 기록된다.
  // 이것이 없으면 reader 는 "이벤트 없음" 과 "이벤트 유실" 을 구분할 수 없다.
  "telemetry_write_failed"
]);

// 거친 에러 taxonomy — emit 지점이 해당하는 버킷을 고르거나, 이벤트가 에러가 아니면
// 필드 자체를 생략한다.
export const ERROR_CLASSES = Object.freeze([
  "rate-limit",
  "auth",
  "sandbox",
  "timeout",
  "parse",
  "network",
  "broker",
  // 호출자가 불가능한 것을 요청했다 (prompt 없음, resume 할 이전 thread 없음, 이미
  // 실행 중인 job). 실행 자체가 시작되지 않았으므로 이를 runtime 실패로 세면 실패율이
  // 부풀고 진짜 회귀가 가려진다.
  "input",
  "other"
]);

const ERROR_CLASS_RULES = Object.freeze([
  // 순서가 중요하다: 첫 매치가 이긴다. 더 구체적인 패턴을 앞에 둘 것.
  { errorClass: "input", pattern: /No previous Codex task thread was found/i },
  { errorClass: "input", pattern: /Provide a prompt/i },
  { errorClass: "input", pattern: /\bis still running\b.*\/opnd-codex:/i },
  { errorClass: "input", pattern: /No reusable Codex task session found/i },
  { errorClass: "input", pattern: /fingerprint changed; use --fresh/i },
  { errorClass: "broker", pattern: /No live Codex broker is available/i },
  { errorClass: "broker", pattern: /broker is busy/i },
  { errorClass: "broker", pattern: /NO_SURVIVABLE_BROKER|SUBAGENT_BROKER_BUSY/ },
  // `quota` 에는 단어 경계가 필요하다: 없으면 "malformed quotation" 과 "bad quotation
  // mark" — 둘 다 JSON parse 에러 — 가 rate-limit 으로 분류된다. 이 규칙이 아래
  // `parse` 규칙보다 먼저 평가되기 때문이다.
  // `stop-review-gate-hook.mjs` 의 RATE_LIMIT_SIGNATURES 는 이미 `\bquota\b` 를 쓴다.
  { errorClass: "rate-limit", pattern: /\brate.?limit|usage limit|\bquota\b|(^|\D)429(\D|$)/i },
  { errorClass: "rate-limit", pattern: /at capacity/i },
  { errorClass: "auth", pattern: /authentication expired|refresh token|not logged in|codex login/i },
  { errorClass: "timeout", pattern: /timed? ?out|ETIMEDOUT/i },
  { errorClass: "network", pattern: /Reconnecting|ECONNRESET|ENOTFOUND|socket hang up/i },
  { errorClass: "parse", pattern: /invalid json|unexpected token|JSON\.parse/i },
  { errorClass: "sandbox", pattern: /sandbox|EPERM|EACCES/i }
]);

/**
 * 자유 형식 에러 메시지를 ERROR_CLASSES 로 매핑한다. 순수 함수이며, 아무것도 매치되지
 * 않으면 "other" 를 반환해 호출자가 항상 이벤트를 귀속시킬 버킷을 갖게 한다.
 *
 * `input` 클래스가 이 함수의 존재 이유다: `failed` 로 기록된 이벤트의 약 1/7 이
 * 실행이 깨진 게 아니라 CLI 가 잘못된 요청을 거부한 것이었다. 죽은 broker 와는 다른
 * 버킷에 속한다.
 */
export function classifyErrorClass(errorMessage) {
  const text = String(errorMessage ?? "");
  if (!text) {
    return "other";
  }
  for (const { errorClass, pattern } of ERROR_CLASS_RULES) {
    if (pattern.test(text)) {
      return errorClass;
    }
  }
  return "other";
}

/**
 * Generate a 16-character hex correlation id (PR-9.2).
 *
 * Used to stitch together every event that belongs to a single logical run
 * across the broker / worker boundary. Long enough (64 bits of entropy) to
 * make collisions vanishingly unlikely for the lifetime of any practical
 * telemetry archive, short enough to copy/paste in a terminal.
 */
export function createTraceId() {
  return crypto.randomBytes(8).toString("hex");
}

export function isTelemetryDisabled(env = process.env) {
  const raw = String(env[DISABLE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function resolveTelemetryDir(env = process.env) {
  const pluginDataDir = env[CODEX_PLUGIN_DATA_DIR_ENV] ?? env[PLUGIN_DATA_ENV];
  const root = pluginDataDir ? pluginDataDir : FALLBACK_DATA_ROOT_DIR;
  return path.join(root, TELEMETRY_DIR_NAME);
}

export function resolveTelemetryFile(env = process.env) {
  return path.join(resolveTelemetryDir(env), TELEMETRY_FILE_NAME);
}

export function resolveRotatedTelemetryFile(env = process.env) {
  return `${resolveTelemetryFile(env)}${TELEMETRY_ROTATED_SUFFIX}`;
}

export function resolveTelemetryMaxBytes(env = process.env) {
  const raw = Number(env[MAX_BYTES_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : TELEMETRY_MAX_BYTES;
}

// 이 프로세스가 시도했다가 잃은 write 수. 손실이 stream 에 기록되면 리셋한다
// (`flushDeferredWriteFailures` 참조).
let deferredWriteFailures = 0;
let writeFailureNoticeEmitted = false;

/**
 * 이 프로세스가 write 에 실패했고 아직 기록하지 못한 이벤트 수.
 *
 * 테스트가 읽는다. 같은 사실의 사용자 노출면은 `flushDeferredWriteFailures` 가 쓰는
 * `telemetry_write_failed` 이벤트이고, 그것을 `codex-efficiency-report.mjs` 가
 * 합산한다 — 이 accessor 는 어떤 커맨드 출력에도 배선돼 있지 않다.
 */
export function __telemetryWriteFailureCount() {
  return deferredWriteFailures;
}

/** 테스트 전용: 지연 실패 카운터와 warn-once latch 를 초기화한다. */
export function __resetTelemetryFailureState() {
  deferredWriteFailures = 0;
  writeFailureNoticeEmitted = false;
}

function silentFail(error) {
  // Telemetry 는 job lifecycle 에 load-bearing 이 아니다. 에러를 표면화하면 부하
  // 상황(디스크 가득, 권한 거부, 정리 중 경로 race)에서 동작이 바뀌는데, 그 상황이야말로
  // 실제 job 이 계속 돌아야 하는 순간이다.
  //
  // 그렇다고 *보이지 않아도* 안 된다: telemetry dir 이 조용히 쓰기 불가가 되면 모든
  // downstream 카운트가 완벽히 건강해 보이면서 틀린다. 그래서 손실을 세고, 프로세스당
  // 한 번 stderr 에 경고하고, 다시 write 가 성공하는 즉시 `telemetry_write_failed`
  // 이벤트를 기록한다.
  deferredWriteFailures += 1;
  const debug = process.env.CODEX_PLUGIN_TELEMETRY_DEBUG === "1";
  if (debug || !writeFailureNoticeEmitted) {
    writeFailureNoticeEmitted = true;
    try {
      process.stderr.write(
        `[codex-telemetry] write failed (${error?.message ?? error}). ` +
          `Events from this process are being dropped; counts derived from the ledger will undercount.\n`
      );
    } catch {
      // 경고조차 best-effort 다.
    }
  }
}

// write 실패는 자기 자신을 기록할 수 없다. 다만 다음 성공 write 는 할 수 있다 —
// 그래서 손실이, 아무도 보관하지 않는 stderr 한 줄이 아니라 stream 안에서 보이게 된다.
let flushingDeferredFailures = false;
function flushDeferredWriteFailures(env, now) {
  if (deferredWriteFailures === 0 || flushingDeferredFailures) {
    return;
  }
  const lost = deferredWriteFailures;
  deferredWriteFailures = 0;
  flushingDeferredFailures = true;
  let recorded = false;
  try {
    recorded = emitEvent("telemetry_write_failed", { droppedEvents: lost }, { env, now });
  } finally {
    flushingDeferredFailures = false;
  }
  if (!recorded) {
    // 마커 자체를 쓰지 못했다. 카운트를 되돌려 놓아(silentFail 이 실패한 마커에 대해
    // 이미 1을 더했다) 다음 성공 write 가 마지막 시도분만이 아니라 손실 전체를
    // 보고하게 한다.
    deferredWriteFailures += lost;
  }
}

/**
 * `events.jsonl` 이 상한을 넘으면 `events.jsonl.1` 로 굴린다.
 *
 * `renameSync` 는 원자적이므로 두 프로세스가 여기서 경합해도 interleave 하지 않는다:
 * 진 쪽의 rename 이 throw 하고(원본이 이미 사라짐) 그냥 새 파일에 append 한다. 몇몇
 * 이벤트가 새 파일 대신 회전된 파일에 들어갈 수 있다 — best-effort stream 에서는
 * 허용 가능하며, reader 의 8 MB 창을 조용히 무력화하는 무한 ledger 보다 훨씬 낫다.
 *
 * 여기서 `lib/state.mjs` 의 lock 을 의도적으로 잡지 않는다: state.mjs 가 이 모듈을
 * import 하므로(reaper 가 이벤트를 emit), 의존하면 import cycle 이 생긴다.
 */
export function rotateTelemetryIfNeeded(env = process.env) {
  const file = resolveTelemetryFile(env);
  const maxBytes = resolveTelemetryMaxBytes(env);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // 아직 파일이 없다 — 회전할 것도 없다.
  }
  if (size < maxBytes) {
    return false;
  }
  const rotated = `${file}${TELEMETRY_ROTATED_SUFFIX}`;
  try {
    // `renameSync` 는 기존 목적지를 원자적으로 대체하므로 먼저 unlink 하면 안 된다.
    // 두 writer 가 모두 이 지점에 도달할 수 있는데, A 가 rename 한 뒤 B 가 자기 rename
    // 전에 unlink 하면 B 는 A 가 방금 회전시킨 세그먼트를 아무 이유 없이 파괴한 것이다.
    // rename 만 하면 진 쪽의 rename 은 그냥 실패한다(원본이 사라졌으므로).
    fs.renameSync(file, rotated);
    return true;
  } catch {
    // 경합에서 졌거나, Windows 에서 reader 가 파일을 잠갔다. 아래 append 는 여전히
    // 성공한다. 회전은 다음 이벤트에서 재시도한다.
    return false;
  }
}

/**
 * Emit one event to the shared JSONL log. Best-effort, never throws.
 *
 * Required:
 *   - event: one of EVENT_NAMES
 *   - traceId: correlation id (use createTraceId() if you do not have one)
 *
 * Optional structured fields are passed through verbatim. Unknown fields
 * land under `extras` so the schema can grow without a version bump.
 */
export function emitEvent(event, fields = {}, { env = process.env, now = () => new Date() } = {}) {
  if (isTelemetryDisabled(env)) {
    return false;
  }
  if (typeof event !== "string" || event.length === 0) {
    silentFail(new Error("emitEvent requires a non-empty event name"));
    return false;
  }
  const ts = now();
  if (!(ts instanceof Date) || Number.isNaN(ts.valueOf())) {
    silentFail(new Error("emitEvent received a non-Date `now()` result"));
    return false;
  }

  const knownKeys = new Set([
    "traceId", "jobId", "jobClass", "phase", "cwd",
    "elapsedMs", "errorClass", "fallbackPath", "model", "effort", "threadId"
  ]);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    ts: ts.toISOString(),
    event
  };
  const extras = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (knownKeys.has(key)) {
      record[key] = value;
    } else {
      extras[key] = value;
    }
  }
  if (Object.keys(extras).length > 0) {
    record.extras = extras;
  }

  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (error) {
    silentFail(error);
    return false;
  }

  const dir = resolveTelemetryDir(env);
  const file = resolveTelemetryFile(env);
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotateTelemetryIfNeeded(env);
    fs.appendFileSync(file, line, { encoding: "utf8" });
  } catch (error) {
    silentFail(error);
    return false;
  }
  flushDeferredWriteFailures(env, now);
  return true;
}
