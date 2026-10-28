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
 *   "outputFile": "mygame.qsp",          // relative to workspace root; default <folder>.qsp
 *   "files": [                            // optional ordered list of globs
 *     "intro.qsps",
 *     "main/*.qsps",
 *     "locations/**\/*.qsps"
 *   ],
 *   "buildMode": "perFile",               // optional: "single" | "perFile"
 *   "mainFile": "^main\\.qsps$",           // optional regexp for the main file
 *   "playerExecutable": "tools/qspgui",   // optional; or { "win32": …, "linux": …, "darwin": … }
 *   "players": [                          // optional, in place of playerExecutable
 *     { "name": "qspgui", "executable": "tools/qspgui" },
 *     { "name": "qSpider", "executable": { … }, "args": ["--file", "${game}"] }
 *   ]
 * }
 *
 * If "files" is absent, Run and Export write the discovered sources into
 * it (main file first); until then all *.qsps / *.qsrc files are collected
 * and sorted alphabetically.
 * Each glob entry's matches are sorted alphabetically among themselves.
 * A file already matched by an earlier entry is not repeated.
 *
 * "buildMode" overrides the `qsp.game.buildMode` setting for this project.
 * In "perFile" mode each source becomes its own .qsp next to it and
 * "outputFile" is not used; the main file is the one the player starts.
 *
 * "mainFile" is a regular expression searched (case-insensitively) in each
 * source's workspace-relative path; the first match in build order is the
 * main file and is moved to the front, so in "single" mode its first
 * location starts the game. It overrides the `qsp.game.mainFile` setting.
 * With neither set, the main file is simply the first one in order.
 *
 * "playerExecutable" is the player Run QSP Game launches, overriding the
 * `qsp.game.playerExecutable` setting. A path with a separator is relative
 * to the workspace root, a bare name is looked up on PATH. The object form
 * holds one path per OS, since the file is shared between machines.
 *
 * "players" lists several players instead, the default one first: each
 * with a name, an executable as "playerExecutable" has it, and arguments
 * (`${game}` is the built .qsp; the game alone when there are none). Run
 * QSP Game opens the first; Run QSP Game in… and a launch configuration's
 * "player" pick another by name.
 */

import * as vscode from 'vscode';
import {
  exactPathPattern,
  findMainFile,
  moveToFront,
  orderForEntryPoint,
  resolveBuildMode,
  resolveMainFilePattern,
  resolveMainFileStrategy,
  type BuildMode,
} from '../common/buildPlan';
import type { LibrariesConfig } from '../common/libraryConfig';
import * as logger from './logger';

// ── Types ─────────────────────────────────────────────────────────────

export interface GameConfig {
  /**
   * Output .qsp path for `single` builds, relative to the workspace root.
   * Absent → `<workspace folder name>.qsp`. Not used by `perFile` builds.
   */
  outputFile?: string;
  /**
   * Ordered list of glob patterns (relative to workspace root).
   * Absent → collect all QSP source files alphabetically.
   */
  files?: string[];
  /** Overrides the `qsp.game.buildMode` setting for this project. */
  buildMode?: BuildMode;
  /** Regexp for the main file; overrides the `qsp.game.mainFile` setting. */
  mainFile?: string;
  /**
   * Player for Run QSP Game: one path, or one per `process.platform`.
   * Overrides the `qsp.game.playerExecutable` setting.
   */
  playerExecutable?: string | Partial<Record<'win32' | 'darwin' | 'linux', string>>;
  /** Players for Run QSP Game, the default first; when present, `playerExecutable` isn't read. */
  players?: Array<{
    name?: string;
    executable: string | Partial<Record<'win32' | 'darwin' | 'linux', string>>;
    /** `${game}` stands for the built .qsp; `["${game}"]` when absent. */
    args?: string[];
  }>;
  /** Installed libraries, each built into a .qsp of its own (see libraryConfig.ts). */
  libraries?: LibrariesConfig;
}

/** Main-file regexp for this project: txt2gam.json, then the `qsp.game.mainFile` setting. */
export function effectiveMainFilePattern(cfg: GameConfig | undefined): string | undefined {
  return resolveMainFilePattern(
    cfg?.mainFile,
    vscode.workspace.getConfiguration('qsp.game').get<string>('mainFile'),
  );
}

/** Build mode for this project: txt2gam.json, then the `qsp.game.buildMode` setting, then `single`. */
export function effectiveBuildMode(cfg: GameConfig | undefined): BuildMode {
  return resolveBuildMode(
    cfg?.buildMode,
    vscode.workspace.getConfiguration('qsp.game').get<string>('buildMode'),
  );
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
  logger.log(`[Config] Wrote txt2gam.json: ${cfg.buildMode === 'perFile' ? 'buildMode=perFile' : `outputFile=${cfg.outputFile}`}`);
}

// ── Setup wizard ──────────────────────────────────────────────────────

/**
 * Interactively create txt2gam.json if it doesn't exist yet.
 * Prompts for the output file name, then discovers existing QSP source files
 * and writes them as the initial ordered `files` list. An existing config
 * without `files` gets the list added the same way, so the build order is
 * written down instead of silently following the alphabet.
 * Returns the resulting config, or undefined if the user cancelled.
 */
