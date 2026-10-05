# TODO

Work that is planned but not started: why it is wanted and what is known.

## Anonymized game skeletons

**Why.** Games that break or slow the analysis often can't be shared, not even
their names. A skeleton of the whole game, like the `scripts/stress/genGame.mjs`
games but with the real structure, would let anyone reproduce and benchmark it.

**What.** **QSP: Export Anonymized Skeleton**: a copy of each project file with
everything but the structure replaced, and the same code as a Node script for
tests. Start from `src/parser/anonymize.ts` (one location, whitelist-based).
For a whole game it must also:
- give each name one pseudonym across the game, ignoring case;
- rename word by word, keeping separators and digits (`room_12` → `w017_12`,
  `'room_'` → `'w017_'`), so `gt 'room_' + n` still finds its targets;
- turn strings that are names into their pseudonyms (`gs 'go', 'hall'`), not `xxx`;
- keep numbers, and text sizes (`x` of the same length) for benchmarks;
- anonymize code in strings (`exec:` links, `<<…>>`) as `embeddedExec.ts` /
  `embeddedInterpolation.ts` parse it;
- keep the pseudonym → name table on the user's machine only.

**Check.** Location, jump and diagnostic counts, the `[jump graph]` line and the
`[perf]` shape must match the original's; tests as in `test/anonymize.test.ts`
that no name or text survives.

## Dynamic jumps through several hops

`gt $to` resolves from the nearest write before it or before the jumps into its
location (`src/parser/targetResolver.ts`). A value set two or more hops earlier
(A → B → C) stays unknown; in two real games `callers: not written before a call`
is most of what is left. Follow callers of callers a few hops, with a visited set:
unbounded, it overflowed the stack on the stress games.

## Jump Graph frame rate on large views

~3000 arrows at once (a ~1000-location game, under the 5000-arrow threshold) make
panning and hovering slow: every frame redraws all arrows, hover fades every
element. Lower `EDGE_BUDGET` in `src/webview/graph.ts` to ~1500, or skip the fade
on large graphs.

## Second player for Run, and Open VSX

The `qsp-game-template` workspace installs qspgui (used by **Run QSP Game**
through `playerExecutable`) and qSpider (only via a task). A second, optional
player in `txt2gam.json` with its own run command would replace the task.
Publishing to Open VSX would let the template install the extension like any
other instead of a pinned `.vsix` from GitHub Releases.

## Default library catalog

`qsp.libraries.sources` is empty by default, so authors must find a catalog URL
first. Once the maintainer's library repository exists (not yet):
- make its `libraries.json` the default of `qsp.libraries.sources` and mention it
  in README.md and LIBRARIES.md, and in the template's `game/.vscode/settings.json`;
- set it up as LIBRARIES.md suggests: location names prefixed with the library id,
  CI that recomputes each `sha256` and checks that no two libraries share a
  location name.

## Analysis: background and cache format

Every file is analysed one way, location by location, open or closed; unchanged
files are read back from the cache (`src/server/nodeCache.ts`), and the
aggregates and diagnostics run in slices between requests. What still blocks is
a file's own analysis (reading a 12.8 M-character file back: 3 s). Next:
- **First analysis in worker threads,** like clangd's background index: files in
  parallel, results handed over in the cache format.
- **A cache format of our own** (long term) instead of `v8.serialize`: a string
  table, the URI once, positions and names in flat arrays. Could remove the 1.2 s
  of `compactDeserialized` on read, but is bound to the symbol types.
- **A cache for the MCP server and VS Code for the Web:** `QspHost` takes a
  `cacheDir` already, the MCP server needs a folder (e.g. the user's cache
  directory), the browser IndexedDB.
