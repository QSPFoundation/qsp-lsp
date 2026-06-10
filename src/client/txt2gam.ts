/**
 * Lazy wrapper around the txt2gam Emscripten WASM module.
 *
 * The module is loaded once on first use; subsequent calls reuse the
 * same instance.  The WASM binary is read via `vscode.workspace.fs`
 * so that the same code works on both the desktop Node.js extension
 * host and the browser extension host (VS Code for Web).
 *
 * The `Txt2gam` class is instantiated and destroyed around every
 * encode/decode call so the library's internal state is never shared
 * between concurrent invocations.
 */

import * as vscode from 'vscode';

// ── Type declarations for the Emscripten module ───────────────────────

/** The Emscripten module factory exported by txt2gam.js. */
type CreateT2gModule = (opts?: { wasmBinary?: Uint8Array }) => Promise<T2gModule>;

interface T2gModule {
  Txt2gam: new () => Txt2gam;
  /** Error class thrown by all Txt2gam methods on failure. */
  T2gError: new (code: number) => T2gError;
  T2G_ERROR_NONE:           number; // 0
  T2G_ERROR_FAILED:         number; // 1
  T2G_ERROR_INVALID_DATA:   number; // 2
  T2G_ERROR_WRONG_PASSWORD: number; // 3
  T2G_ERROR_NO_MEMORY:      number; // 10
}

/** The `Txt2gam` binding injected by the --post-js shim. */
interface Txt2gam {
  /**
   * Parse raw text bytes (with optional BOM) to a JS string.
   * BOM takes priority; `isUnicode` is the fallback encoding hint
   * (true = UTF-8, false = ANSI/CP1251).
   */
  parseText(data: Uint8Array, isUnicode: boolean): string | null;

  /**
   * Encode a text source to QSP binary game data.
   *
   * @param text        The .qsps source (UTF-16 JS string).
   * @param locStart    Location-start marker, or null for `"#"`.
   * @param locEnd      Location-end marker, or null for `"--"`.
   * @param isOldFormat `true` to use the old QSP binary format.
   * @param isUnicode   `true` to encode game strings as UTF-16;
   *                    `false` for ANSI/CP1251.
   * @param password    Game password, or null for the default `"No"`.
   * @returns Binary game data.
   * @throws {T2gError} On failure (`WRONG_PASSWORD`, `FAILED`, etc.).
   */
  textToGame(
    text: string,
    locStart: string | null,
    locEnd: string | null,
    isOldFormat: boolean,
    isUnicode: boolean,
    password: string | null,
  ): Uint8Array;

  /**
   * Decode QSP binary game data to a text source.
   *
   * @param gameBytes   The raw `.qsp` file bytes.
   * @param password    Game password, or null for the default `"No"`.
   * @param locStart    Location-start marker, or null for `"#"`.
   * @param locEnd      Location-end marker, or null for `"--"`.
   * @returns The .qsps source as a JS string.
   * @throws {T2gError} On failure (`WRONG_PASSWORD`, `INVALID_DATA`, etc.).
   */
  gameToText(
    gameBytes: Uint8Array,
    password: string | null,
    locStart: string | null,
    locEnd: string | null,
  ): string;

  /** Free library resources. */
  destroy(): void;
}

// ── Error type ───────────────────────────────────────────────────────

/**
 * Error thrown by Txt2gam methods on failure.
 * `code` matches one of the `T2G_ERROR_*` constants on the module.
 */
export interface T2gError extends Error {
  name: 'T2gError';
  code: number;
}

/** Return true when `e` is a T2gError with the given code. */
export function isT2gError(e: unknown, code?: number): e is T2gError {
  return (
    typeof e === 'object' && e !== null &&
    (e as T2gError).name === 'T2gError' &&
    (code === undefined || (e as T2gError).code === code)
  );
}

/**
 * Error code constants — mirrored from the Emscripten module so callers
 * don't need access to the raw module object.
 */
