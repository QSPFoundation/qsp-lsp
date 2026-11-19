// ── Libraries: install, update, remove ───────────────────────────────
//
// Fetches the catalogs named in `qsp.libraries.sources` (a libraries.json,
// or a GitHub repository whose latest release is the catalog), and installs
// a library into libs/<id>.qsps with its entry in txt2gam.json. Nothing is
// written until every file has downloaded, matched its checksum and been
// checked against the game for same-named locations, so a failed install
// leaves the game as it was. Uses fetch and vscode.workspace.fs only, so it
// works on the desktop and in vscode.dev alike, except for files of GitHub
// releases, which GitHub doesn't let a web page download.

import * as vscode from 'vscode';
import {
  installOrder,
  mergeCatalogs,
  parseCatalog,
  type CatalogLibrary,
  type ParsedCatalog,
} from '../common/libraryCatalog';
import {
  findLibraryUses,
  installedLibraries,
  withoutLibraries,
  LIBRARY_FOLDER,
  type LibraryFiles,
} from '../common/libraryConfig';
import { buildLibraryTree, type InstalledState, type LibraryTreeNode } from '../common/libraryTree';
import { findLocationConflicts, locationConflictMessage } from '../common/locationConflicts';
import { normalizeText } from '../common/projectFiles';
import { sha256Hex } from '../common/sha256';
import { catalogAsset, catalogFromRelease, latestReleaseApiUrl, parseGitHubRepo, readRelease, type GitHubRepo } from '../common/githubReleases';
import { currentGameFolderUri, readFileAsText } from './exportCommands';
import { orderedProjectUris, readGameConfig, workspaceRoot, writeGameConfig, type GameConfig } from './gameConfig';
import * as logger from './logger';
import { parseTextBytes } from './txt2gam';

const DOWNLOAD_TIMEOUT_MS = 30_000;

async function download(url: string, headers?: Record<string, string>): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error(httpProblem(response));
    return new Uint8Array(await response.arrayBuffer());
  } catch (err) {
    const reason = controller.signal.aborted ? 'no answer in 30 s' : err instanceof Error ? err.message : String(err);
    throw new Error(`Could not download ${url}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function httpProblem(response: Response): string {
  const status = `HTTP ${response.status} ${response.statusText}`.trim();
  // GitHub's API answers 60 requests an hour without signing in.
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const when = Number.isFinite(reset) && reset > 0 ? ` after ${new Date(reset * 1000).toLocaleTimeString()}` : ' later';
    return `${status}: GitHub's limit of requests is used up; try again${when}, or sign in to GitHub in VS Code (Accounts menu) for a higher limit`;
  }
  return status;
}

async function downloadJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const bytes = await download(url, headers);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(`${url} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Headers for GitHub's API, with the GitHub session VS Code already has, if
// any: never asks to sign in, but a session raises the limit of requests and
// reaches private repositories.
async function gitHubApiHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    const session = await vscode.authentication.getSession('github', [], { silent: true });
    if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  } catch {
    // No GitHub authentication provider here: go without.
  }
  return headers;
}

async function fetchGitHubCatalog(repo: GitHubRepo, source: string): Promise<ParsedCatalog> {
  let json: unknown;
  try {
    json = await downloadJson(latestReleaseApiUrl(repo), await gitHubApiHeaders());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.includes('HTTP 404')
      ? `${repo.owner}/${repo.repo}: no release found (only a published release that isn't a pre-release counts), or no such repository`
      : message);
  }
  const release = readRelease(json);
  if (!release) throw new Error(`${repo.owner}/${repo.repo}: GitHub's answer about the latest release can't be read`);
  const asset = catalogAsset(release);
  return catalogFromRelease(release, source, asset ? await downloadJson(asset.url) : undefined);
}

