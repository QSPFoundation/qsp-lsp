/**
 * Symbol table for QSP semantic analysis.
 * Tracks variables, labels, and location references for
 * go-to-definition, find-references, and rename.
 *
 * This module is the public facade — types come from `symbolTypes`,
 * `LocationSymbols` from `locationSymbols`, and `DocumentSymbols`
 * is defined here.
 */


import { QspSymbolKind, type SymbolLocation, type QspSymbol, type GlobalBindingEntry } from './symbolTypes';
import { LocationSymbols } from './locationSymbols';

// ── Re-export everything for backward compatibility ──────────────────
export {
  type SymbolLocation,
  type QspSymbol,
  QspSymbolKind,
  type TypePrefix,
  type CompoundOp,
  COMPOUND_OPS,
  type BindingValue,
  type VariableBinding,
  type PrefixWarning,
  type ArgCountWarning,
  type DeprecationWarning,
  type GlobalBindingEntry,
} from './symbolTypes';
export { LocationSymbols } from './locationSymbols';

// ── DocumentSymbols ───────────────────────────────────────────────────

/**
 * Global symbol table across all locations in a document.
 */
export class DocumentSymbols {
  public readonly uri: string;
  public readonly locations = new Map<string, LocationSymbols>();
  public readonly locationDefs = new Map<string, QspSymbol>();
  /**
   * Document-wide index of NON-LOCAL (global) variable bindings.
   * Keyed by lowercased BASE name (no `$/#/%` prefix); each entry
   * carries the owning location's name alongside the binding site.
   * Populated after all locations have been extracted (or reused
   * from a prior analysis).  See `LocationSymbols.variableBindings`
   * for the rationale behind base-only keying.
   *
   * Consumers use this to answer "what values can `$foo` hold?"
   * across the entire document — hover, possible-values,
   * constant-fold diagnostics, etc.  Local bindings are deliberately
   * excluded: they're scope-limited and answered via
   * `LocationSymbols.variableBindings` at a specific site.
   */
  public readonly globalBindings = new Map<string, GlobalBindingEntry[]>();

  constructor(uri: string) {
    this.uri = uri;
  }

  /**
   * Rebuild the document-wide global-bindings index from the current
   * per-location `variableBindings` stores.  Call after finishing
   * extractSymbols (or after any change that invalidates the index).
   * O(total bindings) — negligible relative to parse cost.
   */
  rebuildGlobalBindings(): void {
    this.globalBindings.clear();
    for (const [, locSyms] of this.locations) {
      for (const [baseName, bindings] of locSyms.variableBindings) {
        for (const b of bindings) {
          if (b.isLocal) continue;
          let arr = this.globalBindings.get(baseName);
          if (!arr) { arr = []; this.globalBindings.set(baseName, arr); }
          arr.push({ locationName: locSyms.locationName, binding: b });
        }
      }
    }
  }

  addLocation(name: string, loc: SymbolLocation): LocationSymbols {
    const key = name.toLowerCase();
    const locSymbols = new LocationSymbols(name);
    this.locations.set(key, locSymbols);

    this.locationDefs.set(key, {
      name,
      nameLower: key,
      kind: QspSymbolKind.Location,
      definition: loc,
      references: [loc],
      isLocal: false,
    });

    return locSymbols;
  }

  /**
   * Add a location whose symbols are reused from a previous analysis
   * (unchanged location block).  Applies a line shift if the block moved.
   */
  addLocationFrom(
    name: string,
    loc: SymbolLocation,
    source: LocationSymbols,
    lineShift: number,
  ): void {
    const key = name.toLowerCase();
    const locSymbols = LocationSymbols.copyWithLineShift(source, lineShift);
    this.locations.set(key, locSymbols);
    this.locationDefs.set(key, {
      name,
      nameLower: key,
      kind: QspSymbolKind.Location,
      definition: loc,
      references: [loc],
      isLocal: false,
    });
  }

  getLocation(name: string): LocationSymbols | undefined {
    return this.locations.get(name.toLowerCase());
  }

  /**
   * Find all references to a variable across the document.
   * Local variables: only within their declaring location (when
   * `locationName` is given).  Global variables: across all locations.
   *
   * When `exactSymbol` is provided, only references belonging to that
   * specific QspSymbol are returned (identity comparison).  This is
   * essential for shadowed locals where multiple scoped symbols share
   * the same base name.
   *
   * Public utility API — used by tests and available for consumers
   * of `DocumentSymbols` that need cross-location variable lookup.
   */
  findVariableReferences(name: string, locationName?: string, exactSymbol?: QspSymbol): SymbolLocation[] {
    const key = name.toLowerCase();
    const refs: SymbolLocation[] = [];

    for (const [, locSyms] of this.locations) {
      for (const sym of locSyms.findAllVariables(key)) {
        if (exactSymbol && sym !== exactSymbol) continue;
        // Local variables are scoped to their declaring location
        if (sym.isLocal && locationName && locSyms.locationName !== locationName) continue;
        refs.push(...sym.references);
      }
    }

    return refs;
  }