export const T2gErrorCode = {
  FAILED:         1,
  INVALID_DATA:   2,
  WRONG_PASSWORD: 3,
  NO_MEMORY:      10,
} as const;

// ── Options types ─────────────────────────────────────────────────────

export interface EncodeOptions {
  /** Game password (default: `"No"`). */
  password?: string;
}

export interface DecodeOptions {
  /** Game password (default: `"No"`). */
  password?: string;
}

// ── Module singleton ──────────────────────────────────────────────────

let modulePromise: Promise<T2gModule> | undefined;

/**
 * Lazily load (and cache) the txt2gam Emscripten module.
 * The WASM binary is read from `out/client/txt2gam.wasm` relative to
 * the extension root, which works on both desktop and VS Code for Web.
 */
function getModule(extensionUri: vscode.Uri): Promise<T2gModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasmUri  = vscode.Uri.joinPath(extensionUri, 'out', 'client', 'txt2gam.wasm');
      const wasmData = await vscode.workspace.fs.readFile(wasmUri);

      // vendor/txt2gam/txt2gam.js is bundled into the client bundles by esbuild.
      // The dynamic import resolves to the bundled module at runtime.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const factory: CreateT2gModule = require('txt2gamJs');
      return factory({ wasmBinary: wasmData });
    })();
  }
  return modulePromise;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Encode a .qsps text source to a QSP binary game file.
 *
 * @param extensionUri  `context.extensionUri` from the `activate` call.
 * @param text          The combined .qsps source text.
 * @param opts          Encoding options.
 * @returns `Uint8Array` with the binary game data.
 * @throws {T2gError}  On encoding failure (e.g. `WRONG_PASSWORD`, `FAILED`).
 */
export async function encodeTextToGame(
  extensionUri: vscode.Uri,
  text: string,
  opts: EncodeOptions = {},
): Promise<Uint8Array> {
  const mod = await getModule(extensionUri);
  const t2g = new mod.Txt2gam();
  try {
    // Throws T2gError on failure — let it propagate to the caller.
    return t2g.textToGame(text, null, null, false, true, opts.password ?? null);
  } finally {
    t2g.destroy();
  }
}

/**
 * Decode a QSP binary game file to a .qsps text source.
 *
 * @param extensionUri  `context.extensionUri` from the `activate` call.
 * @param gameBytes     The raw `.qsp` file bytes.
 * @param opts          Decoding options.
 * @returns The .qsps text as a JS string.
 * @throws {T2gError}  On failure — notably `WRONG_PASSWORD` when the
 *                     password is incorrect, `INVALID_DATA` for corrupt files.
 */
export async function decodeGameToText(
  extensionUri: vscode.Uri,
  gameBytes: Uint8Array,
  opts: DecodeOptions = {},
): Promise<string> {
  const mod = await getModule(extensionUri);
  const t2g = new mod.Txt2gam();
  try {
    // Throws T2gError on failure — let it propagate to the caller.
    return t2g.gameToText(gameBytes, opts.password ?? null, null, null);
  } finally {
    t2g.destroy();
  }
}

/**
 * Parse raw text file bytes (with optional BOM) to a JS string.
 * Handles UTF-16 LE/BE, UTF-8, and ANSI/CP1251.
 *
 * @param extensionUri `context.extensionUri` from the `activate` call.
 * @param data         Raw file bytes.
 * @param isUnicode    Fallback encoding hint when no BOM is present
 *                     (`true` = UTF-8, `false` = ANSI/CP1251).
 */
export async function parseTextBytes(
  extensionUri: vscode.Uri,
  data: Uint8Array,
  isUnicode = true,
): Promise<string | null> {
  const mod = await getModule(extensionUri);
  const t2g = new mod.Txt2gam();
  try {
    return t2g.parseText(data, isUnicode);
  } finally {
    t2g.destroy();
  }
}

/**
 * Reset the cached module (e.g. for testing or if the WASM file changes).
 * @internal
 */
export function resetModuleCache(): void {
  modulePromise = undefined;
}
