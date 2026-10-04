// ── Installed libraries ──────────────────────────────────────────────
//
// The `libraries` section of txt2gam.json: which libraries the game has
// installed and where their sources live. A library is one .qsps file the
// game loads with `inclib` and drops with `freelib`, so the build encodes
// it into a .qsp of its own instead of folding it into the game's. Pure,
// shared by the client's build and panel and the MCP server's build.

/**
 * Where library sources live, relative to the workspace root. Fixed rather
 * than configurable so the build, the Libraries view and the language
 * server (which doesn't read txt2gam.json) always agree on what a library is.
 */
export const LIBRARY_FOLDER = 'libs';

// Library ids become file names, so they are kept to characters every file
// system accepts and can't climb out of the folder (`..`, `/`).
const LIBRARY_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** One installed library as txt2gam.json records it. */
export interface InstalledLibrary {
  id: string;
  /** Catalog version that was installed. */
  version: string;
  /** SHA-256 (hex) of the file as installed; a different hash means it was edited since. */
  sha256: string;
  /** URL of the libraries.json catalog it came from. */
  catalog: string;
}

/** The `libraries` section of txt2gam.json. */
export interface LibrariesConfig {
  installed?: Record<string, Omit<InstalledLibrary, 'id'>>;
}

/** An installed library with the paths the build reads and writes, relative to the workspace root with `/`. */
export interface LibraryFiles extends InstalledLibrary {
  /** The library's .qsps. */
  sourcePath: string;
  /**
   * The .qsp it is built into, relative to the folder of the game's .qsp:
   * `inclib` resolves its path from the game, so this is also what it takes.
   */
  outputPath: string;
}

/** True for an id that is safe to use as a file name. */
export function isValidLibraryId(id: string): boolean {
  return LIBRARY_ID_RE.test(id) && !id.includes('..');
}

/**
 * Installed libraries with their paths, in txt2gam.json order. Throws on
 * an id that isn't a safe file name: the build must not read or write
 * outside the libraries folder because of a hand-edited config.
 */
export function installedLibraries(cfg: LibrariesConfig | undefined): LibraryFiles[] {
  const installed = cfg?.installed && typeof cfg.installed === 'object' ? cfg.installed : {};
  return Object.entries(installed).map(([id, entry]) => {
    if (!isValidLibraryId(id)) {
      throw new Error(`txt2gam.json: "${id}" is not a valid library name (letters, digits, "_", "-", ".")`);
    }
    return {
      id,
      version: String(entry?.version ?? ''),
      sha256: String(entry?.sha256 ?? ''),
      catalog: String(entry?.catalog ?? ''),
      sourcePath: `${LIBRARY_FOLDER}/${id}.qsps`,
      outputPath: `${LIBRARY_FOLDER}/${id}.qsp`,
    };
  });
}

/**
 * Split workspace-relative source paths into the game's and the installed
 * libraries'. Library files are left out of the game whatever the `files`
 * list says, so a `single` build never folds a library into the game that
 * `inclib` then loads a second time. Paths compare case-insensitively, as
 * on Windows and macOS.
 */
export function withoutLibraries<T>(sources: readonly T[], relPath: (s: T) => string, libraries: readonly LibraryFiles[]): T[] {
  const libraryPaths = new Set(libraries.map(l => l.sourcePath.toLowerCase()));
  return sources.filter(s => !libraryPaths.has(relPath(s).replace(/\\/g, '/').toLowerCase()));
}

/** URI prefixes of the libraries folder in each workspace folder, for `libraryIdOfUri`. */
export function libraryFolderPrefixes(workspaceFolderUris: readonly string[]): string[] {
  return workspaceFolderUris.map(u => `${u.replace(/\/+$/, '')}/${LIBRARY_FOLDER}/`.toLowerCase());
}

/**
 * The library a document is, by its place: `<workspace>/libs/<id>.qsps`
 * gives `id`; anything else, undefined. Every .qsps right in `libs/`
 * counts, installed or not: the language server doesn't read txt2gam.json.
 */
export function libraryIdOfUri(uri: string, prefixes: readonly string[]): string | undefined {
  const lower = uri.toLowerCase();
  for (const prefix of prefixes) {
    if (!lower.startsWith(prefix)) continue;
    const match = /^([^/]+)\.qsps$/i.exec(uri.slice(prefix.length));
    if (!match) continue;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Lines of the game that load `lib` (`inclib`, or the old `addqst`/`addlib`, naming
 * its .qsp), 1-based, so removing a library can say where the game still
 * needs it. A path built at run time can't be seen here.
 */
export function findLibraryUses(
  sources: ReadonlyArray<{ relPath: string; text: string }>,
  lib: Pick<LibraryFiles, 'id'>,
): Array<{ relPath: string; line: number }> {
  const file = `${lib.id}.qsp`.toLowerCase();
  const uses: Array<{ relPath: string; line: number }> = [];
  for (const { relPath, text } of sources) {
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      const lower = line.toLowerCase();
      if (/\b(inclib|addqst|addlib)\b/.test(lower) && lower.includes(file)) uses.push({ relPath, line: i + 1 });
    });
  }
  return uses;
}
