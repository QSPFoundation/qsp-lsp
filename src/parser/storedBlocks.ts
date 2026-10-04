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
 */
import type Parser from 'web-tree-sitter';
import type { SymbolLocation } from './symbolTypes';
import type { LocationSymbols } from './locationSymbols';
import type { TargetPattern } from './targetPattern';
import { parentOf } from './blockTrees';
import { readVarRef } from './walkHelpers';

/** A `{…}` kept in variables: `$x = {…}`, `local $x = {…} + $y`. */
export interface StoredBlock {
  loc: SymbolLocation;
  /** Base names of the variables it is kept in, lower-case. */
  names: string[];
}

const VAR_REFS = new Set(['variable_ref', 'ml_variable_ref']);
const ASSIGNMENTS = new Set(['assignment_statement', 'local_statement']);

/**
 * The variables `block` is kept in, when it is (part of) the value of an
 * assignment: alone, in parentheses, or joined with `+`/`&`.
 */
export function storedNames(block: Parser.SyntaxNode): string[] | undefined {
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
  return names.length > 0 ? names : undefined;
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

/**
 * The words on the rest of each line of `text` after `dynamic` or
 * `dyneval`, lower-case: every variable such a line may run, in strings
 * and `exec:` links too. More words than variables only keeps more blocks
 * code, as every block was before.
 */
export function runWordsOf(text: string): string[] {
  RUNS.lastIndex = 0;
  if (!RUNS.test(text)) return [];
  const words = new Set<string>();
  RUNS.lastIndex = 0;
  for (let m = RUNS.exec(text); m; m = RUNS.exec(text)) {
    const end = text.indexOf('\n', m.index);
    const rest = text.slice(m.index + m[0].length, end < 0 ? text.length : end);
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
  /** A variable's key → the keys of variables whose values it takes. */
  from: Map<string, Set<string>>;
}

/** Empty {@link ValueFlows}. */
export function emptyValueFlows(): ValueFlows {
  return { roots: new Set(), from: new Map() };
}

/** Add what `locSyms` runs and how it passes values on to `flows`. */
export function addValueFlows(locSyms: LocationSymbols, flows: ValueFlows): void {
  const loc = locSyms.locationName.toLowerCase();
  for (const w of locSyms.runsVariables) flows.roots.add(keyOf(w, loc));
  if (locSyms.runsArgs.length > 0) flows.roots.add(argsOf(loc));
  const flow = (into: string, name: string) => {
    let set = flows.from.get(into);
    if (!set) flows.from.set(into, set = new Set());
    set.add(keyOf(name, loc));
  };
  for (const [name, bindings] of locSyms.variableBindings) {
    const into = keyOf(name, loc);
    for (const b of bindings) {
      if (b.value.kind === 'var-ref') flow(into, b.value.varBaseName);
      else if (b.value.kind === 'expr' && b.value.pattern) forEachVar(b.value.pattern, v => flow(into, v));
    }
  }
  for (const [target, ref] of locSyms.locationRefs) {
    for (const r of ref.references) {
      for (const p of r.argPatterns ?? []) if (p) forEachVar(p, v => flow(argsOf(target), v));
    }
  }
}

function forEachVar(pattern: TargetPattern, f: (name: string) => void): void {
  for (const part of pattern) {
    if ('var' in part) f(part.var);
    else if ('alt' in part) for (const a of part.alt) forEachVar(a, f);
  }
}

/** The keys of every variable whose value something may run: the roots and all that flows into them. */
export function runVariablesOf(flows: ValueFlows): Set<string> {
  const run = new Set(flows.roots);
  const queue = [...run];
  while (queue.length > 0) {
    for (const k of flows.from.get(queue.pop()!) ?? []) {
      if (!run.has(k)) {
        run.add(k);
        queue.push(k);
      }
    }
  }
  return run;
}

/**
 * Whether something may run `block`, kept in `locLower`. `result` is
 * always taken for code: what a function leaves in it goes wherever its
 * call is written. Without `run` (nothing worked out yet), every block is.
 */
export function storedBlockRuns(block: StoredBlock, locLower: string, run: ReadonlySet<string> | undefined): boolean {
  return !run || block.names.some(n => n === 'result' || run.has(keyOf(n, locLower)));
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
