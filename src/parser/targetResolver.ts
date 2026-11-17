// ── Target resolver ──────────────────────────────────────────────────
//
// Turns a target pattern (targetPattern.ts) into the strings it may
// stand for, from what the analysis knows of each variable's writes: a
// variable declared `local` in the location takes the values written
// there, any other one the values written to it anywhere in the project.
// `$a = $b` chains are followed, and a value built from other variables
// (`$next = 'room_' + n`) is resolved in the location that writes it.
// A variable written in the jump's own location before the jump takes
// the values of the nearest such writes, not every value it has anywhere:
// `$loc = 'forest'` then `gt $loc` goes to forest, however many other
// places set $loc. Going back from the jump, writes are taken until one
// indented no deeper than the jump statement, which runs whichever branch
// the others are in (so both arms of an `if` before the jump count). Only
// lines and indentation are looked at: a call in between that changes the
// variable is not seen.
// Without such a write, the nearest writes before each static jump or
// call into the location are taken instead (`$to = 'forest'` then
// `gt 'road'`, and `gt $to` in road), when any caller writes it; a caller
// that doesn't is looked through to its own callers, up to MAX_HOPS
// locations back (A writes $to and calls B, B calls C, C jumps to $to).
// Three variables are the game's own:
//   $curloc     the location the code is in (`$back = $curloc`, `gt $curloc`)
//   $args[N]    the Nth argument of the location's static call sites
//               (`gs 'go', 'hall'` → `gt $args[0]` in `go` may go to `hall`)
//   func('f')   what `f` puts in `result`
// Nothing is run: a value computed at run time is unknown, and so is
// anything past the limits below, which keep a game of 1500 locations
// with thousands of dynamic jumps cheap. A result marks each unknown
// piece with WILDCARD, says whether it is complete, and if not, why
// (for the statistics in the server log: never a game name).

import type { DocumentSymbols } from './symbolTable';
import type { LocationSymbols } from './locationSymbols';
import type { VariableBinding } from './symbolTypes';
import type { TargetPattern } from './targetPattern';
import { ARGS_VAR_NAME, RESULT_VAR_NAME } from './lookupTables';

/** Stands for an unknown piece in a resolved string. */
export const WILDCARD = '\u0001';

/** Possible strings of an expression. */
export interface Resolved {
  values: string[];
  /** False when the expression may also take values not in `values`. */
  complete: boolean;
  /** Why it is not complete, e.g. `no writes`, `call:mid`, `args: no static callers`. */
  reasons: string[];
}

// Values kept per variable, and strings per pattern: a jump with more
// possible targets than this says little about where it goes.
const MAX_VALUES = 50;
// How many variables deep a value is followed (`$a = $b`, `$b = 'x' + $c`, …).
const MAX_DEPTH = 4;
// Writes (or call sites, for $args) looked at per variable. A string
// variable shared by a whole game can be written thousands of times; the
// first ones give enough values.
const MAX_WRITES = 500;
// How many locations back callers are followed for a variable none of the
// nearer ones writes, and how many calls they may look at in all: a game
// whose locations all reach each other would otherwise walk all of it for
// every variable.
const MAX_HOPS = 3;
const MAX_CALLER_CALLS = 200;

interface Values {
  values: Set<string>;
  complete: boolean;
  reasons: Set<string>;
  /** Some value comes from `$curloc` somewhere along the way. */
  fromCurloc?: boolean;
}

/** What {@link TargetResolver.describe} tells about a variable; no names. */
export interface VariableSummary {
  /** Identifies the variable (for a local one, in its location); not for display. */
  key: string;
  /** Writes to it, or static calls for `$args`. */
  writes: number;
  /** Distinct values known, up to a little past the limit. */
  values: number;
  complete: boolean;
  fromCurloc: boolean;
}

/** Where a jump is: its target's 0-based line and column, and the column its statement starts at. */
export interface Position {
  line: number;
  column: number;
  indent?: number;
}

interface Call {
  loc: LocationSymbols;
  args: ReadonlyArray<TargetPattern | undefined> | undefined;
  /** Where the call is written in `loc`. */
  at: Position;
}

