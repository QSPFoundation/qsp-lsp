/**
 * Per-location symbol table — built from a tree-sitter parse of one
 * location block.  Tracks variables, labels, actions, and references
 * for diagnostics, hover, go-to-definition, and rename.
 */


import {
  QspSymbolKind,
  type SymbolLocation,
  type QspSymbol,
  type PrefixWarning,
  type ArgCountWarning,
  type DeprecationWarning,
  type VariableBinding,
} from './symbolTypes';

export class LocationSymbols {
  public readonly locationName: string;
  public readonly variables = new Map<string, QspSymbol>();
  /**
   * Labels bucketed by their **label namespace** — a number that
   * identifies the nearest enclosing label-isolating construct
   * (`act` body, stored `code_block`, `dynamic { … }` block, or `0`
   * for the location root).  The walker tracks this namespace as it
   * descends and passes it to `addLabel` / `addLabelRef` directly;
   * collisions of the same name in distinct namespaces do not
   * conflict, and a `jump` resolves only against its own bucket.
   *
   * Use `getLabel(name, ns)` / `getLabelRef(name, ns)` for cursor
   * lookups; iterate `allLabelSymbols()` / `allLabelRefSymbols()`
   * to walk every entry irrespective of namespace.
   */
  public readonly labels = new Map<number, Map<string, QspSymbol>>();
  /**
   * Source positions of `label_statement` nodes that the QSP runtime
   * will never recognize because they do not begin a line — e.g. the
   * body of an inline `if` / `loop` / `act`, or a label after `&` in
   * a `&`-chain.  We track them so they can be flagged with a
   * diagnostic and surfaced in hover, but they do NOT participate in
   * label/jump lookups, duplicate detection, or rename.
   */
  public readonly unreachableLabels: SymbolLocation[] = [];
  public readonly actions: QspSymbol[] = [];
  /** Refs indexed by nameLower for O(1) lookup */
  public readonly locationRefs = new Map<string, QspSymbol>();
  /** Label refs (`jump`) bucketed by namespace — see {@link labels}. */
  public readonly labelRefs = new Map<number, Map<string, QspSymbol>>();
  public readonly objectRefs = new Map<string, QspSymbol>();
  public readonly actionRefs = new Map<string, QspSymbol>();
  /** Warnings for function calls with incompatible type prefixes. */
  public readonly prefixWarnings: PrefixWarning[] = [];
  /** Warnings for builtins called with wrong number of positional args. */
  public readonly argCountWarnings: ArgCountWarning[] = [];
  /** Warnings for deprecated/outdated builtin statements or functions. */
  public readonly deprecationWarnings: DeprecationWarning[] = [];
  /** True when the tree-sitter location_block node contained ERROR sub-nodes. */
  public hasErrors = false;

  // Scope hierarchy for local variable propagation.
  // Maps child scopeId → parent scopeId.
  public readonly scopeParent = new Map<number, number>();
  // Scopes where parent locals do NOT propagate in (act, code_block).
  public readonly isolatedScopes = new Set<number>();
  /**
   * Base names that have at least one LOCAL declaration (fast-path skip).
   * Public for read-only consumers (e.g. cross-location aggregation);
   * internal mutators are `addVariable` and `injectLocalIntoScope`.
   * Do NOT mutate from outside this class.
   */
  public readonly localNames = new Set<string>();
  /**
   * Symbols owned by this location — i.e. populated by `addVariable`
   * for declarations and references that occur in this location's source.
   * Does NOT include alias entries injected by `injectLocalIntoScope`
   * (var-mediated dynamic/dyneval propagation), which point at
   * caller-owned QspSymbols re-keyed under synthetic scopes.
   * Iterators that want one entry per declaration should iterate
   * `ownedVariables` instead of `variables` directly.
   */
  public readonly ownedVariables = new Set<QspSymbol>();
  /**
   * Index: scopeId → set of local base-names declared at that scope.
   * Populated by addVariable() when isLocal=true.
   * Enables O(scope_chain) getLocalsInScope instead of O(V) full-map scan.
   */
  private readonly localsByScope = new Map<number, Set<string>>();
  /**
   * Memoization for {@link getLocalsInScope}.  The returned Map is
   * immutable from callers' perspective (treated as ReadonlyMap and
   * never mutated — see grep on `localsInScope\.(set|delete|clear)`),
   * so multiple call sites in the same scope can safely share one
   * instance.  Cleared by `invalidateLocalsCache` whenever a local
   * is added to any scope.  Locals are added far less frequently than
   * call sites query them, so cache hits dominate on large locations
   * and we save thousands of redundant Map allocations.
   */
  private localsInScopeCache: Map<number, ReadonlyMap<string, number>> | undefined;