async function readBytes(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

/** Catalog entries as the LibraryFiles they become once installed. */
function asInstalled(libs: readonly CatalogLibrary[]): LibraryFiles[] {
  return installedLibraries({
    installed: Object.fromEntries(libs.map(l => [l.id, { version: l.version, sha256: l.sha256, catalog: l.catalog }])),
  });
}

/** The catalogs, the game's installed libraries, and the actions on them. */
export class LibraryManager {
  private catalog: ParsedCatalog | undefined;
  private catalogError: string | undefined;
  private loading: Promise<void> | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the view should be rebuilt. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly qspGlob: string,
  ) {}

  dispose(): void {
    this.changed.dispose();
  }

  /** Catalog URLs from the settings, in order. */
  sources(): string[] {
    const value = vscode.workspace.getConfiguration('qsp.libraries').get<unknown>('sources', []);
    return Array.isArray(value)
      ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim())
      : [];
  }

  /** Fetch the catalogs again, then rebuild the view. */
  reloadCatalogs(): Promise<void> {
    this.loading = this.fetchCatalogs().finally(() => { this.loading = undefined; this.changed.fire(); });
    return this.loading;
  }

  /** Rebuild the view from what is on disk, keeping the catalogs. */
  refresh(): void {
    this.changed.fire();
  }

  private async fetchCatalogs(): Promise<void> {
    const sources = this.sources();
    const parsed: ParsedCatalog[] = [];
    const failures: string[] = [];
    for (const url of sources) {
      try {
        const repo = parseGitHubRepo(url);
        parsed.push(repo ? await fetchGitHubCatalog(repo, url) : parseCatalog(await downloadJson(url), url));
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    const merged = mergeCatalogs(parsed);
    for (const problem of merged.problems) logger.log(`[Libraries] ${problem}`);
    for (const failure of failures) logger.log(`[Libraries] ${failure}`);
    // A catalog that answers keeps the view useful; only when none does is it an error.
    this.catalog = { libraries: merged.libraries, problems: [...failures, ...merged.problems] };
    this.catalogError = sources.length > 0 && parsed.length === 0 ? failures.join('; ') : undefined;
  }

  private async ensureCatalogs(): Promise<ParsedCatalog> {
    if (this.loading) await this.loading;
    if (!this.catalog && this.sources().length > 0) await this.reloadCatalogs();
    if (this.catalogError) throw new Error(this.catalogError);
    return this.catalog ?? { libraries: [], problems: [] };
  }

  private async installedStates(cfg: GameConfig | undefined): Promise<InstalledState[]> {
    const root = workspaceRoot();
    if (!root) return [];
    const states: InstalledState[] = [];
    for (const lib of installedLibraries(cfg?.libraries)) {
      const bytes = await readBytes(vscode.Uri.joinPath(root, lib.sourcePath));
      states.push({ lib, fileHash: bytes ? sha256Hex(bytes) : undefined });
    }
    return states;
  }

  /** The view's nodes. Loads the catalogs the first time. */
  async tree(): Promise<LibraryTreeNode[]> {
    if (!this.catalog && !this.loading && this.sources().length > 0) void this.reloadCatalogs();
    let installed: InstalledState[] = [];
    let configError: string | undefined;
    try {
      installed = await this.installedStates(await readGameConfig());
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }
    const nodes = buildLibraryTree({
      installed,
      catalog: this.catalog,
      catalogError: this.catalogError,
      sourcesConfigured: this.sources().length > 0,
      language: vscode.env.language,
    });
    if (this.loading) nodes.push({ kind: 'message', severity: 'info', text: 'Loading the library catalogs…' });
    if (configError) nodes.unshift({ kind: 'message', severity: 'error', text: configError });
    return nodes;
  }

  /** Libraries the catalogs offer that the game doesn't have, for a picker. */
  async available(): Promise<CatalogLibrary[]> {
    const catalog = await this.ensureCatalogs();
    const installed = new Set(installedLibraries((await readGameConfig())?.libraries).map(l => l.id.toLowerCase()));
    return catalog.libraries.filter(l => !installed.has(l.id.toLowerCase()));
  }

  /**
   * Install `id` with whatever it requires, or update it. Returns the
   * catalog entry of `id`, or undefined when the author cancelled.
   */
  async install(id: string, { update = false } = {}): Promise<CatalogLibrary | undefined> {
    const root = workspaceRoot();
    if (!root) throw new Error('Open the game folder first.');
    const catalog = await this.ensureCatalogs();
    const cfg: GameConfig = (await readGameConfig()) ?? {};
    const installed = installedLibraries(cfg.libraries);

    if (update) {
      const current = installed.find(l => l.id.toLowerCase() === id.toLowerCase());
      const bytes = current && await readBytes(vscode.Uri.joinPath(root, current.sourcePath));
      if (current && bytes && current.sha256 && sha256Hex(bytes) !== current.sha256.toLowerCase()) {
        const replace = 'Replace My Changes';
        const answer = await vscode.window.showWarningMessage(
          `${current.sourcePath} was changed since it was installed. Updating replaces those changes.`,
          { modal: true }, replace);
        if (answer !== replace) return undefined;
      }
    }

    const order = installOrder(id, catalog.libraries, new Set(installed.map(l => l.id)));
    const downloads: Array<{ lib: CatalogLibrary; bytes: Uint8Array; text: string }> = [];
    for (const lib of order) {
      const bytes = await download(lib.url);
      const hash = sha256Hex(bytes);
      if (hash !== lib.sha256) {
        throw new Error(`The download of "${lib.id}" doesn't match its catalog's checksum `
          + `(expected ${lib.sha256.slice(0, 12)}…, got ${hash.slice(0, 12)}…). Nothing was installed.`);
      }
      const text = await parseTextBytes(this.context.extensionUri, bytes, true);
      if (text === null) throw new Error(`The file of "${lib.id}" is not QSP text. Nothing was installed.`);
      downloads.push({ lib, bytes, text });
    }

    // Same check as the build, before anything is written: the game, the
    // libraries it keeps, and the ones coming in.
    const incoming = asInstalled(order);
    const replaced = new Set(incoming.map(l => l.id.toLowerCase()));
    const kept = installed.filter(l => !replaced.has(l.id.toLowerCase()));
    const sources: Array<{ relPath: string; text: string }> = [];
    const gameUris = withoutLibraries(
      await orderedProjectUris(cfg, this.qspGlob), u => vscode.workspace.asRelativePath(u, false), [...kept, ...incoming]);
    for (const uri of gameUris) {
      sources.push({ relPath: vscode.workspace.asRelativePath(uri, false), text: normalizeText(await readFileAsText(uri, this.context)) });
    }
    for (const lib of kept) {
      const uri = vscode.Uri.joinPath(root, lib.sourcePath);
      const bytes = await readBytes(uri);
      if (bytes) sources.push({ relPath: lib.sourcePath, text: normalizeText(await readFileAsText(uri, this.context)) });
    }
    downloads.forEach((d, i) => sources.push({ relPath: incoming[i].sourcePath, text: normalizeText(d.text) }));
    const conflicts = locationConflictMessage(findLocationConflicts(sources));
    if (conflicts) throw new Error(`Nothing was installed. ${conflicts}`);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, LIBRARY_FOLDER));
    for (const [i, { bytes }] of downloads.entries()) {
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, incoming[i].sourcePath), bytes);
    }
    const entries = { ...(cfg.libraries?.installed ?? {}) };
    for (const { lib } of downloads) {
      // An id typed in another case replaces the old entry instead of sitting next to it.
      for (const key of Object.keys(entries)) if (key.toLowerCase() === lib.id.toLowerCase()) delete entries[key];
      entries[lib.id] = { version: lib.version, sha256: lib.sha256, catalog: lib.catalog };
    }
    await writeGameConfig({ ...cfg, libraries: { ...cfg.libraries, installed: entries } });
    logger.log(`[Libraries] ${update ? 'Updated' : 'Installed'}: ${downloads.map(d => `${d.lib.id} ${d.lib.version}`).join(', ')}`);
    this.changed.fire();
    return downloads[downloads.length - 1].lib;
  }

  /** Remove `id`'s files and entry. Returns false when the author cancelled. */
  async remove(id: string): Promise<boolean> {
    const root = workspaceRoot();
    if (!root) throw new Error('Open the game folder first.');
    const cfg = await readGameConfig();
    const installed = installedLibraries(cfg?.libraries);
    const lib = installed.find(l => l.id.toLowerCase() === id.toLowerCase());
    if (!cfg || !lib) return false;

    const dependents = (this.catalog?.libraries ?? [])
      .filter(c => c.requires.some(r => r.toLowerCase() === id.toLowerCase())
        && installed.some(l => l.id.toLowerCase() === c.id.toLowerCase()))
      .map(c => c.id);
    const remove = 'Remove';
    const built = vscode.Uri.joinPath(await currentGameFolderUri(cfg, this.qspGlob), lib.outputPath);
    const answer = await vscode.window.showWarningMessage(
      `Remove the library "${lib.id}"? ${lib.sourcePath} and ${vscode.workspace.asRelativePath(built)} go to the trash.`
        + (dependents.length > 0 ? ` ${dependents.join(', ')} need${dependents.length === 1 ? 's' : ''} it.` : ''),
      { modal: true }, remove);
    if (answer !== remove) return false;

    for (const uri of [vscode.Uri.joinPath(root, lib.sourcePath), built]) {
      if (!(await readBytes(uri))) continue;
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        // No trash on some file systems (vscode.dev); the author already confirmed.
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      }
    }
    const entries = { ...(cfg.libraries?.installed ?? {}) };
    delete entries[lib.id];
    const rest: GameConfig = { ...cfg };
    delete rest.libraries;
    await writeGameConfig(Object.keys(entries).length > 0 ? { ...rest, libraries: { ...cfg.libraries, installed: entries } } : rest);
    logger.log(`[Libraries] Removed: ${lib.id}`);
    this.changed.fire();

    const uses: Array<{ relPath: string; line: number }> = [];
    for (const uri of await orderedProjectUris(cfg, this.qspGlob)) {
      const relPath = vscode.workspace.asRelativePath(uri, false);
      uses.push(...findLibraryUses([{ relPath, text: await readFileAsText(uri, this.context) }], lib));
    }
    if (uses.length > 0) {
      void vscode.window.showWarningMessage(
        `The game still loads "${lib.id}": ${uses.slice(0, 5).map(u => `${u.relPath}:${u.line}`).join(', ')}`
          + (uses.length > 5 ? ` and ${uses.length - 5} more` : ''));
    }
    return true;
  }
}
