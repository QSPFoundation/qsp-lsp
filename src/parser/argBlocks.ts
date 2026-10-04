/**
 * `{…}` blocks passed as arguments, and the arguments a location runs.
 *
 * A block passed to a call (`gs 'list', {apple}`, `dynamic $code, 1,
 * {apple}`) is a string the callee gets as `$args[N]`: code only if the
 * callee runs it (`dynamic $args[N]`). Which callee runs which argument
 * is known only once every location is analysed, so a location records
 * both sides here and the server decides (see `argBlockRuns`).
 */
import type Parser from 'web-tree-sitter';
import type { SymbolLocation } from './symbolTypes';
import type { LocationSymbols } from './locationSymbols';
import { descendantsOfType, parentOf } from './blockTrees';
import { nodeLoc } from './walkHelpers';
import { runWordsOf, storedIn } from './storedBlocks';

/** A `{…}` passed as an argument: the callee gets it as `$args[index]`. */
export interface ArgBlock {
  loc: SymbolLocation;
  index: number;
  /** The location called, lower-case, when its name is written out; undefined for `dynamic`/`dyneval` and a computed name. */
  target?: string;
  /** Passed to a `dynamic {…}`/`dyneval({…})` whose own code runs `$args[index]`. */
  runHere?: boolean;
}

/** The index a callee runs every argument with: `dynamic $args[i]`. */
export const ANY_ARG = -1;

// Statements and functions whose first argument names the location called.
const LOCATION_CALLS = new Set(['gs', 'gosub', 'gt', 'goto', 'xgt', 'xgoto', 'func']);
const RUNS = new Set(['dynamic', 'dyneval']);
const CALLS = new Set(['statement', 'na_func_call', 'ext_func_call', 'ml_func_call']);
const USER_CALLS = new Set(['user_func_call', 'ml_user_func_call', 'user_call_statement']);
const META = new Set(['statement_name', 'function_name', 'user_name', 'type_prefix']);
const CALL_TYPES = [...CALLS, ...USER_CALLS];
// `dynamic $args…`, `dyneval($args…`: a location that has none runs no argument.
const RUNS_ARGS = /dyn(?:amic|eval)[\s(]*[$#%]?args\b/i;

/**
 * Record in `locSymbols` the blocks `locBlock` passes as arguments and the
 * arguments it runs; and the blocks it keeps in variables and the variables
 * it may run (storedBlocks.ts), found in the same walk over its blocks.
 */
export function collectArgBlocks(locBlock: Parser.SyntaxNode, locSymbols: LocationSymbols, docUri: string): void {
  // Most locations hold neither: looking at the text first spares
  // creating a node for every call, seconds on a large game.
  const text = locBlock.text;
  if (text.includes('{')) {
    for (const block of descendantsOfType(locBlock, 'code_block')) {
      const parent = parentOf(block);
      const node = parent?.type === 'paren_args' ? parentOf(parent) : parent;
      const call = node && callOf(node);
      if (!call) {
        const stored = storedIn(block);
        if (stored) locSymbols.storedBlocks.push({ loc: nodeLoc(block, docUri), ...stored });
        continue;
      }
      const { name, args } = call;
      const i = args.findIndex(a => a.id === block.id);
      let first = 0;
      let target: string | undefined;
      let runHere = false;
      if (LOCATION_CALLS.has(name) || RUNS.has(name)) {
        first = 1;
        if (LOCATION_CALLS.has(name)) target = literalName(args[0]);
        else if (args[0]?.type === 'code_block') {
          const runs = runArgs(args[0]);
          runHere = runs.has(i - 1) || runs.has(ANY_ARG);
        }
      } else if (USER_CALLS.has(node.type)) {
        target = name;
      } else {
        continue;
      }
      if (i < first) continue;
      locSymbols.argBlocks.push({ loc: nodeLoc(block, docUri), index: i - first, target, runHere: runHere || undefined });
    }
  }
  if (RUNS_ARGS.test(text)) {
    for (const i of runArgs(locBlock)) locSymbols.runsArgs.push(i);
  }
  for (const w of runWordsOf(text)) locSymbols.runsVariables.push(w);
}

/**
 * Whether `block` is run: by the `dynamic {…}` it is passed to, or by the
 * location it is passed to, found with `locationNamed`. A block passed to
 * code nobody can see (`dynamic $code, {…}`, `gs $where, {…}`) is text.
 */
export function argBlockRuns(
  block: ArgBlock,
  locationNamed: (nameLower: string) => LocationSymbols | undefined,
): boolean {
  if (block.runHere) return true;
  if (block.target === undefined) return false;
  const runs = locationNamed(block.target)?.runsArgs;
  return !!runs && (runs.includes(block.index) || runs.includes(ANY_ARG));
}

/** The blocks `locations` pass as arguments that nothing runs: text (see {@link argBlockRuns}). */
export function textArgBlocks(
  locations: Iterable<LocationSymbols>,
  locationNamed: (nameLower: string) => LocationSymbols | undefined,
): SymbolLocation[] {
  const text: SymbolLocation[] = [];
  for (const locSyms of locations) {
    for (const b of locSyms.argBlocks) if (!argBlockRuns(b, locationNamed)) text.push(b.loc);
  }
  return text;
}

/** Whether `blocks` hold the point `line`:`character`. */
export function inBlocks(blocks: readonly SymbolLocation[], line: number, character: number): boolean {
  return blocks.some(b => (line > b.line || (line === b.line && character >= b.column))
    && (line < b.endLine || (line === b.endLine && character < b.endColumn)));
}

// The `$args[N]` that the code under `root` runs: `dynamic $args[N]`,
// `dyneval($args[N])`; ANY_ARG for an index that isn't a number.
function runArgs(root: Parser.SyntaxNode): Set<number> {
  const found = new Set<number>();
  for (const node of descendantsOfType(root, CALL_TYPES)) {
    const call = callOf(node);
    if (call && RUNS.has(call.name)) addRun(call.args[0], found);
  }
  return found;
}

// Add to `runs` the argument `code` is, when it is one: `$args[N]`.
function addRun(code: Parser.SyntaxNode | undefined, runs: Set<number>): void {
  if (!code || (code.type !== 'variable_ref' && code.type !== 'ml_variable_ref')) return;
  if (code.childForFieldName('name')?.text.toLowerCase() !== 'args') return;
  const index = code.childForFieldName('index')?.namedChild(0);
  if (!index) runs.add(0);
  else runs.add(index.type === 'number_literal' ? Number(index.text) : ANY_ARG);
}

// A call's name (lower-case) and its arguments.
function callOf(node: Parser.SyntaxNode): { name: string; args: Parser.SyntaxNode[] } | undefined {
  if (!CALLS.has(node.type) && !USER_CALLS.has(node.type)) return undefined;
  const name = node.childForFieldName('name')?.text.trim().toLowerCase();
  if (!name) return undefined;
  const parens = node.namedChildren.find(c => c.type === 'paren_args');
  const args = (parens ?? node).namedChildren.filter(c => !META.has(c.type) && c.type !== 'paren_args'
    && c.type !== 'line_continuation_ext');
  return { name, args };
}

// The location a call names, when it is written out as a plain string.
function literalName(arg: Parser.SyntaxNode | undefined): string | undefined {
  if (arg?.type !== 'string') return undefined;
  const quoted = arg.namedChild(0);
  if (!quoted || quoted.namedChildCount > 0) return undefined;
  const text = quoted.text;
  return text.slice(1, -1).trim().toLowerCase() || undefined;
}