  private invalidateLocalsCache(): void {
    if (this.localsInScopeCache !== undefined) this.localsInScopeCache.clear();
  }
  /**
   * Tree-sitter node IDs of `code_block` arguments to `dynamic` /
   * `dyneval`, mapped to the set of local base-names in scope at the
   * call site.  The walker uses this set to take a non-isolated
   * variable scope (caller locals propagate in) AND a fresh label
   * namespace (jumps cannot escape the block).
   */
  public readonly dynamicCodeBlocks = new Map<number, ReadonlyMap<string, number>>();
  /**
   * `dynamic { ... }` and `dyneval({ ... }, ...)` call sites with a
   * resolved literal `code_block` first argument, OR a var-mediated
   * `dynamic $code` / `dyneval($code, …)` whose first argument resolved
   * to one or more candidate code-block bindings (sequential overwrites,
   * cross-branch locals, multiple global assignments — all collected as
   * a target set).  Used by:
   *   - `missingResultInFunctionCall` (only `kind: 'dyneval'`) — warns
   *     iff EVERY candidate block fails to assign `result` directly
   *     (universal-quantification: any single target that succeeds
   *     suppresses the warning, since runtime may dispatch to it).
   *   - `extraArgsToTargetWithoutArgs` — when `argCount > 0`, warns iff
   *     EVERY candidate block body fails to reference `args` (same
   *     universal logic).
   * Each entry holds:
   *   - `kind`     — `'dynamic'` (statement form) or `'dyneval'` (function).
   *   - `callLoc`  — range of the entire `dynamic`/`dyneval` call (anchor
   *                   for the diagnostic).
   *   - `blockLocs`— ranges of every candidate code-block target. Always
   *                   non-empty.  Single-target dispatches use a 1-elt
   *                   array; multi-target var-mediated dispatches list
   *                   every resolvable binding.
   *   - `argCount` — number of *extra* positional arguments (after the
   *                   block) passed to the call.
   */
  public readonly resolvedDynamicBlocks: Array<{
    kind: 'dynamic' | 'dyneval';
    callLoc: SymbolLocation;
    blockLocs: SymbolLocation[];
    argCount: number;
  }> = [];
  /**
   * Call sites of `dynamic <var>` / `dyneval(<var>, ...)` where the first
   * argument is a variable holding a code block.  Used by hover to report
   * which locals propagate into the referenced block(s).
   *
   * Each entry records the call-site location (range of the dynamic/dyneval
   * statement), the variable name (original case + lowercased base name,
   * with no `$/#/%` prefix), and the set of local base-names propagated
   * from the caller's scope.
   */
  public readonly dynamicVarCalls: Array<{
    loc: SymbolLocation;
    varName: string;
    varBaseName: string;
    localNames: string[];
  }> = [];

  /**
   * Call sites of `dynamic` / `dyneval` whose first argument could not
   * be statically resolved to a unique code block.  Used to emit info
   * diagnostics so the user knows the block body is not being analysed
   * with caller-site locals.
   *
   * - `multiple-assignments`: the referenced variable has ≥ 2 global
   *   code-block assignments (or a mix of local + global).
   * - `multiple-local-bindings`: the variable has ≥ 2 distinct local
   *   code-block bindings in different scopes — the runtime target
   *   depends on which scope is active at the call.
   * - `complex-expression`: the first argument is neither a bare
   *   variable reference nor a code-block literal (e.g. `dynamic $a + $b`,
   *   `dynamic $arr[0]`, `dynamic func()`).
   */
  public readonly untrackedDynamicVarCalls: Array<{
    loc: SymbolLocation;
    varName: string;
    reason: 'multiple-assignments' | 'multiple-local-bindings' | 'complex-expression';
  }> = [];

