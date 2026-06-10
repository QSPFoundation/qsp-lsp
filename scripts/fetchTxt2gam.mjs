#!/usr/bin/env node
/**
 * scripts/fetchTxt2gam.mjs
 *
 * Download the txt2gam WASM release from GitHub, verify the SHA-256
 * checksum, and extract txt2gam.js + txt2gam.wasm into vendor/txt2gam/.
 *
 * Caches by version: if vendor/txt2gam/.version already matches the
 * resolved version, the download is skipped.
 *
 * Environment:
 *   TXT2GAM_VERSION   Pin to a specific release tag, e.g. "v0.5.0-b1".
 *                     Default: resolved from the GitHub "latest" release.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { inflateRaw } from 'zlib';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const inflateRawAsync = promisify(inflateRaw);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VENDOR_DIR = join(ROOT, 'vendor', 'txt2gam');
const VERSION_FILE = join(VENDOR_DIR, '.version');
const REPO = 'QSPFoundation/txt2gam';

function log(msg) { process.stdout.write(msg + '\n'); }

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'qsp-lsp-build', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${url}`);
  return res.json();
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'qsp-lsp-build' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function u16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * Minimal ZIP extractor — no external dependencies.
 *
 * Reads the central directory to get reliable sizes (local headers may
 * zero-out sizes when the data-descriptor flag is set), then extracts
 * entries whose basename is in `wanted`.
 * Returns Map<basename, Buffer>.
 */
async function extractZip(zipBuf, wanted) {
  const out = new Map();

  // ── Find the End-of-Central-Directory record ──────────────────────
  // Search backwards for the EOCD signature (0x06054b50).
  // The comment can be up to 65535 bytes, so scan from the end.
  let eocdPos = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (u32(zipBuf, i) === 0x06054b50) { eocdPos = i; break; }
  }
  if (eocdPos === -1) throw new Error('Not a valid ZIP archive: EOCD not found');

  const cdOffset = u32(zipBuf, eocdPos + 16);
  const cdSize   = u32(zipBuf, eocdPos + 12);

  // ── Walk the Central Directory ────────────────────────────────────
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (u32(zipBuf, pos) !== 0x02014b50) break; // central-dir header sig

    const compression = u16(zipBuf, pos + 10);
    const compSize    = u32(zipBuf, pos + 20);
    const fnLen       = u16(zipBuf, pos + 28);
    const extraLen    = u16(zipBuf, pos + 30);
    const commentLen  = u16(zipBuf, pos + 32);
    const localOffset = u32(zipBuf, pos + 42);
    const filename    = zipBuf.subarray(pos + 46, pos + 46 + fnLen).toString('utf8');

    pos += 46 + fnLen + extraLen + commentLen;

    const basename = filename.split('/').pop() ?? filename;
    if (!wanted.has(basename)) continue;

    // Jump to the local file header to get the data offset
    if (u32(zipBuf, localOffset) !== 0x04034b50) {
      throw new Error(`Local file header signature missing for ${filename}`);
    }
    const localFnLen    = u16(zipBuf, localOffset + 26);
    const localExtraLen = u16(zipBuf, localOffset + 28);
    const dataStart     = localOffset + 30 + localFnLen + localExtraLen;

    const compressed = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = compression === 0
      ? Buffer.from(compressed)
      : await inflateRawAsync(compressed);
    out.set(basename, data);
    log(`  extracted ${filename} (${data.length} bytes)`);
  }
  return out;
}

async function main() {
  let version = process.env.TXT2GAM_VERSION?.trim();

  if (!version) {
    log('Resolving latest txt2gam release from GitHub…');
    const rel = await fetchJson(
      `https://api.github.com/repos/${REPO}/releases/latest`,
    );
    version = rel.tag_name;
  }
  log(`txt2gam version: ${version}`);

  // Skip download if the same version is already cached
  if (
    existsSync(VERSION_FILE) &&
    readFileSync(VERSION_FILE, 'utf8').trim() === version &&
    existsSync(join(VENDOR_DIR, 'txt2gam.js')) &&
    existsSync(join(VENDOR_DIR, 'txt2gam.wasm'))
  ) {
    log(`txt2gam ${version} already present — skipping download.`);
    return;
  }

  const base      = `https://github.com/${REPO}/releases/download/${version}`;
  const zipName   = `txt2gam-${version}-wasm.zip`;
  const zipUrl    = `${base}/${zipName}`;
  const sha256Url = `${base}/${zipName}.sha256`;

  log(`Downloading ${zipName}…`);
  const [zipBuf, sha256Raw] = await Promise.all([
    fetchBytes(zipUrl),
    fetchBytes(sha256Url),
  ]);

  // The .sha256 file format is "<hex>  <filename>\n" (sha256sum output)
  const expectedHash = sha256Raw.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const actualHash   = createHash('sha256').update(zipBuf).digest('hex').toLowerCase();
  if (actualHash !== expectedHash) {
    throw new Error(
      `SHA-256 mismatch for ${zipName}:\n  expected: ${expectedHash}\n  actual:   ${actualHash}`,
    );
  }
  log('SHA-256 verified.');

  const wanted = new Set(['txt2gam.js', 'txt2gam.wasm']);
  const files  = await extractZip(zipBuf, wanted);

  if (!files.has('txt2gam.js') || !files.has('txt2gam.wasm')) {
    throw new Error(
      `Expected txt2gam.js and txt2gam.wasm in the archive.\n` +
      `Found: ${[...files.keys()].join(', ') || '(nothing)'}`,
    );
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const [name, data] of files) {
    writeFileSync(join(VENDOR_DIR, name), data);
  }
  writeFileSync(VERSION_FILE, version + '\n');
  log(`Done — txt2gam ${version} ready in vendor/txt2gam/.`);
}

main().catch(err => {
  process.stderr.write((err?.message ?? String(err)) + '\n');
  process.exit(1);
});