const CURLOC = 'curloc';

/** Resolves patterns against one project's symbols, caching per variable. */
export class TargetResolver {
  private readonly globals = new Map<string, Values>();
  private readonly locals = new WeakMap<LocationSymbols, Map<string, Values>>();
  // Locations by lowercase name, over every document.
  private readonly locationsByName = new Map<string, LocationSymbols>();
  // Static calls of each location (lowercase name); built on first use.
  private callers: Map<string, Call[]> | undefined;
  private readonly summaries = new Map<string, VariableSummary>();
  private readonly writeValues = new WeakMap<VariableBinding, Values>();
  // fromCallers per location and variable; null: no caller writes it.
  private readonly callerCache = new WeakMap<LocationSymbols, Map<string, Values | null>>();

  constructor(private readonly docs: readonly DocumentSymbols[]) {
    for (const doc of docs) {
      for (const [key, loc] of doc.locations) if (!this.locationsByName.has(key)) this.locationsByName.set(key, loc);
    }
  }

  /** The strings `pattern`, written in `loc` at `at` (0-based line and column), may stand for. */
  resolve(pattern: TargetPattern, loc: LocationSymbols, at?: Position): Resolved {
    const r = this.patternValues(pattern, loc, 0, new Set(), at);
    return { values: [...r.values], complete: r.complete, reasons: [...r.reasons] };
  }

  // `at`: where the pattern is written, for its variables' nearest writes;
  // only for the jump target itself, not for values followed elsewhere.
  private patternValues(pattern: TargetPattern, loc: LocationSymbols, depth: number, visiting: Set<string>, at?: Position): Values {
    const out = emptyValues();
    const sets: string[][] = [];
    for (const part of pattern) {
      if ('lit' in part) {
        sets.push([part.lit]);
      } else if ('any' in part) {
        sets.push([WILDCARD]);
        incomplete(out, part.why ?? 'unknown');
      } else if ('var' in part || 'result' in part) {
        let v: Values;
        if ('var' in part) {
          // Past MAX_DEPTH, or through callers beyond the jump's own location,
          // the walk would follow the game's calls round and round.
          const near = at && depth < MAX_DEPTH ? this.nearestWrites(part.var, loc, at) : undefined;
          if (near) {
            v = this.fromWrites(near, loc, depth, visiting);
          } else {
            v = (at && depth === 0 ? this.fromCallers(part.var, loc, depth, visiting) : undefined)
              ?? this.varValues(part.var, part.index, loc, depth + 1, visiting);
          }
        } else {
          const callee = this.locationsByName.get(part.result);
          v = callee ? this.varValues(RESULT_VAR_NAME, undefined, callee, depth + 1, visiting) : incomplete(emptyValues(), 'result: no such location');
        }
        absorbState(out, v);
        sets.push(v.values.size > 0 ? [...v.values] : [WILDCARD]);
      } else {
        const union = new Set<string>();
        for (const alt of part.alt) {
          const v = this.patternValues(alt, loc, depth, visiting, at);
          absorbState(out, v);
          for (const s of v.values) union.add(s);
        }
        sets.push([...union]);
      }
    }
    // Past MAX_VALUES combinations the largest piece becomes unknown.
    const product = () => sets.reduce((n, s) => n * s.length, 1);
    while (product() > MAX_VALUES) {
      let largest = 0;
      for (let i = 1; i < sets.length; i++) if (sets[i].length > sets[largest].length) largest = i;
      sets[largest] = [WILDCARD];
      incomplete(out, 'too many combinations');
    }
    let strings = [''];
    for (const set of sets) strings = strings.flatMap(prefix => set.map(s => joinWild(prefix, s)));
    for (const s of strings) out.values.add(s);
    return out;
  }

