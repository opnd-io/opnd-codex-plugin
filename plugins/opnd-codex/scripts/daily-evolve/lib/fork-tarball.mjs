/**
 * fork-tarball.mjs — Phase 2 fork tarball local scan predicates
 *
 * Plan reference: plan-daily-evolve-pipeline.md
 *   - § Active Forks Research — Local static scan (no-npm)
 *   - § Codex Critique R2-MEDIUM-8 (no-npm 룰 내 tarball 처리)
 *   - § R3-M2 path normalization (Windows `\` → POSIX `/`)
 *
 * Lib pure module — filesystem / network 호출 금지 (R2-L2 dep rule).
 * 실제 tarball 다운로드 + extract 는 orchestrator (fork-research.mjs) 가 git CLI 또는
 * `gh api .../tarball/{ref}` subprocess 호출. 본 lib 은 predicates 만 제공.
 *
 * Node 내장 의존성 없음 (zero npm).
 */

/** 1 MB binary skip threshold (Phase 2 §Active Forks — Local static scan). */
export const BINARY_SIZE_BYTES = 1 * 1024 * 1024;

/** Vendor path patterns — major mass-change skip rules. */
export const VENDOR_PATH_PATTERNS = Object.freeze([
  /(^|\/)node_modules\//i,
  /(^|\/)vendor\//i,
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)\.next\//i,
  /(^|\/)\.nuxt\//i,
  /(^|\/)target\//i, // rust / java build output
  /(^|\/)__pycache__\//i,
  /(^|\/)\.venv\//i,
  /(^|\/)coverage\//i,
]);

/** Vendor file extension patterns. */
export const VENDOR_FILE_PATTERNS = Object.freeze([
  /\.lock$/i,
  /\.min\.[a-z]+$/i, // *.min.js, *.min.css
  /\.bundle\.[a-z]+$/i, // *.bundle.js
  /-lock\.[a-z]+$/i, // package-lock.json, yarn.lock 동치
]);

/** Binary file extension patterns (magic byte check 대신 휴리스틱). */
export const BINARY_FILE_PATTERNS = Object.freeze([
  /\.(png|jpg|jpeg|gif|webp|ico|bmp|tiff)$/i,
  /\.(pdf|zip|tar|gz|bz2|7z|rar|xz)$/i,
  /\.(exe|dll|so|dylib|bin|class|wasm)$/i,
  /\.(mp3|mp4|mov|avi|webm|ogg|wav|flac)$/i,
  /\.(ttf|otf|woff|woff2|eot)$/i,
  /\.(jar|war|ear)$/i,
]);

/**
 * Normalize path — Windows `\` → POSIX `/`. Pure.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePosixPath(p) {
  if (typeof p !== "string") return "";
  return p.replace(/\\/g, "/");
}

/**
 * Vendor path 검출. Pure.
 *
 * @param {string} p - POSIX normalized path
 * @returns {boolean}
 */
export function isVendorPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const norm = normalizePosixPath(p);
  if (VENDOR_PATH_PATTERNS.some((re) => re.test(norm))) return true;
  if (VENDOR_FILE_PATTERNS.some((re) => re.test(norm))) return true;
  return false;
}

/**
 * Binary file extension 검출 (magic byte 대신 휴리스틱). Pure.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isBinaryByExtension(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  return BINARY_FILE_PATTERNS.some((re) => re.test(p));
}

/**
 * size 기반 binary 판단. Pure.
 *
 * @param {number} sizeBytes
 * @returns {boolean}
 */
export function isBinaryBySize(sizeBytes) {
  if (!Number.isFinite(sizeBytes)) return false;
  return sizeBytes > BINARY_SIZE_BYTES;
}

/**
 * Magic byte 기반 binary detection (orchestrator 가 head bytes 제공). Pure.
 * NUL byte 가 첫 512 byte 안에 있으면 binary 로 간주 (git 의 휴리스틱과 동일).
 *
 * @param {Buffer|Uint8Array|string|null} headBytes - 첫 ≤512 byte sample
 * @returns {boolean}
 */
export function isBinaryByMagic(headBytes) {
  if (headBytes == null) return false;
  if (typeof headBytes === "string") {
    return headBytes.includes("\x00");
  }
  if (headBytes instanceof Uint8Array || Array.isArray(headBytes)) {
    const sample = headBytes.subarray
      ? headBytes.subarray(0, Math.min(512, headBytes.length))
      : headBytes.slice(0, Math.min(512, headBytes.length));
    for (const b of sample) {
      if (b === 0) return true;
    }
  }
  return false;
}

/**
 * skipPath 종합 판정 — vendor / binary-extension / binary-size / binary-magic 중 1+. Pure.
 *
 * caller 가 size + headBytes 알면 inject, 모르면 path 만으로 판단.
 *
 * @param {{ path: string, size?: number, headBytes?: Buffer|Uint8Array|string|null }} input
 * @returns {{ skip: boolean, reason: string | null }}
 */
export function shouldSkipPath({ path: p, size, headBytes } = {}) {
  if (typeof p !== "string" || p.length === 0) {
    return { skip: true, reason: "path missing" };
  }
  if (isVendorPath(p)) return { skip: true, reason: "vendor" };
  if (isBinaryByExtension(p)) return { skip: true, reason: "binary_extension" };
  if (size != null && isBinaryBySize(size)) return { skip: true, reason: "binary_size" };
  if (headBytes != null && isBinaryByMagic(headBytes)) return { skip: true, reason: "binary_magic" };
  return { skip: false, reason: null };
}

/**
 * Non-vendor diff ratio 계산 — touched_paths 전체 중 vendor 가 아닌 것 비율. Pure.
 *
 * @param {string[]} paths
 * @returns {number} 0~1
 */
export function nonVendorDiffRatio(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return 0;
  const nonVendor = paths.filter((p) => !isVendorPath(p)).length;
  return nonVendor / paths.length;
}
