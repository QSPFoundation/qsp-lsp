#!/usr/bin/env node
// ── Third-party notices ──────────────────────────────────────────────
//
// Writes THIRD_PARTY_NOTICES.md: the license of every npm package the
// extension's bundles contain, plus the files shipped next to them
// (tree-sitter's runtime WASM, txt2gam). The package list comes from
// esbuild itself: the bundles' entry points are bundled again in memory
// with a metafile, so a dependency that is only a devDependency, or one
// the code never imports, is not listed.
//
//   node scripts/thirdPartyNotices.mjs [--check]
//
// --check fails when the file on disk is out of date instead of writing it.
// Keep ENTRIES in step with the build:* scripts in package.json.

import { build } from 'esbuild';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'THIRD_PARTY_NOTICES.md');
const txt2gam = { txt2gamJs: './vendor/txt2gam/txt2gam.js' };

const ENTRIES = [
  { entryPoints: ['src/server/nodeMain.ts'], platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['src/server/browserMain.ts'], platform: 'browser', format: 'esm', external: ['web-tree-sitter'] },
  { entryPoints: ['src/client/nodeMain.ts'], platform: 'node', format: 'cjs', external: ['vscode'], alias: txt2gam },
  { entryPoints: ['src/client/browserMain.ts'], platform: 'browser', format: 'esm', external: ['vscode', 'node:fs'], alias: txt2gam },
  { entryPoints: ['src/mcp/main.ts'], platform: 'node', format: 'cjs', mainFields: ['module', 'main'], alias: txt2gam },
  { entryPoints: ['src/webview/graph.ts'], platform: 'browser', format: 'iife' },
];

const DAGRE_LICENSE = `Copyright (c) 2012-2014 Chris Pettitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`;

// Code that reaches the bundles without a package of its own in
// node_modules, and files shipped as they are.
const SHIPPED = [
  {
    // cytoscape-dagre's dist has these rolled in; they are only its devDependencies.
    name: '@dagrejs/dagre, @dagrejs/graphlib (inside cytoscape-dagre)',
    license: 'MIT',
    text: DAGRE_LICENSE,
  },
  {
    name: 'web-tree-sitter (tree-sitter.wasm)',
    dir: 'node_modules/web-tree-sitter',
  },
  {
    name: 'txt2gam',
    license: 'MPL-2.0',
    note: 'Release build of https://github.com/QSPFoundation/txt2gam (txt2gam.js, txt2gam.wasm), '
      + 'licensed under the Mozilla Public License 2.0, the same license as this extension (see LICENSE). '
      + 'Its source is at https://github.com/QSPFoundation/txt2gam.',
  },
];

// The package a bundled file belongs to: the last node_modules segment of
// its path, with a scope if it has one.
function packageDir(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return undefined;
  const name = parts[at + 1]?.startsWith('@') ? parts.slice(at + 1, at + 3) : parts.slice(at + 1, at + 2);
  return join(...parts.slice(0, at + 1), ...name);
}

function licenseText(dir) {
  const file = readdirSync(join(root, dir)).find(f => /^(licen[cs]e|copying)(\..*)?$/i.test(f));
  return file ? readFileSync(join(root, dir, file), 'utf8').trim() : undefined;
}

const dirs = new Set();
for (const entry of ENTRIES) {
  const result = await build({
    ...entry, absWorkingDir: root, bundle: true, write: false, metafile: true, logLevel: 'silent', target: 'es2020',
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const dir = packageDir(input);
    if (dir) dirs.add(dir);
  }
}

const packages = [...dirs].map(dir => {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version, license: pkg.license ?? 'see below', text: licenseText(dir), dir };
});
// A package nested at two versions is listed once per version.
const unique = new Map(packages.map(p => [`${p.name}@${p.version}`, p]));
const sorted = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

let md = '# Third-party notices\n\n'
  + 'QSPeak includes the following third-party software. '
  + 'This file is generated by `scripts/thirdPartyNotices.mjs`; do not edit it by hand.\n\n';
md += '| Package | Version | License |\n|---|---|---|\n';
for (const p of sorted) md += `| ${p.name} | ${p.version} | ${p.license} |\n`;
for (const s of SHIPPED) md += `| ${s.name} | | ${s.license ?? JSON.parse(readFileSync(join(root, s.dir, 'package.json'), 'utf8')).license} |\n`;

for (const p of sorted) {
  md += `\n## ${p.name} ${p.version}\n\n`;
  md += p.text ? `\`\`\`\n${p.text}\n\`\`\`\n` : `Licensed under ${p.license}; the package ships no license file.\n`;
}
for (const s of SHIPPED) {
  md += `\n## ${s.name}\n\n`;
  if (s.note) md += `${s.note}\n`;
  else if (s.text) md += `\`\`\`\n${s.text}\n\`\`\`\n`;
  else {
    const text = licenseText(s.dir);
    md += text ? `\`\`\`\n${text}\n\`\`\`\n` : 'See the package.\n';
  }
}

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== md) {
    console.error('THIRD_PARTY_NOTICES.md is out of date: run `node scripts/thirdPartyNotices.mjs`.');
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${sorted.length} packages).`);
} else {
  writeFileSync(OUT, md);
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${sorted.length} packages).`);
}
