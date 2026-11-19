// ── Files left out of the project ────────────────────────────────────
//
// What the project (analysis, build, Locations view, MCP) never reads: the
// folders always skipped (`.git`, `node_modules`, any folder starting with a
// dot, …), and what the game's author lists, either in a `.qspignore` file
// at the root of the workspace folder or in the `qsp.project.exclude`
// setting. The two are separate ways, not combined: a folder with a
// `.qspignore` follows it alone, so everyone who opens the repository leaves
// out the same files. Pure, browser-safe (picomatch/posix has no Node
// imports): shared by the server, the client and the MCP server.

import picomatch from 'picomatch/posix';

/** The file of patterns, at the root of a workspace folder. */
export const IGNORE_FILE_NAME = '.qspignore';

// Folders no QSP project keeps its sources in: tools' and build output.
const ALWAYS_SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'vendor', '.venv']);

/** True for a folder name the project never looks into, whatever the patterns say. */
export function isAlwaysSkippedDir(name: string): boolean {
  return ALWAYS_SKIPPED_DIRS.has(name) || name.startsWith('.');
}

/** The patterns of a `.qspignore`: one per line, `#` starts a comment line. */
export function parseIgnoreFile(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));
}

// As in .gitignore: a pattern with no `/` but a trailing one (`_export`,
// `*.bak.qsps`, `drafts/`) is a name at any depth; any other is a path from
// the workspace folder (`src/old/*.qsps`, `/_export`, `**/_export/**`).
// Either way it takes everything inside what it names.
function toGlobs(pattern: string): string[] {
  let p = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (p === '') return [];
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  const base = anchored ? p : `**/${p}`;
  return [base, `${base}/**`];
}

/** Which patterns rule a workspace folder, and where they came from (for the log). */
export interface ExcludeRules {
  patterns: string[];
  source: 'ignoreFile' | 'setting' | 'none';
}

/**
 * The rules of a workspace folder: its `.qspignore` when it has one
 * (`ignoreFileText` defined, even empty), else the setting.
 */
export function excludeRules(ignoreFileText: string | undefined, setting: readonly unknown[] | undefined): ExcludeRules {
  if (ignoreFileText !== undefined) return { patterns: parseIgnoreFile(ignoreFileText), source: 'ignoreFile' };
  const patterns = (setting ?? []).filter((p): p is string => typeof p === 'string' && p.trim() !== '').map(p => p.trim());
  return { patterns, source: patterns.length > 0 ? 'setting' : 'none' };
}

/**
 * Whether a path relative to the workspace folder (with `/`) is left out of
 * the project. Names compare case-insensitively, as on Windows, where most
 * QSP games are written.
 */
export interface ExcludeMatcher {
  /** A file: in a skipped folder, or named by a pattern. */
  file(relPath: string): boolean;
  /** A folder: none of its files can be in the project, so a walk needn't enter it. */
  dir(relPath: string): boolean;
}

const normalize = (relPath: string) => relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** The matcher for `rules`, the always-skipped folders included. */
export function excludeMatcher(rules: ExcludeRules): ExcludeMatcher {
  const globs = rules.patterns.flatMap(toGlobs);
  const listed = globs.length > 0 ? picomatch(globs, { dot: true, nocase: true }) : () => false;
  return {
    file: relPath => {
      const rel = normalize(relPath);
      return rel.split('/').slice(0, -1).some(isAlwaysSkippedDir) || listed(rel);
    },
    dir: relPath => {
      const rel = normalize(relPath);
      return rel !== '' && (rel.split('/').some(isAlwaysSkippedDir) || listed(rel));
    },
  };
}
