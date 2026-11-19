import { describe, it, expect } from 'vitest';
import {
  catalogFromRelease,
  latestReleaseApiUrl,
  parseGitHubRepo,
  readRelease,
  versionOfTag,
} from '../src/common/githubReleases';

const SOURCE = 'https://github.com/alex/qsp-dialogs';
const BASE = 'https://github.com/alex/qsp-dialogs/releases/download/v1.2.0';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

// The API's answer for a release, trimmed to what is read.
const apiRelease = (assets: Array<{ name: string; digest?: string | null }>, tag = 'v1.2.0') => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map(a => ({
    name: a.name,
    browser_download_url: `https://github.com/alex/qsp-dialogs/releases/download/${tag}/${encodeURIComponent(a.name)}`,
    digest: a.digest ?? null,
  })),
});

describe('githubReleases: sources', () => {
  it('reads a repository URL, with .git, /releases or a trailing slash', () => {
    for (const s of [SOURCE, `${SOURCE}/`, `${SOURCE}.git`, `${SOURCE}/releases`, ' https://GitHub.com/alex/qsp-dialogs ']) {
      expect(parseGitHubRepo(s)).toEqual({ owner: 'alex', repo: 'qsp-dialogs' });
    }
    expect(latestReleaseApiUrl({ owner: 'alex', repo: 'qsp-dialogs' }))
      .toBe('https://api.github.com/repos/alex/qsp-dialogs/releases/latest');
  });

  it('leaves libraries.json URLs, raw files and other pages to the catalog reader', () => {
    for (const s of [
      'https://raw.githubusercontent.com/alex/qsp-dialogs/main/libraries.json',
      `${SOURCE}/blob/main/libraries.json`,
      `${SOURCE}/releases/latest/download/libraries.json`,
      'https://github.com/alex',
      'https://example.org/alex/qsp-dialogs',
      'https://github.com/alex/..',
    ]) {
      expect(parseGitHubRepo(s)).toBeUndefined();
    }
  });

  it('takes the version from the tag', () => {
    expect(versionOfTag('v1.2.0')).toBe('1.2.0');
    expect(versionOfTag('V2')).toBe('2');
    expect(versionOfTag('1.0')).toBe('1.0');
    expect(versionOfTag('version-3')).toBe('version-3');
  });

  it("reads GitHub's checksum of each file, and nothing from an answer that isn't a release", () => {
    const release = readRelease(apiRelease([{ name: 'dialogs.qsps', digest: `sha256:${SHA_A.toUpperCase()}` }, { name: 'old.qsps' }]));
    expect(release).toEqual({
      tag: 'v1.2.0',
      assets: [
        { name: 'dialogs.qsps', url: `${BASE}/dialogs.qsps`, sha256: SHA_A },
        { name: 'old.qsps', url: `${BASE}/old.qsps`, sha256: undefined },
      ],
    });
    expect(readRelease({ message: 'Not Found' })).toBeUndefined();
    expect(readRelease(null)).toBeUndefined();
  });
});

describe('githubReleases: the catalog of a release', () => {
  it('makes every attached .qsps a library, versioned by the tag, when there is no libraries.json', () => {
    const release = readRelease(apiRelease([
      { name: 'dialogs.qsps', digest: `sha256:${SHA_A}` },
      { name: 'README.md', digest: `sha256:${SHA_B}` },
      { name: 'menus.qsps', digest: `sha256:${SHA_C}` },
    ]))!;
    expect(catalogFromRelease(release, SOURCE)).toEqual({
      libraries: [
        expect.objectContaining({ id: 'dialogs', version: '1.2.0', url: `${BASE}/dialogs.qsps`, sha256: SHA_A, catalog: SOURCE, usage: "inclib 'libs/dialogs.qsp'" }),
        expect.objectContaining({ id: 'menus', version: '1.2.0', url: `${BASE}/menus.qsps`, sha256: SHA_C, catalog: SOURCE }),
      ],
      problems: [],
    });
  });

  it('says why a file is left out: no checksum, or a name that is no library id', () => {
    const release = readRelease(apiRelease([{ name: 'old.qsps' }, { name: '+bad.qsps', digest: `sha256:${SHA_A}` }]))!;
    const { libraries, problems } = catalogFromRelease(release, SOURCE);
    expect(libraries).toEqual([]);
    expect(problems).toEqual([
      expect.stringMatching(/^alex\/qsp-dialogs v1\.2\.0: GitHub has no checksum of "old\.qsps"/),
      expect.stringContaining('"+bad.qsps" can\'t be a library'),
    ]);
    expect(catalogFromRelease(readRelease(apiRelease([{ name: 'game.zip', digest: `sha256:${SHA_A}` }]))!, SOURCE).problems)
      .toEqual(['alex/qsp-dialogs v1.2.0: the release has no .qsps file and no libraries.json']);
  });

  it('reads an attached libraries.json, its version and checksums from the release unless it gives them', () => {
    const release = readRelease(apiRelease([
      { name: 'libraries.json', digest: `sha256:${SHA_B}` },
      { name: 'dialogs.qsps', digest: `sha256:${SHA_A}` },
      { name: 'utils.qsps', digest: `sha256:${SHA_C}` },
    ]))!;
    const json = {
      libraries: [
        { id: 'dialogs', name: 'Dialogs', file: 'dialogs.qsps', requires: ['utils'], usage: "inclib 'libs/dialogs.qsp'\ngs 'dialogs_init'" },
        { id: 'utils', file: 'utils.qsps', version: '0.9', sha256: SHA_B },
        { id: 'ghost', file: 'ghost.qsps' },
      ],
    };
    const { libraries, problems } = catalogFromRelease(release, SOURCE, json);
    expect(libraries).toEqual([
      expect.objectContaining({ id: 'dialogs', name: 'Dialogs', version: '1.2.0', sha256: SHA_A, url: `${BASE}/dialogs.qsps`, requires: ['utils'], catalog: SOURCE }),
      expect.objectContaining({ id: 'utils', version: '0.9', sha256: SHA_B, catalog: SOURCE }),
    ]);
    expect(problems).toEqual([
      'alex/qsp-dialogs v1.2.0: library "ghost": "ghost.qsps" is not a file of the release, so it has no checksum; attach it or give "sha256"',
    ]);
  });
});
