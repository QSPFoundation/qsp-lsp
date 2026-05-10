/**
 * QSP Language Server — Node.js entry point.
 * Used on desktop (macOS, Windows, Linux) and Android (Termux).
 * Communicates via stdio transport.
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { createQspServer, type FsProvider } from './common';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Resolve WASM files relative to this bundle's output location.
// In production: out/server/nodeMain.js
//   grammar WASM  → out/tree-sitter-qsp.wasm
//   runtime WASM  → out/server/tree-sitter.wasm  (copied during build)
const wasmLoader = async () => {
  const wasmPath = path.join(__dirname, '..', 'tree-sitter-qsp.wasm');
  return fs.readFileSync(wasmPath);
};

// Tell web-tree-sitter where its own tree-sitter.wasm runtime lives.
const wasmDir = () => __dirname;

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
function decodeBuffer(buf: Buffer, encoding: string): string {
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

const fsProvider: FsProvider = {
  readFile(filePath: string, encoding?: string): string {
    const buf = fs.readFileSync(filePath);
    return decodeBuffer(buf, encoding ?? 'utf8');
  },

  findFiles(dir: string, extensions: string[]): string[] {
    const extSet = new Set(extensions);
    const results: string[] = [];

    function walk(dirPath: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return; // Permission denied or not a directory
      }
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extSet.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    }

    walk(dir);
    return results;
  },

  pathToUri(filePath: string): string {
    return URI.file(filePath).toString();
  },

  uriToPath(uri: string): string {
    return URI.parse(uri).fsPath;
  },
};

createQspServer(connection, documents, wasmLoader, wasmDir, fsProvider);
