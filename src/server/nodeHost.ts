/**
 * Node.js host pieces for the QSP language server: WASM loading, file
 * decoding and the filesystem provider for project mode. Shared by the
 * stdio server (nodeMain.ts) and the MCP server (src/mcp), which embeds
 * the language server in its own process.
 */
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import type { WasmLoader, WasmDirProvider } from '../parser';
import type { FsProvider } from './serverUtils';
import { excludeMatcher, type ExcludeMatcher } from '../common/projectExclude';

/**
 * WASM locations inside the extension's `out/` directory:
 *   grammar WASM  → out/tree-sitter-qsp.wasm
 *   runtime WASM  → out/server/tree-sitter.wasm  (copied during build)
 */
export function wasmFromOutDir(outDir: string): { wasmLoader: WasmLoader; wasmDir: WasmDirProvider } {
  return {
    wasmLoader: async () => fs.readFileSync(path.join(outDir, 'tree-sitter-qsp.wasm')),
    // Tells web-tree-sitter where its own tree-sitter.wasm runtime lives.
    wasmDir: () => path.join(outDir, 'server'),
  };
}

// ── Encoding helpers ───────────────────────────────────────────────

/**
 * Decode a raw Buffer to a string.
 *
 * If the buffer starts with a BOM the BOM wins (regardless of `encoding`).
 * Otherwise the value of VS Code's `files.encoding` setting is used.
 *
 * Natively supported: utf8, utf8bom, utf16le, utf16be.
 * Anything else falls back to UTF-8.
 */
export function decodeBuffer(buf: Buffer, encoding: string): string {
  // ── BOM detection (always takes priority) ──
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16 LE BOM
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE BOM — swap bytes then decode as LE
    return swapAndDecode(buf.subarray(2));
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    // UTF-8 BOM
    return buf.subarray(3).toString('utf-8');
  }

  // ── No BOM — use the configured encoding ──
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      return buf.toString('utf-8');
    case 'utf16le':
      return buf.toString('utf16le');
    case 'utf16be':
      return swapAndDecode(buf);
    default:
      // Unsupported encoding — fall back to UTF-8
      return buf.toString('utf-8');
  }
}

/**
 * Encode `text` the way `original` (the file's current bytes) is encoded:
 * the same BOM and UTF flavour, so rewriting a file changes only the text.
 * Files without a BOM are written as UTF-8, which is also how they are read.
 */
export function encodeLike(text: string, original: Buffer): Buffer {
  if (original.length >= 2 && original[0] === 0xff && original[1] === 0xfe) {
    return Buffer.concat([original.subarray(0, 2), Buffer.from(text, 'utf16le')]);
  }
  if (original.length >= 2 && original[0] === 0xfe && original[1] === 0xff) {
    const le = Buffer.from(text, 'utf16le');
    for (let i = 0; i + 1 < le.length; i += 2) {
      const b = le[i]; le[i] = le[i + 1]; le[i + 1] = b;
    }
    return Buffer.concat([original.subarray(0, 2), le]);
  }
  if (original.length >= 3 && original[0] === 0xef && original[1] === 0xbb && original[2] === 0xbf) {
    return Buffer.concat([original.subarray(0, 3), Buffer.from(text, 'utf-8')]);
  }
  return Buffer.from(text, 'utf-8');
}

/** Swap every pair of bytes (BE→LE) and decode as UTF-16 LE. */
function swapAndDecode(buf: Buffer): string {
  // Clamp to even length — a trailing byte in a UTF-16 stream is corrupt.
  const len = buf.length & ~1;
  const swapped = Buffer.alloc(len);
  for (let i = 0; i < len; i += 2) {
    swapped[i] = buf[i + 1];
    swapped[i + 1] = buf[i];
  }
  return swapped.toString('utf16le');
}

// ── File system provider for project mode ──────────────────────────
//
// URIs enter the server from two sources: LSP notifications from the
// client (already in VS Code's RFC 3986 canonical form, e.g.
// `file:///c%3A/…` on Windows) and our own filesystem scans below.
// `URI.file(path).toString()` is the same function VS Code uses
// internally, so both sources produce byte-identical URI keys — no
// downstream normalization needed.
//
// On the way out, `URI.parse(uri).fsPath` is the inverse operation and
// handles both canonical (`file:///c%3A/…`) and literal (`file:///c:/…`)
// forms uniformly.

// Directories that are never part of a QSP project and can be huge
// (node_modules in particular can hold tens of thousands of files) —
// skipped outright during the workspace scan below.
/** Yield to the event loop so pending LSP requests get a turn. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export const fsProvider: FsProvider = {
  async readFile(filePath: string, encoding?: string): Promise<string> {
    const buf = await fs.promises.readFile(filePath);
    return decodeBuffer(buf, encoding ?? 'utf8');
  },

  // Async generator: walks the directory tree depth-first, yielding one
  // matching file path at a time. Awaiting `readdir` and yielding to the
  // event loop after every directory means a scan of a large workspace
  // no longer runs as a single uninterrupted synchronous block — see the
  // FsProvider doc comment in serverUtils.ts for why that matters.
  async *findFiles(dir: string, extensions: string[], exclude?: ExcludeMatcher): AsyncIterable<string> {
    const extSet = new Set(extensions);
    const skip = exclude ?? excludeMatcher({ patterns: [], source: 'none' });
    const rel = (p: string) => path.relative(dir, p).split(path.sep).join('/');

    async function* walk(dirPath: string): AsyncGenerator<string> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        return; // Permission denied or not a directory
      }
      await yieldToEventLoop();
      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (!skip.dir(rel(entryPath))) yield* walk(entryPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extSet.has(ext) && !skip.file(rel(entryPath))) yield entryPath;
        }
      }
    }

    yield* walk(dir);
  },

  pathToUri(filePath: string): string {
    return URI.file(filePath).toString();
  },

  uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
  },
};
