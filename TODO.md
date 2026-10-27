# TODO

Work that is planned but not started: why it is wanted and what is known.

## Syntax version 5.7.0

Games written for the QSP 5.7 player (github.com/QSPFoundation/qsp-legacy) follow
other rules than `qsp.syntaxVersion` 5.9.5 and 5.9.6, checked by running code on
the three libraries: inside `(…)` and `[…]` a line breaks only with ` _` (a bare
line break there is "Syntax error" / "Bracket not found"; 5.9 is the reverse), true
is -1, and there are no tuples, `%`, and several 5.9 functions. A third version would
gate these like 5.9.6's constructs are gated now.

## ALIAS in the symbol analysis

`ALIAS a, $b = 'arr1', 'arr2'` (QSP 5.9.6) makes `a` and `$b` locals that share
the arrays named by the values: a write through `a` is a write to `arr1`. The
analysis reads the names as locals with an unknown value (`alias_statement` in
`bindingCollector.ts`), so `arr1` written only through `a` is "assigned but never
read" or "used but never assigned", and references, rename and hover don't link
`a` to `arr1`. Follow a literal name (`'arr1'`, `'$arr1'`) as a reference to that
array, and make reads and writes through the alias count as its.

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