  private varValues(name: string, index: number | undefined, loc: LocationSymbols, depth: number, visiting: Set<string>): Values {
    if (name === CURLOC) return { values: new Set([loc.locationName]), complete: true, reasons: new Set(), fromCurloc: true };

    const args = name === ARGS_VAR_NAME;
    const own = loc.variableBindings.get(name);
    // `args` and `result` belong to one call of the location, like locals.
    const isLocal = args || name === RESULT_VAR_NAME || (own?.some(b => b.isLocal) ?? false);
    const cacheKey = args ? `${name}[${index ?? 0}]` : name;
    const key = isLocal ? `${loc.locationName}\u0000${cacheKey}` : cacheKey;
    const cache = isLocal ? this.localCache(loc) : this.globals;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    if (depth > MAX_DEPTH) return incomplete(emptyValues(), 'too deep');
    if (visiting.has(key)) return incomplete(emptyValues(), 'cycle');

    visiting.add(key);
    const out = emptyValues();
    if (args) {
      this.argValues(out, index ?? 0, loc, own, depth, visiting);
    } else {
      const writes: Array<{ binding: VariableBinding; loc: LocationSymbols }> = isLocal
        ? (own ?? []).map(binding => ({ binding, loc }))
        : this.globalWrites(name);
      if (writes.length === 0) incomplete(out, name === RESULT_VAR_NAME ? 'result: never set' : 'no writes');
      if (writes.length > MAX_WRITES) incomplete(out, 'too many writes');
      for (const { binding, loc: at } of writes.slice(0, MAX_WRITES)) {
        this.addBinding(out, binding, at, depth, visiting);
        if (out.values.size > MAX_VALUES) {
          incomplete(out, 'too many values');
          break;
        }
      }
    }
    visiting.delete(key);
    // Kept even when a cycle or the depth cut it short: it says it is
    // incomplete then, and working it out again for every jump that
    // reads the variable is what made mutually built strings exponential.
    cache.set(cacheKey, out);
    return out;
  }

  // $args[i]: the ith argument at each static call of `loc`, resolved where
  // the call is written. A write to args inside the location counts too.
  private argValues(out: Values, i: number, loc: LocationSymbols, own: VariableBinding[] | undefined, depth: number, visiting: Set<string>): void {
    const calls = this.callsOf(loc.locationName.toLowerCase());
    if (calls.length === 0) incomplete(out, 'args: no static callers');
    if (calls.length > MAX_WRITES) incomplete(out, 'too many writes');
    for (const call of calls.slice(0, MAX_WRITES)) {
      const p = call.args?.[i];
      if (!p) {
        incomplete(out, 'args: unknown at a call');
        continue;
      }
      absorb(out, this.patternValues(p, call.loc, depth, visiting));
      if (out.values.size > MAX_VALUES) {
        incomplete(out, 'too many values');
        break;
      }
    }
    for (const b of own ?? []) this.addBinding(out, b, loc, depth, visiting);
  }

  // The value-bearing writes of `name` in `loc` that may be the last one
  // before `at` (see the top of the file), or undefined when there are
  // none. Not for $args, $result, $curloc.
  private nearestWrites(name: string, loc: LocationSymbols, at: Position): VariableBinding[] | undefined {
    if (name === ARGS_VAR_NAME || name === RESULT_VAR_NAME || name === CURLOC) return undefined;
    const own = loc.variableBindings.get(name);
    if (!own) return undefined;
    const before = own
      .filter(b => b.isValueBearing && (b.stmtLoc.line < at.line || (b.stmtLoc.line === at.line && b.stmtLoc.column < at.column)))
      .sort((a, b) => b.stmtLoc.line - a.stmtLoc.line || b.stmtLoc.column - a.stmtLoc.column);
    if (before.length === 0) return undefined;
    const indent = at.indent ?? at.column;
    const out: VariableBinding[] = [];
    for (const b of before) {
      out.push(b);
      // On the jump's own line, or no deeper than it: always runs before it.
      if (b.stmtLoc.line === at.line || b.stmtLoc.column <= indent) break;
    }
    return out;
  }

