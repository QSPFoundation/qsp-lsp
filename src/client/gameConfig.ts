/**
 * txt2gam.json — per-workspace game configuration file.
 *
 * Stored at <workspace-root>/txt2gam.json. Committed to version control
 * alongside the source files; defines game-specific build settings
 * (output path, file order) as opposed to user/editor preferences
 * which live in VS Code settings.
 *
 * Schema:
 * {
 *   "outputFile": "mygame.qsp",          // relative to workspace root
 *   "files": [                            // optional ordered list of globs
 *     "intro.qsps",
 *     "main/*.qsps",
 *     "locations/**\/*.qsps"
 *   ]
 * }
 *
 * If "files" is absent, all *.qsps / *.qsrc files are collected and
 * sorted alphabetically (existing behaviour).
 * Each glob entry's matches are sorted alphabetically among themselves.
 * A file already matched by an earlier entry is not repeated.
 */

import * as vscode from 'vscode';
import * as logger from './logger';

// ── Types ─────────────────────────────────────────────────────────────

export interface GameConfig {
  /** Output .qsp path, relative to the workspace root. */
  outputFile: string;
  /**
   * Ordered list of glob patterns (relative to workspace root).
   * Absent → collect all QSP source files alphabetically.
   */
  files?: string[];
}

const CONFIG_FILENAME = 'txt2gam.json';

// ── Read ──────────────────────────────────────────────────────────────

/** Return the workspace root URI, or undefined if no folder is open. */
export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Return the URI of txt2gam.json in the workspace root. */
export function configUri(): vscode.Uri | undefined {
  const root = workspaceRoot();
  return root ? vscode.Uri.joinPath(root, CONFIG_FILENAME) : undefined;
}

/**
 * Read and parse txt2gam.json. Returns undefined if the file does not exist.
 * Throws if the file is invalid JSON.
 */