export async function ensureGameConfig(
  qspGlobPattern?: string,
): Promise<GameConfig | undefined> {
  const existing = await readGameConfig();
  if (existing) {
    if (existing.files !== undefined) return existing;
    const discovered = await discoverFileList(qspGlobPattern, existing);
    if (!discovered.files) return existing;
    const cfg: GameConfig = {
      ...existing,
      files: discovered.files,
      ...(discovered.mainFile ? { mainFile: discovered.mainFile } : {}),
    };
    await writeGameConfig(cfg);
    logger.log(`[Config] Added files list to txt2gam.json (${discovered.files.length} entries)`);
    await revealConfig();
    return cfg;
  }

  logger.log('[Config] Creating txt2gam.json...');
  const root = workspaceRoot();
  const defaultName = (root?.path.split('/').pop() ?? 'game') + '.qsp';

  const mode = effectiveBuildMode(undefined);
  let outputFile: string | undefined;
  // perFile builds write next to each source, so there is no output file to choose.
  if (mode === 'single') {
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
    outputFile = rootFsPath && saveUri.fsPath.startsWith(rootFsPath)
      ? saveUri.fsPath.slice(rootFsPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
      : saveUri.fsPath.replace(/\\/g, '/');
  }

  const { files, mainFile } = await discoverFileList(qspGlobPattern, undefined);

  const cfg: GameConfig = {
    ...(mode === 'perFile' ? { buildMode: 'perFile' as const } : { outputFile }),
    ...(files ? { files } : {}),
    ...(mainFile ? { mainFile } : {}),
  };
  await writeGameConfig(cfg);
  await revealConfig();
  return cfg;
}

// Open the config so the user can review and reorder the list.
async function revealConfig(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(configUri()!);
  await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
}

/**
 * Discover the workspace's QSP sources and turn them into a `files` glob
 * list with the main file first. `mainFile` is returned only when the
 * wizard chose it; a pattern already in `cfg` or the settings stays in
 * charge at build time and only orders the list here.
 */
async function discoverFileList(
  qspGlobPattern: string | undefined,
  cfg: GameConfig | undefined,
): Promise<{ files?: string[]; mainFile?: string }> {
  const root = workspaceRoot();
  if (!qspGlobPattern || !root) return {};
  const uris = await vscode.workspace.findFiles(qspGlobPattern);
  if (uris.length === 0) return {};
  uris.sort((a, b) => a.toString().localeCompare(b.toString()));

  const rootFsPath = root.fsPath;
  let relPaths = uris.map(u =>
    u.fsPath.startsWith(rootFsPath)
      ? u.fsPath.slice(rootFsPath.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
      : u.fsPath.replace(/\\/g, '/'),
  );
  let mainFile: string | undefined;
  // The first file is the main one: its first location starts the game
  // (single) or it is the .qsp the player opens (perFile). An
  // alphabetical guess (data/… before main…) is not good enough.
  if (relPaths.length > 1) {
    const pattern = effectiveMainFilePattern(cfg);
    if (pattern !== undefined) {
      try {
        relPaths = moveToFront(relPaths, findMainFile(relPaths, pattern).index);
      } catch {
        // A bad pattern is reported by the build itself.
      }
    } else {
      const strategy = resolveMainFileStrategy(
        vscode.workspace.getConfiguration('qsp.game').get<string>('mainFileStrategy'),
      );
      const entry = strategy === 'ask'
        ? await vscode.window.showQuickPick(relPaths, {
          title: 'Choose the main file (the game starts from it)',
          placeHolder: 'Dismiss to put files from the workspace root first',
        })
        : undefined;
      relPaths = orderForEntryPoint(relPaths, entry);
      // Saved even when root-first order chose it, so txt2gam.json says
      // which file is the main one instead of leaving it implicit.
      mainFile = exactPathPattern(relPaths[0]);
    }
  }
  return { files: buildGlobList(relPaths), mainFile };
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

/**
 * The project's source files in build order with the main file first:
 * `collectOrderedUris`, then the `mainFile` pattern (txt2gam.json or the
 * setting) moved to the front. The first file's first location is where
 * the game starts. Throws when a configured pattern is invalid or matches
 * nothing, as the build does.
 */
export async function orderedProjectUris(
  cfg: GameConfig | undefined,
  qspGlobPattern: string,
): Promise<vscode.Uri[]> {
  const uris = await collectOrderedUris(cfg, qspGlobPattern);
  const mainPattern = effectiveMainFilePattern(cfg);
  if (mainPattern === undefined || uris.length === 0) return uris;
  const relPaths = uris.map(u => vscode.workspace.asRelativePath(u, false).replace(/\\/g, '/'));
  const { index, matchCount } = findMainFile(relPaths, mainPattern);
  if (matchCount > 1) {
    logger.log(`[Config] mainFile "${mainPattern}" matches ${matchCount} files; using the first: ${relPaths[index]}`);
  }
  return moveToFront(uris, index);
}

/**
 * URI of the file the game starts from (its first location is the start
 * location), ordered as the build orders it. Undefined when there are no
 * sources, or when txt2gam.json or the mainFile pattern is broken: views
 * then just leave the start unmarked, and the build reports the problem.
 */
export async function projectStartFileUri(qspGlobPattern: string): Promise<string | undefined> {
  try {
    const uris = await orderedProjectUris(await readGameConfig(), qspGlobPattern);
    return uris[0]?.toString();
  } catch {
    return undefined;
  }
}

/** Resolve the output .qsp URI for a `single` build from the game config. */
export function resolveOutputUri(cfg: GameConfig): vscode.Uri {
  const root = workspaceRoot();
  const outputFile = cfg.outputFile ?? (root?.path.split('/').pop() ?? 'game') + '.qsp';
  // Support both relative (to workspace root) and absolute paths.
  if (outputFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(outputFile)) {
    return vscode.Uri.file(outputFile);
  }
  if (!root) throw new Error('No workspace folder open.');
  return vscode.Uri.joinPath(root, outputFile);
}
