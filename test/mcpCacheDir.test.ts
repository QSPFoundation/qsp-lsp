/**
 * Where the MCP server keeps its analysis cache (src/mcp/cacheDir.ts): the
 * user's cache directory, a folder per game, unless the command line says
 * otherwise.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { mcpCacheDir, userCacheBase } from '../src/mcp/cacheDir';

describe('userCacheBase', () => {
  it('follows XDG_CACHE_HOME, then each platform\'s own place', () => {
    expect(userCacheBase({ XDG_CACHE_HOME: '/x' }, 'linux', '/home/u')).toBe('/x');
    expect(userCacheBase({}, 'linux', '/home/u')).toBe(path.join('/home/u', '.cache'));
    expect(userCacheBase({}, 'darwin', '/Users/u')).toBe(path.join('/Users/u', 'Library', 'Caches'));
    expect(userCacheBase({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\U')).toBe('C:\\L');
  });
});

describe('mcpCacheDir', () => {
  it('gives each game a folder of its own, the same on every start', () => {
    const a = mcpCacheDir([], '/games/one', '/cache');
    expect(a).toBe(mcpCacheDir(['--verbose'], '/games/one/', '/cache'));
    expect(a).not.toBe(mcpCacheDir([], '/games/two', '/cache'));
    expect(path.dirname(a!)).toBe(path.join('/cache', 'qsp-lsp', 'mcp'));
    // A hash, not the game's path or name.
    expect(path.basename(a!)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('takes --cache-dir, and none with --no-cache', () => {
    expect(mcpCacheDir(['--cache-dir', '/tmp/c'], '/games/one', '/cache')).toBe(path.resolve('/tmp/c'));
    expect(mcpCacheDir(['--no-cache', '--cache-dir', '/tmp/c'], '/games/one', '/cache')).toBeUndefined();
  });
});