export async function readGameConfig(): Promise<GameConfig | undefined> {
  const uri = configUri();
  if (!uri) return undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const cfg = JSON.parse(Buffer.from(bytes).toString('utf8')) as GameConfig;
    logger.log(`[Config] Read txt2gam.json: outputFile=${cfg.outputFile}, files=${cfg.files ? cfg.files.length + ' entries' : 'unset (alphabetical)'}`);
    return cfg;
  } catch (err: unknown) {
    // FileSystemError.FileNotFound is the expected "file doesn't exist" case.
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return undefined;
    }
    throw new Error(`Failed to read ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Write (create or overwrite) txt2gam.json in the workspace root. */
export async function writeGameConfig(cfg: GameConfig): Promise<void> {
  const uri = configUri();
  if (!uri) throw new Error('No workspace folder open.');
  const json = JSON.stringify(cfg, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
  logger.log(`[Config] Wrote txt2gam.json: outputFile=${cfg.outputFile}`);
}

// ── Setup wizard ──────────────────────────────────────────────────────

/**
 * Interactively create qsp.json if it doesn't exist yet.
 * Prompts for the output file name, then discovers existing QSP source files
 * and writes them as the initial ordered `files` list.
 * Returns the resulting config, or undefined if the user cancelled.
 */
export async function ensureGameConfig(
  qspGlobPattern?: string,
): Promise<GameConfig | undefined> {
  const existing = await readGameConfig();
  if (existing) return existing;

  logger.log('[Config] Creating txt2gam.json...');
  const root = workspaceRoot();
  const defaultName = (root?.path.split('/').pop() ?? 'game') + '.qsp';
  const defaultUri = root
    ? vscode.Uri.joinPath(root, defaultName)
    : vscode.Uri.file(defaultName);

  const saveUri = await vscode.window.showSaveDialog({
    title: 'Choose output .qsp file',
    defaultUri,
    filters: { 'QSP Game': ['qsp'] },
  });
  if (!saveUri) return undefined; // cancelled

  // Store relative to the workspace root if possible, otherwise absolute.
  const rootFsPath = root?.fsPath ?? '';
  const outputFile = rootFsPath && saveUri.fsPath.startsWith(rootFsPath)
    ? saveUri.fsPath.slice(rootFsPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
    : saveUri.fsPath.replace(/\\/g, '/');

  // Auto-populate files list from currently discovered QSP sources,
  // collapsing files in the same directory into directory globs.
  let files: string[] | undefined;
  if (qspGlobPattern && root) {
    const uris = await vscode.workspace.findFiles(qspGlobPattern);
    uris.sort((a, b) => a.toString().localeCompare(b.toString()));
    if (uris.length > 0) {
      const rootFsPath = root.fsPath;
      const relPaths = uris.map(u =>
        u.fsPath.startsWith(rootFsPath)
          ? u.fsPath.slice(rootFsPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
          : u.fsPath.replace(/\\/g, '/'),
      );
      files = buildGlobList(relPaths);
    }
  }

  const cfg: GameConfig = { outputFile, ...(files ? { files } : {}) };
  await writeGameConfig(cfg);

  // Open the file so the user can review and reorder the list.
  const uri = configUri()!;
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });

  return cfg;
}

// ── Glob generation ───────────────────────────────────────────────────

/**
 * Given a sorted list of workspace-relative paths, produce a compact glob list:
 * - Files in the same directory are collapsed to `dir/*.ext` (one glob per dir/ext pair).
 * - Files at the workspace root are kept as individual entries.
 * - Order is preserved: entries appear in the order their first file was seen.
 *
 * Example:
 *   ["intro.qsps", "main/a.qsps", "main/b.qsps", "end.qsps"]
 *   → ["intro.qsps", "main/*.qsps", "end.qsps"]
 */
function buildGlobList(relPaths: string[]): string[] {
  if (relPaths.length === 0) return [];

  // Always keep the first file as an explicit entry so the start location is clear.
  const first = relPaths[0];
  const rest  = relPaths.slice(1);

  if (rest.length === 0) return [first];

  // Group the remaining files by directory + extension, preserving insertion order.
  const groups = new Map<string, { paths: string[]; dir: string; ext: string }>();

  for (const p of rest) {
    const slash = p.lastIndexOf('/');
    const dir   = slash >= 0 ? p.slice(0, slash) : '';
    const file  = slash >= 0 ? p.slice(slash + 1) : p;
    const dot   = file.lastIndexOf('.');
    const ext   = dot >= 0 ? file.slice(dot) : '';
    const key   = dir + '\0' + ext;

    if (!groups.has(key)) groups.set(key, { paths: [], dir, ext });
    groups.get(key)!.paths.push(p);
  }

  const result: string[] = [first];
  for (const { paths, dir, ext } of groups.values()) {
    if (paths.length === 1) {
      result.push(paths[0]);
    } else {
      result.push(dir ? `${dir}/*${ext}` : `*${ext}`);
    }
  }

  return result;
}

// ── File collection ───────────────────────────────────────────────────

/**
 * Collect and order QSP source URIs according to the game config.
 *
 * If cfg.files is present:
 *   - Each glob is resolved relative to the workspace root.
 *   - Matches within each glob are sorted alphabetically.
 *   - Files already seen from an earlier glob are deduplicated.
 *
 * If cfg.files is absent:
 *   - Falls back to collecting all files matching qspGlobPattern,
 *     sorted alphabetically (original behaviour).
 */
export async function collectOrderedUris(
  cfg: GameConfig | undefined,
  qspGlobPattern: string,
): Promise<vscode.Uri[]> {
  if (!cfg?.files || cfg.files.length === 0) {
    // Original behaviour: all QSP files alphabetically.
    logger.log('[Config] No explicit file list — collecting all QSP files alphabetically');
    const uris = await vscode.workspace.findFiles(qspGlobPattern);
    uris.sort((a, b) => a.toString().localeCompare(b.toString()));
    logger.log(`[Config] Collected ${uris.length} file(s) (alphabetical)`);
    return uris;
  }

  const seen = new Set<string>();
  const result: vscode.Uri[] = [];
  logger.log(`[Config] Resolving ${cfg.files.length} file glob(s)...`);

  for (const pattern of cfg.files) {
    const matches = await vscode.workspace.findFiles(pattern);
    matches.sort((a, b) => a.toString().localeCompare(b.toString()));
    for (const uri of matches) {
      const key = uri.toString();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(uri);
      }
    }
  }

  logger.log(`[Config] Collected ${result.length} file(s) from explicit list`);
  return result;
}

/** Resolve the output .qsp URI from the game config. */
export function resolveOutputUri(cfg: GameConfig): vscode.Uri {
  // Support both relative (to workspace root) and absolute paths.
  if (cfg.outputFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cfg.outputFile)) {
    return vscode.Uri.file(cfg.outputFile);
  }
  const root = workspaceRoot();
  if (!root) throw new Error('No workspace folder open.');
  return vscode.Uri.joinPath(root, cfg.outputFile);
}
