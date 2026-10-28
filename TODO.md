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

## Open VSX

`release.yml` publishes to the VS Code Marketplace as `QSPFoundation` by
trusted publishing, with no stored token. Its Open VSX step, trusted
publishing too, is skipped until the repository variable `PUBLISH_OPEN_VSX`
is `true`. Open VSX registers a trusted publisher only for an extension it
already has, so before setting it:
- claim the `QSPFoundation` namespace on Open VSX (it exists, unverified and
  empty: an issue in EclipseFdn/open-vsx.org), and sign the Publisher Agreement;
- publish the latest release there by hand with an access token
  (`npx ovsx publish qsp-lsp-<version>.vsix -p <token>`, the `.vsix` of its
  GitHub Release), then add the trusted
  publisher (Settings → Trusted Publishers: QSPFoundation/qsp-lsp,
  `release.yml`, environment `release`), revoke the token and set
  `PUBLISH_OPEN_VSX`; later release runs skip a version Open VSX has.

Publishing there matters to VSCodium, Cursor and other editors that use Open
VSX; the game template, moving to VS Code, no longer needs it.

After 0.4.0 is out:
- the author of **QSP (official)** points its users to `QSPFoundation.qsp-lsp`
  (microsoft/vscode-discussions#1), and it and **qsp-ext** are marked deprecated
  in favour of it on the Marketplace;
- `qsp-game-template` installs the extension by its ID instead of a pinned
  `.vsix`, and lists the old ones in `unwantedRecommendations`.

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
files are read back from the cache (`src/server/nodeCache.ts`, in a format of
its own: `cacheFormat.ts`), and the aggregates and diagnostics run in slices
between requests; the project load, and opening a large file nothing is stored
for, analyse in up to four worker threads (`src/server/nodeWorkers.ts`), a large
file in a part per thread. What still blocks is reading a result back on the
main thread (a 12.8 M-character file: 0.5 s from the threads, 0.6 s from the
cache). Next:
- **Decoding in slices** (only pays for files past ~10 M characters): opening a
  12.8 M-character file from the cache holds the server for 1 s, half of it
  decoding the analysis (`decodeValue`, 0.44 s); one location decodes in 5 ms at
  most, so a decoder that stops between the top-level Map's entries and goes on
  in the next slice would leave ~0.5 s, the rest being reading the 16 MB
  `didOpen`, hashing the text for its key twice, the location index and
  unpacking (0.12 s). Needs `storedLocations` and the project load's cache hits
  to wait for it, as the worker path does. A 5 M-character file of a catalog
  game decodes in 0.1 s whole. Cheaper and on its own: the worker parts of a
  large file are decoded one after another (4 × 130 ms) and could be a slice
  each. Unpacking in Node's thread pool instead (`zlib.gunzip`, an
  asynchronous `AnalysisCache.get`) was measured and dropped: 0.1 s off the
  main thread, but 0.25 s in all instead of 0.11 s, and 100–200 MB more at the
  peak of a project load, with every file unpacked at once.
- **A cache for VS Code for the Web,** once it runs tree-sitter: today it analyses
  with regular expressions, whose results are never stored. IndexedDB is
  asynchronous, while `AnalysisCache.get` is not.
