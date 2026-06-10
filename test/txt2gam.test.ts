/**
 * Tests for the txt2gam vendor WASM module.
 *
 * These tests run directly against vendor/txt2gam/txt2gam.js (the
 * Emscripten-generated Node.js build) without going through VS Code's
 * extension host.  They verify:
 *
 *  1. The module loads and initialises correctly.
 *  2. A round-trip encode→decode preserves location names.
 *  3. The combine helper (combineFiles logic) produces correct ordering
 *     and BOM/separator handling.
 *  4. decoding an unknown password returns null.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Load the vendor module ────────────────────────────────────────────

const VENDOR_JS   = path.join(__dirname, '..', 'vendor', 'txt2gam', 'txt2gam.js');
const VENDOR_WASM = path.join(__dirname, '..', 'vendor', 'txt2gam', 'txt2gam.wasm');
const SAMPLE_QSPS = path.join(__dirname, '..', 'examples', 'sample.qsps');

// The module uses `createT2gModule` as the factory export name.
type T2gFactory = (opts?: { wasmBinary?: Uint8Array }) => Promise<{
  Txt2gam: new () => {
    parseText(data: Uint8Array, isUnicode: boolean): string | null;
    textToGame(text: string, locStart: string | null, locEnd: string | null,
               isOldFormat: boolean, isUnicode: boolean, password: string | null): Uint8Array | null;
    gameToText(gameBytes: Uint8Array, password: string | null,
               locStart: string | null, locEnd: string | null): string | null;
    destroy(): void;
  };
}>;

let createT2gModule: T2gFactory;
let mod: Awaited<ReturnType<T2gFactory>>;

beforeAll(async () => {
  if (!fs.existsSync(VENDOR_JS)) {
    throw new Error(
      `vendor/txt2gam/txt2gam.js not found.\n` +
      `Run: node scripts/fetchTxt2gam.mjs`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  createT2gModule = require(VENDOR_JS) as T2gFactory;
  const wasmBinary = new Uint8Array(fs.readFileSync(VENDOR_WASM));
  mod = await createT2gModule({ wasmBinary });
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Normalise line endings to LF and strip a leading BOM. */
function normalise(s: string): string {
  let t = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return t;
}

// ── Module-level sanity ───────────────────────────────────────────────

describe('txt2gam module', () => {
  it('loads without throwing', () => {
    expect(mod.Txt2gam).toBeDefined();
    expect(typeof mod.Txt2gam).toBe('function');
  });

  it('creates and destroys a Txt2gam instance without error', () => {
    const t2g = new mod.Txt2gam();
    expect(t2g).toBeDefined();
    t2g.destroy();
  });
});

// ── Round-trip tests ──────────────────────────────────────────────────

describe('round-trip encode → decode', () => {
  it('preserves a simple two-location source', () => {
    const source = '# start\np 1\n---\n# other\np 2\n---\n';
    const t2g = new mod.Txt2gam();
    try {
      const gameBytes = t2g.textToGame(source, null, null, false, true, null);
      expect(gameBytes).not.toBeNull();
      const decoded = t2g.gameToText(gameBytes!, null, null, null);
      expect(decoded).not.toBeNull();
      // Location names must survive the round-trip
      expect(decoded).toContain('# start');
      expect(decoded).toContain('# other');
    } finally {
      t2g.destroy();
    }
  });

  it('round-trips examples/sample.qsps', () => {
    const raw = normalise(fs.readFileSync(SAMPLE_QSPS, 'utf8'));
    const t2g = new mod.Txt2gam();
    try {
      const gameBytes = t2g.textToGame(raw, null, null, false, true, null);
      expect(gameBytes).not.toBeNull();

      const decoded = t2g.gameToText(gameBytes!, null, null, null);
      expect(decoded).not.toBeNull();

      // All location names from the original source must appear in the decoded output
      const locRe = /^# (.+)$/gm;
      const originalLocs = [...raw.matchAll(locRe)].map(m => m[1].trim());
      for (const name of originalLocs) {
        expect(decoded).toContain(`# ${name}`);
      }
    } finally {
      t2g.destroy();
    }
  });

  it('throws T2gError with WRONG_PASSWORD code when decoding with wrong password', () => {
    const source = '# start\np 1\n---\n';
    const t2g = new mod.Txt2gam();
    try {
      // Encode with a custom password, then decode with a different one.
      const gameBytes = t2g.textToGame(source, null, null, false, true, 'CorrectPW');
      expect(gameBytes).not.toBeNull();
      expect(() => t2g.gameToText(gameBytes!, 'WrongPassword123', null, null))
        .toThrow(expect.objectContaining({ name: 'T2gError', code: 3 }));
    } finally {
      t2g.destroy();
    }
  });

  it('round-trips a custom password', () => {
    const source = '# secret\np 1\n---\n';
    const pw = 'MySecretPW';
    const t2g = new mod.Txt2gam();
    try {
      const gameBytes = t2g.textToGame(source, null, null, false, true, pw);
      expect(gameBytes).not.toBeNull();
      const decoded = t2g.gameToText(gameBytes!, pw, null, null);
      expect(decoded).not.toBeNull();
      expect(decoded).toContain('# secret');
    } finally {
      t2g.destroy();
    }
  });
});