  /**
   * Find all references to a label (definition + jump sites) within a
   * location.  Pass `namespace` to restrict results to one label
   * namespace bucket (the value returned alongside the cursor by
   * `findSymbolAtPosition`, or `0` for the location root).  Without
   * `namespace`, results across all namespaces sharing the name are
   * returned — used by find-all-references when the cursor is outside
   * any tracked label range.
   */
  findLabelReferences(
    name: string,
    locationName: string,
    namespace?: number,
  ): SymbolLocation[] {
    const lower = name.toLowerCase();
    const refs: SymbolLocation[] = [];

    const locSyms = this.getLocation(locationName);
    if (!locSyms) return refs;

    if (namespace !== undefined) {
      const def = locSyms.labels.get(namespace)?.get(lower);
      if (def) refs.push(...def.references);
      const ref = locSyms.labelRefs.get(namespace)?.get(lower);
      if (ref) refs.push(...ref.references);
      return refs;
    }

    for (const [, bucket] of locSyms.labels) {
      const def = bucket.get(lower);
      if (def) refs.push(...def.references);
    }
    for (const [, bucket] of locSyms.labelRefs) {
      const ref = bucket.get(lower);
      if (ref) refs.push(...ref.references);
    }

    return refs;
  }

  /**
   * Find all location references (gosub, goto, func calls).
   */
  findLocationReferences(name: string): SymbolLocation[] {
    const lower = name.toLowerCase();
    const refs: SymbolLocation[] = [];

    // The definition itself
    const def = this.locationDefs.get(lower);
    if (def?.definition) {
      refs.push(def.definition);
    }

    // All references from within locations (O(1) per location)
    for (const [, locSyms] of this.locations) {
      const ref = locSyms.locationRefs.get(lower);
      if (ref) refs.push(...ref.references);
    }

    return refs;
  }

  /**
   * Find all object references (addobj, delobj, modobj, obj operator, etc.).
   * Case-insensitive but space-sensitive.
   */
  findObjectReferences(name: string): SymbolLocation[] {
    const lower = name.toLowerCase();
    const refs: SymbolLocation[] = [];

    for (const [, locSyms] of this.locations) {
      const ref = locSyms.objectRefs.get(lower);
      if (ref) refs.push(...ref.references);
    }

    return refs;
  }

  /**
   * Find all action references (act definitions + delact statements).
   * Case-insensitive but space-sensitive.
   */
  findActionReferences(name: string): SymbolLocation[] {
    const lower = name.toLowerCase();
    const refs: SymbolLocation[] = [];

    for (const [, locSyms] of this.locations) {
      // act definitions
      for (const act of locSyms.actions) {
        if (act.nameLower === lower && act.definition) {
          refs.push(act.definition);
        }
      }
      // delact / del act references (O(1) Map lookup)
      const ref = locSyms.actionRefs.get(lower);
      if (ref) refs.push(...ref.references);
    }

    return refs;
  }

  /**
   * Find the symbol whose tracked range contains the given position.
   * Returns the symbol kind, name, and (for labels) the `scopeId`
   * field carrying the label-namespace bucket key — callers can pass
   * that directly to `getLabel`/`getLabelRef`/`findLabelReferences`
   * without a second
   * scan.  Returns null if no symbol covers that position.
   *
   * This enables rename/references for names inside string literals
   * (actions, objects) where word-based lookup doesn't work.
   *
   * @param locationName When provided, search only this location's symbols
   *   (plus global locationDefs) for O(S) instead of O(L×S) overall.
   */
  findSymbolAtPosition(
    line: number,
    column: number,
    locationName?: string,
  ): { kind: QspSymbolKind; name: string; scopeId?: number } | null {
    // Helper: check if position is inside a SymbolLocation range
    function contains(loc: SymbolLocation): boolean {
      if (line < loc.line || line > loc.endLine) return false;
      if (line === loc.line && column < loc.column) return false;
      if (line === loc.endLine && column > loc.endColumn) return false;
      return true;
    }

    // Location definitions (in # header) — always global
    for (const [, def] of this.locationDefs) {
      if (def.definition && contains(def.definition)) {
        return { kind: QspSymbolKind.Location, name: def.name };
      }
    }

    // Search symbols within locations (scoped if locationName provided)
    const searchLocs: LocationSymbols[] = [];
    if (locationName) {
      const loc = this.getLocation(locationName);
      if (loc) searchLocs.push(loc);
    } else {
      for (const [, loc] of this.locations) searchLocs.push(loc);
    }

    for (const locSyms of searchLocs) {
      // Label definitions — iterate every namespace bucket so duplicate
      // names defined in distinct acts/code-blocks each remain locatable.
      for (const label of locSyms.allLabelSymbols()) {
        for (const r of label.references) {
          if (contains(r)) return {
            kind: QspSymbolKind.Label, name: label.name, scopeId: r.scopeId ?? 0,
          };
        }
      }

      // Action definitions
      for (const act of locSyms.actions) {
        if (act.definition && contains(act.definition)) {
          return { kind: QspSymbolKind.Action, name: act.name };
        }
      }

      // Label refs (`jump`) — bucketed by namespace root.
      for (const ref of locSyms.allLabelRefSymbols()) {
        for (const r of ref.references) {
          if (contains(r)) return {
            kind: QspSymbolKind.Label, name: ref.name, scopeId: r.scopeId ?? 0,
          };
        }
      }

      // Other ref maps: actions, objects, locations.
      for (const [map, kind] of [
        [locSyms.actionRefs,   QspSymbolKind.Action],
        [locSyms.objectRefs,   QspSymbolKind.Object],
        [locSyms.locationRefs, QspSymbolKind.Location],
      ] as [Map<string, QspSymbol>, QspSymbolKind][]) {
        for (const [, ref] of map) {
          for (const r of ref.references) {
            if (contains(r)) return { kind, name: ref.name };
          }
        }
      }
    }

    return null;
  }
}
