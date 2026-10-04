/**
 * `{…}` blocks kept in variables, and the variables something may run.
 *
 * `$x = {generic}` keeps a string: code only if something runs `$x`
 * (`dynamic $x`, or a copy of it, or the location it is passed to). A
 * location records the blocks it keeps and the words its `dynamic` and
 * `dyneval` lines name; which variables run is worked out over every
 * location in the aggregates (`runVariablesOf`), following how values
 * pass from variable to variable: assignments (`variableBindings`) and
 * arguments of calls (`argPatterns`, into the callee's `args`).
 *
 * An element run under a key written out (`dynamic $args['k']`) runs only
 * the blocks kept under that key: `$args['temp']` is another element.
 */
import type Parser from 'web-tree-sitter';
import type { SymbolLocation } from './symbolTypes';
import type { LocationSymbols } from './locationSymbols';
import { targetPatternOf, type TargetPattern } from './targetPattern';
import { parentOf } from './blockTrees';
import { readVarRef } from './walkHelpers';

/** A `{…}` kept in variables: `$x = {…}`, `local $x = {…} + $y`. */
export interface StoredBlock {
  loc: SymbolLocation;
  /** Base names of the variables it is kept in, lower-case. */
  names: string[];
  /**
   * The element it is kept in, when there is one variable and its index
   * says something (see {@link sameElement}); undefined when it may be any.
   */
  key?: string;
}

const VAR_REFS = new Set(['variable_ref', 'ml_variable_ref']);
const ASSIGNMENTS = new Set(['assignment_statement', 'local_statement']);

/**
 * The variables `block` is kept in, when it is (part of) the value of an
 * assignment: alone, in parentheses, or joined with `+`/`&`.
 */
export function storedIn(block: Parser.SyntaxNode): { names: string[]; key?: string } | undefined {
  let node = block;
  let parent = parentOf(node);
  while (parent && (parent.type === 'paren_expr' || (parent.type.endsWith('_binary') && joinsText(parent)))) {
    node = parent;
    parent = parentOf(parent);
  }
  if (!parent || !ASSIGNMENTS.has(parent.type)) return undefined;
  const values = parent.childrenForFieldName('value');
  const i = values.findIndex(v => v.id === node.id);
  if (i < 0) return undefined;
  const vars = parent.childForFieldName('variables')?.namedChildren.filter(v => VAR_REFS.has(v.type)) ?? [];
  // `a, b = {x}, {y}` keeps each value in its own variable.
  const holders = vars.length === values.length ? [vars[i]] : vars;
  const names = holders.map(v => readVarRef(v)?.name.toLowerCase()).filter((n): n is string => !!n);
  if (names.length === 0) return undefined;
  return holders.length === 1 ? { names, key: elementKey(holders[0]) } : { names };
}

// Element keys, as {@link sameElement} compares them: `#3` an index,
// `'text` a string key, `^text` a string key that starts with `text` and
// goes on with something worked out (`'temp_<<$i>>'`). String keys are
// compared ignoring case, which can only take more blocks for code.
function elementKey(ref: Parser.SyntaxNode): string | undefined {
  const index = ref.childForFieldName('index')?.namedChild(0);
  // `$x = …` is `$x[0] = …`.
  if (!index) return '#0';
  if (index.type === 'number_literal') return `#${Number(index.text)}`;
  const pattern = targetPatternOf(index);
  const first = pattern?.[0];
  if (!first || !('lit' in first)) return undefined;
  return (pattern!.length === 1 ? "'" : '^') + first.lit.toLowerCase();
}

/** Whether a block kept under `kept` (undefined: any) may be the element run under `run`. */
export function sameElement(kept: string | undefined, run: string): boolean {
  if (kept === undefined) return true;
  if (kept[0] === '#' || run[0] === '#') return kept === run;
  const a = kept.slice(1), b = run.slice(1);
  if (kept[0] === "'" && run[0] === "'") return a === b;
  if (kept[0] === "'") return a.startsWith(b);
  if (run[0] === "'") return b.startsWith(a);
  return a.startsWith(b) || b.startsWith(a);
}