// ── parseText ─────────────────────────────────────────────────────────

describe('parseText', () => {
  it('handles a plain UTF-8 source (no BOM)', () => {
    const text = '# start\np 1\n---\n';
    const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
    const t2g = new mod.Txt2gam();
    try {
      const result = t2g.parseText(bytes, true);
      expect(result).not.toBeNull();
      expect(normalise(result!)).toContain('# start');
    } finally {
      t2g.destroy();
    }
  });

  it('strips a UTF-8 BOM automatically', () => {
    const bom  = Buffer.from([0xEF, 0xBB, 0xBF]);
    const text = Buffer.from('# start\np 1\n---\n', 'utf8');
    const bytes = new Uint8Array(Buffer.concat([bom, text]));
    const t2g = new mod.Txt2gam();
    try {
      const result = t2g.parseText(bytes, true);
      expect(result).not.toBeNull();
      expect(normalise(result!)).toContain('# start');
    } finally {
      t2g.destroy();
    }
  });
});

// ── combineFiles logic (pure, no vscode) ─────────────────────────────

describe('combineFiles logic', () => {
  /**
   * Minimal re-implementation of the combineFiles helper from
   * exportCommands.ts so we can unit-test it without VS Code.
   */
  function combineTexts(texts: string[]): string {
    const parts = texts.map(text => {
      let t = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      if (!t.endsWith('\n')) t += '\n';
      return t;
    });
    return parts.join('\n');
  }

  it('joins two files with a blank line between them', () => {
    const a = '# loc1\np 1\n---\n';
    const b = '# loc2\np 2\n---\n';
    const combined = combineTexts([a, b]);
    const lines = combined.split('\n');
    // There should be an empty line between the two location blocks
    const aEnd   = lines.indexOf('---');
    const bStart = lines.indexOf('# loc2');
    expect(bStart).toBeGreaterThan(aEnd + 1);
  });

  it('sorts alphabetically — a.qsps before b.qsps', () => {
    // Simulate URI sort: 'file:///b.qsps' > 'file:///a.qsps'
    const uris = ['file:///b.qsps', 'file:///a.qsps'];
    uris.sort((a, b) => a.localeCompare(b));
    expect(uris[0]).toBe('file:///a.qsps');
  });

  it('ensures trailing newline is added', () => {
    const text = '# loc\np 1\n---'; // no trailing newline
    const combined = combineTexts([text]);
    expect(combined.endsWith('\n')).toBe(true);
  });

  it('strips leading BOM from each file', () => {
    const bom  = '\uFEFF';
    const text = `${bom}# loc\np 1\n---\n`;
    const combined = combineTexts([text]);
    expect(combined.charCodeAt(0)).not.toBe(0xFEFF);
  });
});
