// ── Libraries from GitHub releases ───────────────────────────────────
//
// A library source can be a GitHub repository instead of a libraries.json
// URL: its latest release is the catalog. The release's tag is the version
// and GitHub's SHA-256 of each attached file its checksum, so the library's
// author keeps neither by hand, and the built .qsps lives in the release, not
// in the repository (where the analysis would see its locations twice). A
// libraries.json attached to the release adds names, descriptions, usage
// lines and requirements; without one, every attached .qsps is a library.
// Pure: the client fetches, this decides.

import { parseCatalog, type ParsedCatalog } from './libraryCatalog';
import { isValidLibraryId } from './libraryConfig';

/** The repository a source names. */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

// GitHub's own rules for user and repository names, loosely: what a URL
// path segment can hold without escaping.
const NAME = '[A-Za-z0-9_.-]+';
const REPO_URL_RE = new RegExp(`^https://github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?(?:/releases)?/?$`, 'i');

/**
 * The repository of a source like `https://github.com/<owner>/<repo>`
 * (`.git`, `/releases` and a trailing `/` allowed); undefined for any other
 * URL, which is read as a libraries.json.
 */
export function parseGitHubRepo(source: string): GitHubRepo | undefined {
  const match = REPO_URL_RE.exec(source.trim());
  if (!match || match[2] === '' || match[2] === '.' || match[2] === '..') return undefined;
  return { owner: match[1], repo: match[2] };
}

/** The API URL of the repository's latest release (not a draft or a pre-release). */
export function latestReleaseApiUrl({ owner, repo }: GitHubRepo): string {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
}

/** One file attached to a release. */
export interface ReleaseAsset {
  name: string;
  /** Where to download it. */
  url: string;
  /** GitHub's SHA-256 of it (hex); files attached before mid-2025 have none. */
  sha256: string | undefined;
}

/** What a release says of itself that the catalog needs. */
export interface Release {
  tag: string;
  assets: ReleaseAsset[];
}

/** Read the API's answer for a release; undefined when it isn't one. */
export function readRelease(json: unknown): Release | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const r = json as { tag_name?: unknown; assets?: unknown };
  if (typeof r.tag_name !== 'string' || r.tag_name === '' || !Array.isArray(r.assets)) return undefined;
  const assets: ReleaseAsset[] = [];
  for (const raw of r.assets) {
    const a = (raw && typeof raw === 'object' ? raw : {}) as { name?: unknown; browser_download_url?: unknown; digest?: unknown };
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
    const digest = typeof a.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(a.digest)?.[1]?.toLowerCase() : undefined;
    assets.push({ name: a.name, url: a.browser_download_url, sha256: digest });
  }
  return { tag: r.tag_name, assets };
}

/** The version a tag stands for: `v1.2.0` is `1.2.0`; anything else stays as it is. */
export function versionOfTag(tag: string): string {
  return /^v\d/i.test(tag) ? tag.slice(1) : tag;
}

/** The attached catalog, when the release has one. */
export function catalogAsset(release: Release): ReleaseAsset | undefined {
  return release.assets.find(a => a.name.toLowerCase() === 'libraries.json');
}

/**
 * The libraries a release offers. With `catalogJson` (its attached
 * libraries.json), the catalog's entries, whose files are names of the
 * release's files and whose `version`/`sha256` default to the tag and
 * GitHub's checksum; without, one library per attached .qsps, named by its
 * file. `source` is the repository URL the libraries record as their
 * catalog, so an update finds them in whatever release comes next.
 */
export function catalogFromRelease(release: Release, source: string, catalogJson?: unknown): ParsedCatalog {
  const repo = parseGitHubRepo(source);
  const where = repo ? `${repo.owner}/${repo.repo} ${release.tag}` : `${source} ${release.tag}`;
  const version = versionOfTag(release.tag);
  const byUrl = new Map(release.assets.map(a => [normalizeUrl(a.url), a]));
  const catalog = catalogAsset(release);
  if (catalog && catalogJson !== undefined) {
    const parsed = parseCatalog(catalogJson, catalog.url, {
      version,
      sha256Of: url => byUrl.get(normalizeUrl(url))?.sha256,
      source,
    });
    return { libraries: parsed.libraries, problems: parsed.problems.map(p => p.replace(catalog.url, where)) };
  }

  const problems: string[] = [];
  const entries = release.assets.filter(a => /\.qsps$/i.test(a.name)).flatMap(a => {
    const id = a.name.replace(/\.qsps$/i, '');
    if (!isValidLibraryId(id)) {
      problems.push(`${where}: "${a.name}" can't be a library: its name must be letters, digits, "_", "-" or "."`);
      return [];
    }
    if (!a.sha256) {
      problems.push(`${where}: GitHub has no checksum of "${a.name}" (attached before mid-2025): attach it again, or attach a libraries.json that gives "sha256"`);
      return [];
    }
    return [{ id, file: a.name, sha256: a.sha256 }];
  });
  if (entries.length === 0 && problems.length === 0) {
    problems.push(`${where}: the release has no .qsps file and no libraries.json`);
  }
  const parsed = parseCatalog({ libraries: entries }, catalog?.url ?? release.assets[0]?.url ?? source, { version, source });
  return { libraries: parsed.libraries, problems: [...problems, ...parsed.problems] };
}

// The API gives download URLs with names escaped; a catalog's relative
// path resolves to the same once both go through URL.
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