function joinsText(binary: Parser.SyntaxNode): boolean {
  for (const child of binary.namedChildren) {
    if (child.type === 'op_amp') return true;
    if (child.type === 'op_arith') return child.text.trim() === '+';
    if (child.type.startsWith('op_')) return false;
  }
  return false;
}

const RUNS = /dyn(?:amic|eval)/gi;
// QSP names as the grammar's `identifier_text` reads them.
const WORD = /[^\s&'"()[\]=!<>+\-/*:,{}@0-9#$%][^\s&'"()[\]=!<>+\-/*:,{}]*/g;
// The code run, when it is one element under a key written out:
// `dynamic $args['k']`, `dyneval($h[2], …)`. A doubled quote in the key
// falls back to running the whole variable.
const ELEMENT = /^\s*\(?\s*[$#%]?([^\s&'"()[\]=!<>+\-/*:,{}@0-9#$%][^\s&'"()[\]=!<>+\-/*:,{}]*)\s*\[\s*(?:'([^']*)'(?!')|"([^"]*)"(?!")|(\d+))\s*\]/;
/** Joins a variable's name and the key of the element run: `args` + KEYED + `'k`. */
export const KEYED = '\u0002';

/**
 * The words on the rest of each line of `text` after `dynamic` or
 * `dyneval`, lower-case: every variable such a line may run, in strings
 * and `exec:` links too. More words than variables only keeps more blocks
 * code, as every block was before. An element run under a key written
 * out is the name, {@link KEYED} and the key.
 */
export function runWordsOf(text: string): string[] {
  RUNS.lastIndex = 0;
  if (!RUNS.test(text)) return [];
  const words = new Set<string>();
  RUNS.lastIndex = 0;
  for (let m = RUNS.exec(text); m; m = RUNS.exec(text)) {
    const end = text.indexOf('\n', m.index);
    let rest = text.slice(m.index + m[0].length, end < 0 ? text.length : end);
    const element = ELEMENT.exec(rest);
    if (element) {
      const [whole, name, single, double, index] = element;
      const s = single ?? double;
      const key = s === undefined ? `#${Number(index)}`
        : s.includes('<<') ? `^${s.slice(0, s.indexOf('<<')).toLowerCase()}` : `'${s.toLowerCase()}`;
      words.add(`${name.toLowerCase()}${KEYED}${key}`);
      rest = rest.slice(whole.length);
    }
    for (const w of rest.match(WORD) ?? []) words.add(w.toLowerCase());
  }
  return [...words];
}

// `args` is a location's own: its key names the location.
const argsOf = (locLower: string) => `args\0${locLower}`;
const keyOf = (name: string, locLower: string) => (name === 'args' ? argsOf(locLower) : name);

/** Where the values of variables go: who runs and what flows into what. Built by {@link addValueFlows}. */
export interface ValueFlows {
  /** Variables something runs (`args` as the key of its location). */
  roots: Set<string>;
  /** A variable's key → the keys of variables whose values it takes, into any of its elements. */
  from: Map<string, Set<string>>;
  /**
   * The same, into one element: the arguments of a call, each into its
   * `$args[N]` of the callee (`#N`, see {@link sameElement}).
   */
  intoElement: Map<string, Array<{ from: string; key: string }>>;
}

/** Empty {@link ValueFlows}. */
export function emptyValueFlows(): ValueFlows {
  return { roots: new Set(), from: new Map(), intoElement: new Map() };
}

/** Add what `locSyms` runs and how it passes values on to `flows`. */
export function addValueFlows(locSyms: LocationSymbols, flows: ValueFlows): void {
  const loc = locSyms.locationName.toLowerCase();
  for (const w of locSyms.runsVariables) {
    const at = w.indexOf(KEYED);
    flows.roots.add(at < 0 ? keyOf(w, loc) : keyOf(w.slice(0, at), loc) + w.slice(at));
  }
  // `runsArgs` adds nothing: its `dynamic $args…` lines are in
  // `runsVariables`, with the keys it doesn't keep.
  // `element`: the one `into` takes the value in; `read`: the one of `name` it is taken from.
  const flow = (into: string, name: string, element?: string, read?: string) => {
    const from = keyOf(name, loc) + (read === undefined ? '' : KEYED + read);
    if (element === undefined) {
      let set = flows.from.get(into);
      if (!set) flows.from.set(into, set = new Set());
      set.add(from);
    } else {
      let list = flows.intoElement.get(into);
      if (!list) flows.intoElement.set(into, list = []);
      if (!list.some(e => e.from === from && e.key === element)) list.push({ from, key: element });
    }
  };
  for (const [name, bindings] of locSyms.variableBindings) {
    const into = keyOf(name, loc);
    for (const b of bindings) {
      if (b.value.kind === 'var-ref') flow(into, b.value.varBaseName);
      else if (b.value.kind === 'expr' && b.value.pattern) forEachVar(b.value.pattern, (v, read) => flow(into, v, undefined, read));
    }
  }
  for (const [target, ref] of locSyms.locationRefs) {
    for (const r of ref.references) {
      r.argPatterns?.forEach((p, i) => p && forEachVar(p, (v, read) => flow(argsOf(target), v, `#${i}`, read)));
    }
  }
}

// Each variable read in `pattern`, with the element read when its key is written out.
function forEachVar(pattern: TargetPattern, f: (name: string, element?: string) => void): void {
  for (const part of pattern) {
    if ('var' in part) f(part.var, part.index !== undefined ? `#${part.index}` : part.key);
    else if ('alt' in part) for (const a of part.alt) forEachVar(a, f);
  }
}

// The variable of a root: itself, or the one an element of it is run from.
const variableOf = (root: string) => {
  const at = root.indexOf(KEYED);
  return at < 0 ? root : root.slice(0, at);
};

// The variables whose values may reach `node`: a variable, or an element
// run under a key (then only what goes into that element or any).
function* sourcesOf(flows: ValueFlows, node: string): Generator<string> {
  const variable = variableOf(node);
  const key = node === variable ? undefined : node.slice(variable.length + KEYED.length);
  yield* flows.from.get(variable) ?? [];
  for (const e of flows.intoElement.get(variable) ?? []) {
    if (key === undefined || sameElement(e.key, key)) yield e.from;
  }
}

/**
 * The keys of every variable whose value something may run: the roots and
 * all that flows into them. An element run or read under a key written
 * out is there as the name, KEYED and the key, with the name and KEYED
 * alone beside it, so {@link storedBlockRuns} knows when to look for one.
 */
export function runVariablesOf(flows: ValueFlows): Set<string> {
  const run = new Set<string>();
  const queue: string[] = [];
  const add = (k: string) => {
    if (run.has(k)) return;
    run.add(k);
    if (k.includes(KEYED)) run.add(variableOf(k) + KEYED);
    queue.push(k);
  };
  for (const r of flows.roots) add(r);
  while (queue.length > 0) {
    for (const k of sourcesOf(flows, queue.pop()!)) add(k);
  }
  return run;
}

/**
 * Whether something may run `block`, kept in `locLower`. `result` is
 * always taken for code: what a function leaves in it goes wherever its
 * call is written. Without `run` (nothing worked out yet), every block is.
 */
export function storedBlockRuns(block: StoredBlock, locLower: string, run: ReadonlySet<string> | undefined): boolean {
  if (!run) return true;
  return block.names.some(n => {
    if (n === 'result') return true;
    const k = keyOf(n, locLower);
    if (run.has(k)) return true;
    const keyed = k + KEYED;
    if (!run.has(keyed)) return false;
    for (const r of run) {
      if (r.length > keyed.length && r.startsWith(keyed) && sameElement(block.key, r.slice(keyed.length))) return true;
    }
    return false;
  });
}

/** The blocks `locations` keep in variables that nothing runs: text (see {@link storedBlockRuns}). */
export function textStoredBlocks(locations: Iterable<LocationSymbols>, run: ReadonlySet<string> | undefined): SymbolLocation[] {
  const text: SymbolLocation[] = [];
  if (!run) return text;
  for (const locSyms of locations) {
    const loc = locSyms.locationName.toLowerCase();
    for (const b of locSyms.storedBlocks) if (!storedBlockRuns(b, loc, run)) text.push(b.loc);
  }
  return text;
}