  /**
   * Call sites of `dynamic $var` / `dyneval($var, ...)` where `$var`
   * is a plain variable reference but has NO visible code-block
   * binding within this location.  Such calls are candidates for
   * cross-location resolution: the aggregation layer checks whether
   * `$var` is a propagated local from a caller whose binding holds a
   * code block, and flows the block's inner writes back through the
   * call graph.
   *
   * Not surfaced to users as diagnostics (that's what
   * `untrackedDynamicVarCalls` is for) — this list exists purely so
   * the aggregator can see "there's a dispatch here we couldn't
   * resolve locally".
   */
  public readonly unresolvedDynamicVarCalls: Array<{
    loc: SymbolLocation;
    varName: string;
    varBaseName: string;
  }> = [];

  /**
   * All statically-observed `<var> = <rhs>` / `local <var> = <rhs>`
   * bindings in this location, keyed by the lowercased BASE name
   * (e.g. `fn`, `count`, `name` — no `$/#/%` prefix).  In modern QSP
   * a variable has a single underlying value regardless of which type
   * prefix is used to read/write it, so all writes — whether `$fn = …`,
   * `fn = …`, or `#fn = …` — share one bucket.  The prefix used at
   * each write site is preserved on `VariableBinding.writePrefix`.
   *
   * Consumed by:
   * - var-mediated `dynamic`/`dyneval` resolution (code-block defs);
   * - hover "possible values of $x", literal-arg resolution for
   *   `gs <var>`, constant-fold diagnostics, …
   */
  public readonly variableBindings = new Map<string, VariableBinding[]>();

  constructor(locationName: string) {
    this.locationName = locationName;
  }

  /**
   * Public accessor for finding a local symbol at a given scope.
   * Used by var-mediated dynamic/dyneval propagation to stitch
   * caller-site locals into synthetic scopes for deferred code blocks.
   */
  findLocalInScope(baseName: string, startScope: number): QspSymbol | undefined {
    return this.findLocalSym(baseName.toLowerCase(), startScope);
  }

  /**
   * Install a caller's existing local QspSymbol at the given synthetic
   * scope, so that references inside a deferred code block resolve back
   * to the caller-site declaration (sharing references, definition, and
   * prefix set).  Does NOT create a new symbol.
   */
  injectLocalIntoScope(baseName: string, scopeId: number, sym: QspSymbol): void {
    const key = `local\0${scopeId}\0${baseName}`;
    if (this.variables.has(key)) return;
    this.variables.set(key, sym);
    this.localNames.add(baseName);
    let scopeSet = this.localsByScope.get(scopeId);
    if (!scopeSet) { scopeSet = new Set(); this.localsByScope.set(scopeId, scopeSet); }
    scopeSet.add(baseName);
    this.invalidateLocalsCache();
  }

  /**
   * Walk up the scope chain from `startScope`, returning the QspSymbol
   * for the nearest local entry of `baseName`.  Stops at any scope
   * recorded in {@link isolatedScopes} — i.e. an `act` body or a
   * stored `code_block`.  Dynamic / dyneval blocks are NOT isolated,
   * so caller locals propagate through them.
   */
  private findLocalSym(baseName: string, startScope: number): QspSymbol | undefined {
    let s: number | undefined = startScope;
    while (s !== undefined) {
      const sym = this.variables.get(`local\0${s}\0${baseName}`);
      if (sym) return sym;
      if (this.isolatedScopes.has(s)) return undefined;
      s = this.scopeParent.get(s);
    }
    return undefined;
  }

