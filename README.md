# QSP Language Support

Full-featured [QSP (Quest Soft Player)](https://qsp.org) language support for Visual Studio Code, powered by a Language Server Protocol (LSP) server and [tree-sitter](https://tree-sitter.github.io/) grammar.

## Features

### Syntax Highlighting
- **TextMate grammar** — instant coloring of locations, keywords, strings, variables, operators, labels, and comments
- **Tree-sitter semantic highlighting** — precise, context-aware token coloring (e.g. goto-targeted location names get a distinct style)

### IntelliSense
- **Completions** — built-in statements & functions, keywords, location names, variables, and user functions
- **Hover** — documentation tooltips for built-in functions/statements, location definitions, variable values, and dynamic call locals
- **Signature help** — parameter hints for built-in functions

### Navigation
- **Go to Definition** — jump to location definitions, variable assignments, labels, and actions
- **Find All References** — find all uses of a location, variable, label, action, or object
- **Document Symbols** — outline view with locations, labels, acts, and actions (Ctrl+Shift+O)
- **Document Highlights** — highlight all occurrences of a variable or label under the cursor
- **Go to Location** — quick-pick to jump to any location across the file or project (Ctrl+Shift+L)

### Editing
- **New Location** — insert a new `# name … ---` block
- **Insert Separator** — `---` separator (Ctrl+Shift+-)
- **Sort Locations** — sort A→Z or Z→A
- **Duplicate Location** — quick-pick to copy a location
- **Delete Location** — remove a location with confirmation
- **Rename Location** — rename a location and update all references
- **Move Location Up/Down** — reorder locations in the file (Alt+Up / Alt+Down)
- **Toggle Comment** — toggle `!` comments (Ctrl+/)
- **Format Location** — format the current location (Ctrl+Shift+F)
- **Snippets** — `loc`, `if`, `ife`, `act`, `loop`, `gs`, `gt`, `pl`, and more

### Multi-File Operations
- **List All Locations** — browse all locations across the file or project
- **List All Objects** — browse all objects (addobj) with their definition location
- **List All Variables** — browse all variables with usage summaries
- **Move Locations to File** — select locations and move them to another QSP file
- **Split Locations into Files** — select locations and create one `.qsps` file per location

### Project Mode
- When `qsp.project.enabled` is true, all `.qsps`/`.qsrc` files in the workspace are treated as one combined game
- Cross-file diagnostics: duplicate locations, unresolved references, variable dataflow
- Cross-file completions, go-to-definition, and navigation

### Diagnostics
- **Syntax errors** from tree-sitter parsing
- **Duplicate locations** — within a file or across the project
- **Duplicate labels & actions** — scope-aware, only flags same-scope duplicates
- **Unclosed locations** — missing `---` closer
- **Uninitialized variables** — used but never assigned, chain-aware
- **Unresolved references** — location, label, action, and object refs
- **Unused definitions** — locations, labels, variables, and objects
- **Invalid function prefix** — built-in called with incompatible `$`/`#`/`%`
- **Invalid argument count** — built-in called with too few/many args
- **Mixed variable prefixes** — variable accessed with inconsistent `$`/`#`/`%`
- **Type mismatch** — assigning a string value to a `%` variable, etc.
- **Mixed location call types** — location called as both func and gosub/goto
- **Inconsistent local propagation** — variable behaves as local or global depending on caller
- **Untracked dynamic calls** — `dynamic`/`dyneval` whose first argument can't be pinned to a single code block (complex expression, multiple global assignments, or multiple local code-block bindings across distinct scopes)
- **Missing `result` in function call** — function-style call (`@loc`, `func`, or `dyneval` block) that never assigns `result`
- **Extra args to target without `args`** — call passes extra positional arguments but the target location or inline code block never reads the `args` variable; the extras are silently discarded
- **Shadows call-frame built-in** — `local args` / `local result` is unnecessary: both are already per-call-frame variables, so the `local` keyword has no effect at a location's top level and merely hides the outer value inside a nested scope
- **Shadows propagated local** — `local x` in a callee re-declares a name that one or more callers already propagate as a local

### Status Bar
- Shows the current location name at cursor position
- Click to open the Go to Location quick-pick

## Supported File Extensions

| Extension | Description |
|-----------|-------------|
| `.qsps`   | QSP source text file |
| `.qsrc`   | QSP source text file |

## Commands

| Command | Keybinding | Description |
|---------|-----------|-------------|
| QSP: Go to Location… | `Ctrl+Shift+L` | Quick-pick to jump to a location |
| QSP: New Location | — | Insert a new location block at end of file |
| QSP: Insert Location Separator | `Ctrl+Shift+-` | Insert `---` at cursor |
| QSP: Sort Locations (A → Z) | — | Sort all locations alphabetically |
| QSP: Sort Locations (Z → A) | — | Sort all locations reverse alphabetically |
| QSP: Duplicate Location… | — | Quick-pick a location to duplicate |
| QSP: Delete Location | — | Quick-pick a location to delete |
| QSP: Rename Location… | — | Rename a location via input box |
| QSP: Move Location Up | `Alt+Up` | Move the current location up |
| QSP: Move Location Down | `Alt+Down` | Move the current location down |
| QSP: Toggle Comment | `Ctrl+/` | Toggle `!` line comments |
| QSP: Format Location | `Ctrl+Shift+F` | Format the current location |
| QSP: List All Locations | — | Navigable list of all locations |
| QSP: List All Objects | — | Navigable list of all objects |
| QSP: List All Variables | — | Navigable list of all variables |
| QSP: Move Locations to File… | — | Select locations to move to another file |
| QSP: Split Locations into Files… | — | Split locations into individual `.qsps` files |

## Settings

### General

| Setting | Default | Description |
|---------|---------|-------------|
| `qsp.project.enabled` | `true` | Enable project mode: treat all `.qsps`/`.qsrc` files as one combined game |
| `qsp.trace.server`    | `off`  | Traces LSP communication (`off`, `messages`, `verbose`) |
| `qsp.semanticHighlighting.enabled` | `true` | Enable semantic token highlighting (requires tree-sitter) |

### Diagnostics

All diagnostic checks are enabled by default. Set to `false` to disable a specific check.

| Setting | Default | Description |
|---------|---------|-------------|
| `qsp.diagnostics.duplicateLocations` | `true` | Report duplicate location names |
| `qsp.diagnostics.duplicateLabels` | `true` | Warn about duplicate labels within the same location |
| `qsp.diagnostics.duplicateActions` | `true` | Info about duplicate act statements |
| `qsp.diagnostics.unreachableLabels` | `true` | Warn about labels that are not at the start of a line (unreachable at runtime) |
| `qsp.diagnostics.unclosedLocations` | `true` | Error about locations not closed with `---` |
| `qsp.diagnostics.uninitializedVariables` | `true` | Warn about variables used but never assigned |
| `qsp.diagnostics.unresolvedLocationRefs` | `true` | Warn about refs to undefined locations |
| `qsp.diagnostics.unresolvedLabelRefs` | `true` | Warn about jump targets not defined in the location |
| `qsp.diagnostics.unresolvedActionRefs` | `true` | Warn about refs to undefined actions |
| `qsp.diagnostics.unresolvedObjectRefs` | `true` | Warn about refs to objects not added |
| `qsp.diagnostics.unusedLocations` | `true` | Hint about locations defined but never called |
| `qsp.diagnostics.unusedLabels` | `true` | Hint about labels defined but never jumped to |
| `qsp.diagnostics.unusedVariables` | `true` | Hint about variables assigned but never read |
| `qsp.diagnostics.unusedObjects` | `true` | Hint about objects added but never referenced |
| `qsp.diagnostics.invalidFunctionPrefix` | `true` | Warn when function called with wrong type prefix |
| `qsp.diagnostics.invalidBuiltinArgCount` | `true` | Warn when built-in called with wrong arg count |
| `qsp.diagnostics.mixedVariablePrefixes` | `true` | Info when variable uses inconsistent type prefixes |
| `qsp.diagnostics.typeMismatch` | `true` | Info when assigning wrong type to a variable |
| `qsp.diagnostics.mixedLocationCallTypes` | `true` | Info when location called as both func and gosub/goto |
| `qsp.diagnostics.inconsistentLocalPropagation` | `true` | Warn when local propagation varies by caller |
| `qsp.diagnostics.untrackedDynamicCalls` | `true` | Info when dynamic call can't be statically resolved |
| `qsp.diagnostics.missingResultInFunctionCall` | `true` | Warn when `@loc` / `func` / `dyneval` block never assigns `result` |
| `qsp.diagnostics.extraArgsToTargetWithoutArgs` | `true` | Info when call passes extra args but target never reads `args` |
| `qsp.diagnostics.shadowsCallFrameBuiltin` | `true` | Info on unnecessary `local args` / `local result` declarations |
| `qsp.diagnostics.shadowsPropagatedLocal` | `true` | Info when `local x` in a callee shadows a propagated-in local |
| `qsp.diagnostics.maxErrorsPerLocation` | `20` | Max syntax errors reported per location |
| `qsp.diagnostics.maxLocationLines` | `500` | Max lines per location (0 = unlimited) |

## QSP Language Basics

QSP files are organized into **locations** — named blocks delimited by `#` and `---`:

```qsp
# start
pl 'Hello, world!'
act 'Go north':
  goto 'room1'
end
---

# room1
$name = 'Player'
pl 'Welcome, <<$name>>'
---
```

Key concepts:
- **`$`** prefix → string variable (`$name`)
- **`#`** prefix → numeric variable (`#count`)
- **`%`** prefix → tuple variable (`%arr`)
- **`!`** — line comment
- **`&`** — statement separator (multiple statements on one line)
- **`<<expr>>`** — string interpolation

## Development

```bash
# Install dependencies
npm install

# Build everything (grammar WASM + server + client)
npm run build

# Watch mode
npm run watch

# Run tests
npm test
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

## Architecture

```
src/
  client/                    # VS Code extension entry points
    nodeMain.ts              #   Desktop (Node.js + stdio)
    browserMain.ts           #   Web (Worker + postMessage)
    features.ts              #   Command registration & status bar
    locationCommands.ts      #   Location editing commands
    shared.ts                #   Editor helpers
  server/                    # LSP server
    nodeMain.ts              #   Desktop entry
    browserMain.ts           #   Web entry
    common.ts                #   Server lifecycle & incremental per-location parse
    projectMode.ts           #   Multi-file workspace aggregation
    serverUtils.ts           #   Shared utilities (stripBom, shiftErrors, …)
    diagnostics.ts           #   Diagnostic orchestrator
    diagnosticPasses/        #   Domain-specific diagnostic checks
      diagnosticHelpers.ts       Shared diagnostic helpers
      structureDiagnostics.ts    Syntax errors, dupes, unclosed/oversized
      symbolDiagnostics.ts       Labels, actions, objects, refs per location
      variableDiagnostics.ts     Uninitialized, mixed prefixes, type mismatch
      dynamicDiagnostics.ts      Untracked/unresolvable dynamic calls
      propagationDiagnostics.ts  Inconsistent propagation, unused locations
    lspFeatures.ts           #   Hover, completion, definition, references, rename
    featureTypes.ts          #   Shared handler context types
    hoverHelpers.ts          #   Markdown builders for hover
    symbolNav.ts             #   Cross-file symbol resolution
    semanticTokens.ts        #   Semantic token legend & collection
    codeActions.ts           #   Code action providers
    regexFallback.ts         #   Regex analysis when tree-sitter unavailable
    aggregation.ts           #   Symbol aggregates for diagnostics & dataflow
    helpers.ts               #   URI basename utility
  parser/                    # Language analysis
    extractSymbols.ts        #   Symbol extraction orchestrator
    symbolWalker.ts          #   Scope-aware recursive AST walker
    symbolExtractors.ts      #   Per-node extractors (variable, label, action, refs)
    bindingCollector.ts      #   Assignment pre-scan & dynamic call resolution
    variableBindings.ts      #   Dataflow resolver (possible values, chains)
    scopeUtils.ts            #   Scope classification & binding visibility
    walkHelpers.ts           #   Argument parsing, string utilities
    lookupTables.ts          #   Statement/function name classification
    variableUtils.ts         #   Variable definition/classification predicates
    lintChecks.ts            #   Standalone lint checks
    extractErrors.ts         #   Tree-sitter error extraction & merged lint pass
    builtins.ts              #   Built-in statements & functions data
    blockKeywords.ts         #   Block keyword range extraction
    treeSitter.ts            #   Tree-sitter wrapper
    symbolTable.ts           #   DocumentSymbols (cross-location index)
    locationSymbols.ts       #   LocationSymbols (per-location symbol table)
    symbolTypes.ts           #   Core types: QspSymbol, VariableBinding, etc.
    index.ts                 #   Public API re-exports
  common/                    # Shared between client and server
    locations.ts             #   Location block parsing & index operations
    qspStringScanner.ts      #   QSP string scanning
tree-sitter-qsp/             # Tree-sitter grammar for QSP
```

## License

MPL-2.0