  // The values of nearest writes, each read from where it is written
  // (`$a = $b` or `$a = 'room_' + n` there follows the same rule).
  // Each write's values depend on the write alone, and many jumps and
  // calls in a location share the same nearest writes: kept per write.
  private fromWrites(writes: VariableBinding[], loc: LocationSymbols, depth: number, visiting: Set<string>): Values {
    const v = emptyValues();
    for (const b of writes) {
      let own = this.writeValues.get(b);
      if (!own) {
        own = emptyValues();
        this.addBinding(own, b, loc, depth + 1, visiting, { line: b.stmtLoc.line, column: b.stmtLoc.column, indent: b.stmtLoc.column });
        this.writeValues.set(b, own);
      }
      absorb(v, own);
    }
    return v;
  }

  // `name` as it is where `loc` is jumped to or called from: the nearest
  // write before each static call (`$to = 'forest'` then `gt 'road'`, and
  // `gt $to` in road). A caller that doesn't write it before the call is
  // looked through to its callers, breadth first, each location once and
  // MAX_HOPS back at most (a loop, not recursion: the call graph of a large
  // game is deep). Undefined when no caller writes it, and for a variable
  // local to `loc`; a call nobody is found to write it before makes the
  // result incomplete.
  private fromCallers(name: string, loc: LocationSymbols, depth: number, visiting: Set<string>): Values | undefined {
    if (name === ARGS_VAR_NAME || name === RESULT_VAR_NAME || name === CURLOC) return undefined;
    if (isLocalIn(loc, name)) return undefined;
    let cache = this.callerCache.get(loc);
    if (!cache) this.callerCache.set(loc, cache = new Map());
    const cached = cache.get(name);
    if (cached !== undefined) return cached ?? undefined;
    const out = emptyValues();
    let found = false;
    const seen = new Set<LocationSymbols>([loc]);
    let frontier = [loc];
    let budget = MAX_CALLER_CALLS;
    for (let hop = 1; hop <= MAX_HOPS && frontier.length > 0; hop++) {
      const next: LocationSymbols[] = [];
      for (const target of frontier) {
        const calls = this.callsOf(target.locationName.toLowerCase());
        // A caller looked through that nothing calls: it may be the start,
        // or reached by a dynamic jump, with the variable anything.
        if (target !== loc && !calls.some(c => c.loc !== target)) incomplete(out, 'callers: not written before a call');
        if (calls.length > MAX_WRITES) incomplete(out, 'too many writes');
        for (const call of calls.slice(0, MAX_WRITES)) {
          if (call.loc === target) continue;
          if (--budget < 0) {
            incomplete(out, 'callers: too many');
            break;
          }
          const near = this.nearestWrites(name, call.loc, call.at);
          if (near) {
            found = true;
            absorb(out, this.fromWrites(near, call.loc, depth, visiting));
          } else if (hop === MAX_HOPS || isLocalIn(call.loc, name)) {
            // Too far back, or a local there hides the variable from its callers.
            incomplete(out, 'callers: not written before a call');
          } else if (!seen.has(call.loc)) {
            seen.add(call.loc);
            next.push(call.loc);
          }
          if (out.values.size > MAX_VALUES) {
            incomplete(out, 'too many values');
            break;
          }
        }
        if (budget < 0 || out.values.size > MAX_VALUES) break;
      }
      if (budget < 0 || out.values.size > MAX_VALUES) break;
      frontier = next;
    }
    cache.set(name, found ? out : null);
    return found ? out : undefined;
  }

  /** A summary of the variable `name` as read in `loc`, for statistics. */
  describe(name: string, index: number | undefined, loc: LocationSymbols): VariableSummary {
    const own = loc.variableBindings.get(name);
    const args = name === ARGS_VAR_NAME;
    const isLocal = args || name === RESULT_VAR_NAME || (own?.some(b => b.isLocal) ?? false);
    const cacheKey = args ? `${name}[${index ?? 0}]` : name;
    const key = isLocal ? `${loc.locationName}\u0000${cacheKey}` : cacheKey;
    const known = this.summaries.get(key);
    if (known) return known;
    const v = this.varValues(name, index, loc, 1, new Set());
    const writes = args ? this.callsOf(loc.locationName.toLowerCase()).length
      : isLocal ? own?.length ?? 0
        : this.globalWrites(name).length;
    const summary = { key, writes, values: v.values.size, complete: v.complete, fromCurloc: v.fromCurloc ?? false };
    this.summaries.set(key, summary);
    return summary;
  }