  addVariable(
    name: string,
    loc: SymbolLocation,
    isLocal: boolean,
    isDefinition = false,
    prefix = '',
    scopeId = 0,
    hasValue = isDefinition,
  ): void {
    const baseName = name.toLowerCase();
    let sym: QspSymbol | undefined;

    if (isLocal) {
      // Explicit LOCAL declaration at this scope.
      //
      // Note: we intentionally do NOT "upgrade" a same-scope global
      // entry into a local here.  Symbol extraction walks in source
      // order, so an existing same-scope global entry holds refs that
      // were emitted by bare `x = …` writes appearing BEFORE this
      // `local x` declaration.  At runtime those writes target a
      // genuine global (the local doesn't exist yet at that line) —
      // absorbing them into the freshly-declared local would conflate
      // distinct runtime variables.  Instead, the global keeps its
      // pre-declaration refs, and a fresh local symbol owns this
      // declaration plus every subsequent in-scope reference.
      const localKey = `local\0${scopeId}\0${baseName}`;
      sym = this.variables.get(localKey);

      if (!sym) {
        sym = {
          name, nameLower: baseName,
          kind: QspSymbolKind.Variable,
          references: [], isLocal: true,
          locationName: this.locationName,
          prefixes: new Set<string>(),
          scopeId,
        };
        this.variables.set(localKey, sym);
        this.ownedVariables.add(sym);
      }
      sym.isLocal = true;
      this.localNames.add(baseName);
      let scopeSet = this.localsByScope.get(scopeId);
      if (!scopeSet) { scopeSet = new Set(); this.localsByScope.set(scopeId, scopeSet); }
      scopeSet.add(baseName);
      this.invalidateLocalsCache();
    } else {
      // Non-local use — fast path: skip scope walk if no local exists
      // for this name anywhere in the location.
      if (this.localNames.has(baseName)) {
        sym = this.findLocalSym(baseName, scopeId);
      }
      if (!sym) {
        sym = this.variables.get(baseName);
      }

      if (!sym) {
        sym = {
          name, nameLower: baseName,
          kind: QspSymbolKind.Variable,
          references: [], isLocal: false,
          locationName: this.locationName,
          prefixes: new Set<string>(),
        };
        this.variables.set(baseName, sym);
        this.ownedVariables.add(sym);
      }
    }

    if (isDefinition) {
      loc.isDefinition = true;
      if (!sym.definition) {
        sym.definition = loc;
      }
      if (hasValue) sym.hasValueDefinition = true;
    }
    sym.references.push(loc);
    sym.prefixes!.add(prefix);
  }

  addLabel(name: string, loc: SymbolLocation, namespace = 0): void {
    const key = name.toLowerCase();
    let bucket = this.labels.get(namespace);
    if (!bucket) { bucket = new Map(); this.labels.set(namespace, bucket); }
    const existing = bucket.get(key);
    if (existing) {
      // Duplicate label in the same namespace — record as additional
      // reference so the duplicate-label diagnostic can flag every site.
      existing.references.push(loc);
    } else {
      bucket.set(key, {
        name,
        nameLower: key,
        kind: QspSymbolKind.Label,
        definition: loc,
        references: [loc],
        isLocal: true,
        locationName: this.locationName,
      });
    }
  }

  /**
   * Find a variable by base name.  For non-local variables, returns the
   * single entry keyed by name.  For local variables there may be
   * multiple entries (one per scope) — this returns the first match
   * (typically for go-to-definition lookups where the cursor position
   * determines scope, but the caller will narrow further).
   */
  findVariable(name: string): QspSymbol | undefined {
    const baseName = name.toLowerCase();
    const global = this.variables.get(baseName);
    if (global) return global;
    if (!this.localNames.has(baseName)) return undefined;
    for (const [, sym] of this.variables) {
      if (sym.nameLower === baseName && sym.isLocal) return sym;
    }
    return undefined;
  }

  /**
   * Find the variable symbol whose reference covers the given position.
   * For names with scoped locals, this returns the exact scoped symbol
   * that owns the reference at (line, column) — essential when locals
   * shadow each other across nested scopes.
   */
  findVariableAtPosition(name: string, line: number, column: number): QspSymbol | undefined {
    const baseName = name.toLowerCase();
    if (!this.localNames.has(baseName)) {
      return this.variables.get(baseName);
    }
    // Has locals — find the symbol whose reference covers this position
    for (const [, sym] of this.variables) {
      if (sym.nameLower !== baseName) continue;
      for (const ref of sym.references) {
        if (line < ref.line || line > ref.endLine) continue;
        if (line === ref.line && column < ref.column) continue;
        if (line === ref.endLine && column > ref.endColumn) continue;
        return sym;
      }
    }
    // Fallback — cursor not on an exact reference
    return this.findVariable(baseName);
  }

