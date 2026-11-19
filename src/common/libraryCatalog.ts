// ── Library catalogs ─────────────────────────────────────────────────
//
// A catalog is a libraries.json file, usually at the root of a GitHub
// repository, listing the libraries it offers. Library files are given
// relative to the catalog's URL, with a SHA-256 so a broken download or a
// changed file is caught before it reaches the game. Pure: the client
// fetches, this checks and decides.

import { isValidLibraryId, LIBRARY_FOLDER } from './libraryConfig';

/** The catalog format this extension reads. A newer one is refused rather than half-read. */
export const CATALOG_SCHEMA = 1;

const SHA256_RE = /^[0-9a-f]{64}$/i;

/** One library offered by a catalog, its file URL resolved. */
export interface CatalogLibrary {
  id: string;
  name: string;
  /** Text per language code (`en`, `ru`, …); a plain string counts as `en`. */
  description: Record<string, string>;
  version: string;
  /** Absolute URL of the .qsps. */
  url: string;
  sha256: string;
  /** Lines the author adds to the game to use the library, e.g. its `inclib`. */
  usage: string;
  /** Ids of the libraries it needs, installed along with it. */
  requires: string[];
  /** URL of the catalog it came from. */
  catalog: string;
}

/** A parsed catalog: what could be read, and why the rest couldn't. */
export interface ParsedCatalog {
  libraries: CatalogLibrary[];
  problems: string[];
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asDescription(value: unknown): Record<string, string> {
  if (typeof value === 'string') return { en: value };
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [lang, text] of Object.entries(value)) {
    if (typeof text === 'string') result[lang.toLowerCase()] = text;
  }
  return result;
}

/**
 * What a catalog that comes with a GitHub release leaves out: the release's
 * tag stands for `version`, and GitHub's checksum of each file for `sha256`.
 */
export interface CatalogDefaults {
  version?: string;
  /** The SHA-256 of a file, by its resolved URL. */
  sha256Of?: (url: string) => string | undefined;
  /** What the libraries record as their catalog, instead of the catalog's own URL. */
  source?: string;
}

/**
 * Read a catalog. Entries that can't be used are left out, each with a
 * problem saying why; the rest stay usable. `catalogUrl` resolves the
 * relative `file` paths.
 */
export function parseCatalog(json: unknown, catalogUrl: string, defaults: CatalogDefaults = {}): ParsedCatalog {
  const problems: string[] = [];
  if (!json || typeof json !== 'object') {
    return { libraries: [], problems: [`${catalogUrl}: not a libraries.json catalog`] };
  }
  const root = json as { schema?: unknown; libraries?: unknown };
  if (typeof root.schema === 'number' && root.schema > CATALOG_SCHEMA) {
    return {
      libraries: [],
      problems: [`${catalogUrl}: catalog format ${root.schema} needs a newer QSP extension (this one reads ${CATALOG_SCHEMA})`],
    };
  }
  if (!Array.isArray(root.libraries)) {
    return { libraries: [], problems: [`${catalogUrl}: no "libraries" list`] };
  }

  const libraries: CatalogLibrary[] = [];
  const seen = new Set<string>();
  root.libraries.forEach((raw: unknown, index) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = asText(entry.id);
    const where = `${catalogUrl}: library ${id ? `"${id}"` : `#${index + 1}`}`;
    if (!id || !isValidLibraryId(id)) { problems.push(`${where}: "id" must be letters, digits, "_", "-" or "."`); return; }
    if (seen.has(id.toLowerCase())) { problems.push(`${where}: listed twice; the first one is used`); return; }
    const version = asText(entry.version) ?? defaults.version;
    if (!version) { problems.push(`${where}: no "version"`); return; }
    const file = asText(entry.file);
    if (!file || !/\.qsps$/i.test(file)) { problems.push(`${where}: "file" must name a .qsps file`); return; }
    let url: string;
    try {
      url = new URL(file, catalogUrl).href;
    } catch {
      problems.push(`${where}: "file" is not a valid path or URL`);
      return;
    }
    const sha256 = asText(entry.sha256) ?? defaults.sha256Of?.(url);
    if (!sha256 || !SHA256_RE.test(sha256)) {
      problems.push(defaults.sha256Of && !entry.sha256
        ? `${where}: "${file}" is not a file of the release, so it has no checksum; attach it or give "sha256"`
        : `${where}: "sha256" must be 64 hex digits`);
      return;
    }
    const requires = Array.isArray(entry.requires)
      ? entry.requires.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map(r => r.trim())
      : [];
    seen.add(id.toLowerCase());
    libraries.push({
      id,
      name: asText(entry.name) ?? id,
      description: asDescription(entry.description),
      version,
      url,
      sha256: sha256.toLowerCase(),
      usage: typeof entry.usage === 'string' ? entry.usage : `inclib '${LIBRARY_FOLDER}/${id}.qsp'`,
      requires,
      catalog: defaults.source ?? catalogUrl,
    });
  });
  return { libraries, problems };
}

/**
 * Libraries of several catalogs, in settings order. An id offered by two
 * catalogs comes from the first, with a problem naming the other.
 */
export function mergeCatalogs(catalogs: readonly ParsedCatalog[]): ParsedCatalog {
  const byId = new Map<string, CatalogLibrary>();
  const problems: string[] = [];
  for (const catalog of catalogs) {
    problems.push(...catalog.problems);
    for (const lib of catalog.libraries) {
      const key = lib.id.toLowerCase();
      const first = byId.get(key);
      if (first) {
        problems.push(`${lib.catalog}: library "${lib.id}" is also in ${first.catalog}; that one is used`);
        continue;
      }
      byId.set(key, lib);
    }
  }
  return { libraries: [...byId.values()], problems };
}

/**
 * The description in the editor's language (`ru-RU` → `ru`), else English,
 * else whatever there is.
 */
export function localizedDescription(description: Record<string, string>, language: string): string {
  const lang = language.toLowerCase();
  return description[lang] ?? description[lang.split('-')[0]] ?? description.en ?? Object.values(description)[0] ?? '';
}

/**
 * Compare versions such as `1.2.0` and `1.10`: numeric parts as numbers,
 * missing parts as 0, anything else as text. Negative when `a` is older.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const diff = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * What to install for `id`: its missing requirements first (depth first),
 * then the library itself; already installed ones are skipped. Throws when
 * a requirement is in no catalog or the requirements loop.
 */
export function installOrder(
  id: string,
  libraries: readonly CatalogLibrary[],
  installedIds: ReadonlySet<string>,
): CatalogLibrary[] {
  const byId = new Map(libraries.map(l => [l.id.toLowerCase(), l]));
  const installed = new Set([...installedIds].map(i => i.toLowerCase()));
  const order: CatalogLibrary[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];

  const visit = (wanted: string, neededBy?: string): void => {
    const key = wanted.toLowerCase();
    if (done.has(key)) return;
    if (visiting.includes(key)) {
      throw new Error(`Libraries require each other in a loop: ${[...visiting, key].join(' → ')}`);
    }
    const lib = byId.get(key);
    if (!lib) {
      throw new Error(neededBy
        ? `Library "${neededBy}" needs "${wanted}", which no catalog offers`
        : `No catalog offers the library "${wanted}"`);
    }
    visiting.push(key);
    for (const req of lib.requires) {
      if (!installed.has(req.toLowerCase())) visit(req, lib.id);
    }
    visiting.pop();
    done.add(key);
    order.push(lib);
  };

  visit(id);
  return order;
}