  private callsOf(target: string): Call[] {
    if (!this.callers) {
      const callers = new Map<string, Call[]>();
      for (const doc of this.docs) {
        for (const loc of doc.locations.values()) {
          for (const [to, ref] of loc.locationRefs) {
            for (const r of ref.references) {
              if (!r.callType) continue;
              let list = callers.get(to);
              if (!list) callers.set(to, list = []);
              list.push({ loc, args: r.argPatterns, at: { line: r.line, column: r.column } });
            }
          }
        }
      }
      this.callers = callers;
    }
    return this.callers.get(target) ?? [];
  }

  // `pos`: where `b` is written, when its own variables are to be read
  // from their nearest writes before it.
  private addBinding(out: Values, b: VariableBinding, at: LocationSymbols, depth: number, visiting: Set<string>, pos?: Position): void {
    if (!b.isValueBearing) return;
    const v = b.value;
    if (v.kind === 'var-ref') {
      const near = pos && depth < MAX_DEPTH ? this.nearestWrites(v.varBaseName, at, pos) : undefined;
      if (near) for (const w of near) this.addBinding(out, w, at, depth + 1, visiting, { line: w.stmtLoc.line, column: w.stmtLoc.column, indent: w.stmtLoc.column });
      else absorb(out, this.varValues(v.varBaseName, undefined, at, depth + 1, visiting));
    } else if (v.kind === 'expr' && v.pattern && !b.compoundOp) {
      absorb(out, this.patternValues(v.pattern, at, depth, visiting, pos));
    } else {
      incomplete(out, b.compoundOp ? 'compound write' : v.kind === 'code-block' ? 'code block' : 'opaque write');
    }
  }

  private globalWrites(name: string): Array<{ binding: VariableBinding; loc: LocationSymbols }> {
    const out: Array<{ binding: VariableBinding; loc: LocationSymbols }> = [];
    for (const doc of this.docs) {
      for (const e of doc.globalBindings.get(name) ?? []) {
        const loc = doc.locations.get(e.locationName.toLowerCase()) ?? this.locationsByName.get(e.locationName.toLowerCase());
        if (loc) out.push({ binding: e.binding, loc });
      }
    }
    return out;
  }

  private localCache(loc: LocationSymbols): Map<string, Values> {
    let m = this.locals.get(loc);
    if (!m) this.locals.set(loc, m = new Map());
    return m;
  }
}

function isLocalIn(loc: LocationSymbols, name: string): boolean {
  return loc.variableBindings.get(name)?.some(b => b.isLocal) ?? false;
}

function emptyValues(): Values {
  return { values: new Set(), complete: true, reasons: new Set() };
}

function incomplete(out: Values, reason: string): Values {
  out.complete = false;
  out.reasons.add(reason);
  return out;
}

// Take `v`'s completeness and reasons, not its values.
function absorbState(out: Values, v: Values): void {
  if (!v.complete) out.complete = false;
  if (v.fromCurloc) out.fromCurloc = true;
  for (const r of v.reasons) out.reasons.add(r);
}

function absorb(out: Values, v: Values): void {
  absorbState(out, v);
  for (const s of v.values) out.values.add(s);
}

function joinWild(a: string, b: string): string {
  return a.endsWith(WILDCARD) && b.startsWith(WILDCARD) ? a + b.slice(1) : a + b;
}

/**
 * A matcher for the lowercase names a resolved string with wildcards
 * stands for; undefined when it is all wildcard and would match anything.
 */
export function wildcardMatcher(value: string): RegExp | undefined {
  const pieces = value.toLowerCase().split(WILDCARD);
  if (pieces.every(p => p.trim() === '')) return undefined;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pieces.map(escape).join('.*')}$`, 's');
}