  /**
   * Get all variable symbols matching a base name (all scopes).
   * Returns global + all local entries for that name.
   */
  findAllVariables(name: string): QspSymbol[] {
    const baseName = name.toLowerCase();
    const result: QspSymbol[] = [];
    const global = this.variables.get(baseName);
    if (global) result.push(global);
    if (this.localNames.has(baseName)) {
      for (const [, sym] of this.variables) {
        if (sym.nameLower === baseName && sym.isLocal) result.push(sym);
      }
    }
    return result;
  }

  addAction(name: string, loc: SymbolLocation, blockRange?: SymbolLocation): void {
    this.actions.push({
      name,
      nameLower: name.toLowerCase(),
      kind: QspSymbolKind.Action,
      definition: loc,
      blockRange,
      references: [loc],
      isLocal: true,
      locationName: this.locationName,
    });
  }

  addLocationRef(name: string, loc: SymbolLocation): void {
    this.addRef(this.locationRefs, name, loc, QspSymbolKind.Location, false);
  }

  addLabelRef(name: string, loc: SymbolLocation, namespace = 0): void {
    const key = name.toLowerCase();
    let bucket = this.labelRefs.get(namespace);
    if (!bucket) { bucket = new Map(); this.labelRefs.set(namespace, bucket); }
    const existing = bucket.get(key);
    if (existing) {
      existing.references.push(loc);
    } else {
      bucket.set(key, {
        name,
        nameLower: key,
        kind: QspSymbolKind.Label,
        definition: undefined,
        references: [loc],
        isLocal: true,
        locationName: this.locationName,
      });
    }
  }

  /**
   * Look up the label definition in the given namespace bucket.
   * `namespace` must be the value produced by the walker for the
   * cursor's enclosing label-isolating construct (or `0` for the
   * location root).
   */
  getLabel(name: string, namespace: number): QspSymbol | undefined {
    return this.labels.get(namespace)?.get(name.toLowerCase());
  }

  /** Like {@link getLabel} but returns the aggregated `jump` ref bucket. */
  getLabelRef(name: string, namespace: number): QspSymbol | undefined {
    return this.labelRefs.get(namespace)?.get(name.toLowerCase());
  }

  /** Iterate every label QspSymbol across all namespace buckets. */
  *allLabelSymbols(): IterableIterator<QspSymbol> {
    for (const [, bucket] of this.labels) {
      for (const [, sym] of bucket) yield sym;
    }
  }

  /** Iterate every label-ref QspSymbol across all namespace buckets. */
  *allLabelRefSymbols(): IterableIterator<QspSymbol> {
    for (const [, bucket] of this.labelRefs) {
      for (const [, sym] of bucket) yield sym;
    }
  }

  /**
   * Find the label entry (definition or `jump` reference) whose ref
   * range covers (`line`, `column`).  Returns the namespace bucket key
   * and lowercased name so callers can resolve the matching def/ref
   * via `labels.get(namespace)?.get(name)` / `labelRefs.get(…)`.
   * Used by go-to-def, hover, highlights, and `findSymbolAtPosition`.
   */
  findLabelEntryAtPosition(
    line: number,
    column: number,
  ): { namespace: number; name: string; kind: 'def' | 'ref' } | undefined {
    const hits = (r: SymbolLocation) =>
      line >= r.line && line <= r.endLine
      && (line !== r.line || column >= r.column)
      && (line !== r.endLine || column <= r.endColumn);
    for (const [namespace, bucket] of this.labels) {
      for (const [name, sym] of bucket) {
        if (sym.references.some(hits)) return { namespace, name, kind: 'def' };
      }
    }
    for (const [namespace, bucket] of this.labelRefs) {
      for (const [name, sym] of bucket) {
        if (sym.references.some(hits)) return { namespace, name, kind: 'ref' };
      }
    }
    return undefined;
  }

  addObjectRef(name: string, loc: SymbolLocation, isDefinition = false): void {
    this.addRef(this.objectRefs, name, loc, QspSymbolKind.Object, false, isDefinition);
  }

  addActionRef(name: string, loc: SymbolLocation): void {
    this.addRef(this.actionRefs, name, loc, QspSymbolKind.Action, false);
  }

  private addRef(
    map: Map<string, QspSymbol>,
    name: string,
    loc: SymbolLocation,
    kind: QspSymbolKind,
    isLocal: boolean,
    isDefinition = false,
  ): void {
    const key = name.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      if (isDefinition && !existing.definition) existing.definition = loc;
      existing.references.push(loc);
    } else {
      map.set(key, {
        name,
        nameLower: key,
        kind,
        definition: isDefinition ? loc : undefined,
        references: [loc],
        isLocal,
        locationName: isLocal ? this.locationName : undefined,
      });
    }
  }

  /**
   * Collect all local base-names visible at the given scope,
   * walking up the scope chain and stopping at isolation boundaries.
   *
   * Result is memoized — see `localsInScopeCache`.  Callers MUST treat
   * the returned map as read-only.
   */
  getLocalsInScope(scopeId: number): ReadonlyMap<string, number> {
    let cache = this.localsInScopeCache;
    if (cache !== undefined) {
      const hit = cache.get(scopeId);
      if (hit !== undefined) return hit;
    } else {
      cache = new Map();
      this.localsInScopeCache = cache;
    }

    const result = new Map<string, number>();
    let s: number | undefined = scopeId;
    while (s !== undefined) {
      const names = this.localsByScope.get(s);
      if (names) {
        for (const baseName of names) {
          // Only store the innermost scope (first encountered wins)
          if (!result.has(baseName)) {
            result.set(baseName, s);
          }
        }
      }
      if (this.isolatedScopes.has(s)) break;
      s = this.scopeParent.get(s);
    }
    cache.set(scopeId, result);
    return result;
  }

  static copyWithLineShift(
    source: LocationSymbols,
    lineShift: number,
  ): LocationSymbols {
    const copy = new LocationSymbols(source.locationName);
    copy.hasErrors = source.hasErrors;

    // Copy scope hierarchy and local-name indices (shared, no line info)
    for (const [k, v] of source.scopeParent) copy.scopeParent.set(k, v);
    for (const s of source.isolatedScopes) copy.isolatedScopes.add(s);
    for (const n of source.localNames) copy.localNames.add(n);
    for (const [k, v] of source.localsByScope) copy.localsByScope.set(k, new Set(v));

    if (lineShift === 0) {
      // No position adjustment needed — shallow-clone maps with shared symbols.
      // Symbols are not mutated after build, so sharing is safe.
      for (const [k, v] of source.variables) copy.variables.set(k, v);
      for (const sym of source.ownedVariables) copy.ownedVariables.add(sym);
      for (const [root, bucket] of source.labels) {
        const dst = new Map<string, QspSymbol>();
        for (const [k, v] of bucket) dst.set(k, v);
        copy.labels.set(root, dst);
      }
      for (const [k, v] of source.locationRefs) copy.locationRefs.set(k, v);
      for (const [root, bucket] of source.labelRefs) {
        const dst = new Map<string, QspSymbol>();
        for (const [k, v] of bucket) dst.set(k, v);
        copy.labelRefs.set(root, dst);
      }
      for (const [k, v] of source.objectRefs) copy.objectRefs.set(k, v);
      for (const [k, v] of source.actionRefs) copy.actionRefs.set(k, v);
      for (const act of source.actions) copy.actions.push(act);
      for (const pw of source.prefixWarnings) copy.prefixWarnings.push(pw);
      for (const aw of source.argCountWarnings) copy.argCountWarnings.push(aw);
      for (const dw of source.deprecationWarnings) copy.deprecationWarnings.push(dw);
      for (const d of source.dynamicVarCalls) copy.dynamicVarCalls.push(d);
      for (const d of source.untrackedDynamicVarCalls) copy.untrackedDynamicVarCalls.push(d);
      for (const d of source.unresolvedDynamicVarCalls) copy.unresolvedDynamicVarCalls.push(d);
      for (const d of source.resolvedDynamicBlocks) copy.resolvedDynamicBlocks.push(d);
      for (const [k, v] of source.variableBindings) copy.variableBindings.set(k, v);
      return copy;
    }

    const shift = (loc: SymbolLocation): SymbolLocation => ({
      ...loc,
      line: loc.line + lineShift,
      endLine: loc.endLine + lineShift,
    });

    const shiftSym = (sym: QspSymbol): QspSymbol => ({
      ...sym,
      definition: sym.definition ? shift(sym.definition) : undefined,
      blockRange: sym.blockRange ? shift(sym.blockRange) : undefined,
      references: sym.references.map(shift),
      prefixes: sym.prefixes ? new Set(sym.prefixes) : undefined,
    });

    const shiftMap = (src: Map<string, QspSymbol>, dst: Map<string, QspSymbol>) => {
      for (const [key, sym] of src) dst.set(key, shiftSym(sym));
    };

    const shiftBucketMap = (
      src: Map<number, Map<string, QspSymbol>>,
      dst: Map<number, Map<string, QspSymbol>>,
    ) => {
      for (const [root, bucket] of src) {
        const dstBucket = new Map<string, QspSymbol>();
        for (const [key, sym] of bucket) dstBucket.set(key, shiftSym(sym));
        dst.set(root, dstBucket);
      }
    };

    // Variables: preserve symbol identity across alias entries.
    // The same QspSymbol may appear under multiple keys when injected
    // by var-mediated dynamic/dyneval propagation; shifting twice would
    // produce two distinct copies and lose the aliasing.  Memoise by
    // source-symbol identity so every alias resolves to the same copy.
    const symMemo = new Map<QspSymbol, QspSymbol>();
    const shiftSymOnce = (sym: QspSymbol): QspSymbol => {
      let copied = symMemo.get(sym);
      if (!copied) { copied = shiftSym(sym); symMemo.set(sym, copied); }
      return copied;
    };
    for (const [key, sym] of source.variables) {
      copy.variables.set(key, shiftSymOnce(sym));
    }
    for (const sym of source.ownedVariables) {
      copy.ownedVariables.add(shiftSymOnce(sym));
    }

    shiftBucketMap(source.labels, copy.labels);
    shiftMap(source.locationRefs, copy.locationRefs);
    shiftBucketMap(source.labelRefs, copy.labelRefs);
    shiftMap(source.objectRefs, copy.objectRefs);
    shiftMap(source.actionRefs, copy.actionRefs);
    for (const loc of source.unreachableLabels) copy.unreachableLabels.push(shift(loc));
    for (const act of source.actions) copy.actions.push(shiftSym(act));
    for (const pw of source.prefixWarnings) {
      copy.prefixWarnings.push({ ...pw, loc: shift(pw.loc) });
    }
    for (const aw of source.argCountWarnings) {
      copy.argCountWarnings.push({ ...aw, loc: shift(aw.loc) });
    }
    for (const dw of source.deprecationWarnings) {
      copy.deprecationWarnings.push({ ...dw, loc: shift(dw.loc) });
    }
    for (const d of source.dynamicVarCalls) {
      copy.dynamicVarCalls.push({ ...d, loc: shift(d.loc) });
    }
    for (const d of source.untrackedDynamicVarCalls) {
      copy.untrackedDynamicVarCalls.push({ ...d, loc: shift(d.loc) });
    }
    for (const d of source.unresolvedDynamicVarCalls) {
      copy.unresolvedDynamicVarCalls.push({ ...d, loc: shift(d.loc) });
    }
    for (const d of source.resolvedDynamicBlocks) {
      copy.resolvedDynamicBlocks.push({
        kind: d.kind,
        callLoc: shift(d.callLoc),
        blockLocs: d.blockLocs.map(shift),
        argCount: d.argCount,
      });
    }

    const shiftBinding = (b: VariableBinding): VariableBinding => {
      const shifted: VariableBinding = { ...b, stmtLoc: shift(b.stmtLoc) };
      if (b.value.kind === 'code-block') {
        shifted.value = {
          kind: 'code-block',
          blockRange: shift(b.value.blockRange),
          bodyWrites: b.value.bodyWrites
            ? b.value.bodyWrites.map(w => ({
                varBaseName: w.varBaseName,
                binding: shiftBinding(w.binding),
              }))
            : undefined,
        };
      }
      return shifted;
    };
    for (const [k, v] of source.variableBindings) {
      copy.variableBindings.set(k, v.map(shiftBinding));
    }

    return copy;
  }
}
