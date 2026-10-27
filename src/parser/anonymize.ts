// ── Anonymized code ──────────────────────────────────────────────────
//
// A location's code with nothing of the game left in it, for crash
// reports: the structure that made the analysis fail (nesting, code
// blocks, calls, assignments) survives, the text doesn't. It works from
// a whitelist: only grammar keywords, operators and punctuation pass
// through as written. Names become neutral pseudonyms (`var_0003`,
// `loc_0012`, `lbl_2`), numbers become 0, the text between locations is
// dropped, and anything else, strings and comments included, is masked
// letter by letter: letters become `x`, digits `0`. What the analysis
// reads in them stays: quotes, braces, markup, `exec:` links and
// `<<…>>` interpolations, whose code is anonymized as code. Line breaks
// are kept so line numbers still match.

import type Parser from 'web-tree-sitter';
import { lookupBuiltin } from './builtins';
import { blockStatements } from './blockTrees';

/** Options for {@link anonymizeCode}. */
export interface AnonymizeOptions {
  /**
   * Pseudonyms for location names, keyed by lowercase name, so the code
   * uses the same ones as the crash report. Other locations get fresh
   * `loc_N` names.
   */
  locations?: ReadonlyMap<string, string>;
}

/** The anonymized code and what each fresh pseudonym stands for. */
export interface AnonymizedCode {
  text: string;
  /** Pseudonym → real name. Kept by the user; never part of the report. */
  names: Record<string, string>;
}

/** Grammar keywords, operators and names of builtins: none of it comes from the game. */
export const KEEP_TYPES: ReadonlySet<string> = new Set([
  'statement_name', 'function_name', 'type_prefix', 'assignment_operator',
  'act_keyword', 'if_keyword', 'elseif_keyword', 'else_keyword', 'end_keyword', 'local_keyword', 'alias_keyword',
  'loop_keyword', 'while_keyword', 'step_keyword', 'set_keyword',
  'op_amp', 'op_and', 'op_arith', 'op_cmp', 'op_loc', 'op_mod', 'op_neg', 'op_no', 'op_obj', 'op_or', 'op_pos',
]);
const STRING_TYPES = new Set(['string', 'single_quoted_string', 'double_quoted_string', 'raw_string']);
// Free text outside locations: only its line breaks are kept.
const DROP_TYPES = new Set(['inter_loc_text']);

const mask = (s: string) => s.replace(/[\p{L}_]/gu, 'x').replace(/\p{N}/gu, '0');
const keepLines = (s: string) => s.replace(/[^\r\n]/g, '');
// Text in strings and comments: masked, but an `exec:` link stays one,
// so its code is still sub-parsed as the game's is.
const maskText = (s: string) => s.split(/(exec:)/i).map((part, i) => (i % 2 === 1 ? part : mask(part))).join('');

/** Anonymize `text`, which `tree` was parsed from (one location or a whole file). */
export function anonymizeCode(tree: Parser.Tree, text: string, opts: AnonymizeOptions = {}): AnonymizedCode {
  const names: Record<string, string> = {};
  const locations = new Map(opts.locations ?? []);
  const variables = new Map<string, string>();
  const labels = new Map<string, string>();
  const pad = (n: number) => String(n).padStart(4, '0');

  const pseudonym = (map: Map<string, string>, real: string, make: () => string): string => {
    const key = real.toLowerCase();
    let p = map.get(key);
    if (!p) {
      p = make();
      map.set(key, p);
      names[p] = real;
    }
    return p;
  };
  const locationName = (real: string) => pseudonym(locations, real.trim(), () => `loc_${pad(locations.size + 1)}`);

  let out = '';
  let pos = 0;
  // Hidden grammar terminals (raw strings, newlines) show up between the
  // visible nodes, so the gaps are masked too, not copied.
  const emit = (node: Parser.SyntaxNode, replacement: string) => {
    out += maskText(text.slice(pos, node.startIndex)) + replacement;
    pos = node.endIndex;
  };

  const leaf = (node: Parser.SyntaxNode): string => {
    const t = node.text;
    if (!node.isNamed) return t;
    if (KEEP_TYPES.has(node.type) || node.type.endsWith('_keyword')) return t;
    switch (node.type) {
      case 'identifier_text': {
        const parent = node.parent?.type;
        if ((parent === 'variable_ref' || parent === 'ml_variable_ref') && lookupBuiltin(t)?.kind === 'variable') return t;
        return pseudonym(variables, t, () => `var_${pad(variables.size + 1)}`);
      }
      case 'location_name':
      case 'user_name':
        return locationName(t);
      case 'number_literal':
        return '0';
      default:
        return mask(t);
    }
  };

  const stringText = (node: Parser.SyntaxNode): string => {
    const t = node.text;
    const q = t[0];
    if ((q === "'" || q === '"') && t.length >= 2 && t[t.length - 1] === q) {
      const inner = t.slice(1, -1);
      // A string naming a location (`gt 'kitchen'`) keeps pointing at it.
      const real = inner.split(q + q).join(q).trim();
      if (real && locations.has(real.toLowerCase())) return q + locations.get(real.toLowerCase())! + q;
      return q + maskText(inner) + q;
    }
    return maskText(t);
  };

  const visit = (node: Parser.SyntaxNode) => {
    if (node.type === 'ERROR' || node.isMissing) {
      emit(node, mask(node.text));
      return;
    }
    if (STRING_TYPES.has(node.type)) {
      // Interpolated code is code: walked like the rest, the text between masked.
      if (node.descendantsOfType('string_interpolation').length === 0) {
        emit(node, stringText(node));
        return;
      }
    }
    if (node.type === 'comment_statement') {
      emit(node, maskText(node.text));
      return;
    }
    if (DROP_TYPES.has(node.type)) {
      emit(node, keepLines(node.text));
      return;
    }
    if (node.type === 'label_name') {
      emit(node, pseudonym(labels, node.text, () => `lbl_${labels.size + 1}`));
      return;
    }
    if (node.childCount === 0) {
      emit(node, leaf(node));
      return;
    }
    for (const child of node.type === 'code_block' ? blockStatements(node) : node.children) visit(child);
  };

  // Location names first, so `gt 'kitchen'` before `# kitchen` still maps.
  for (const node of tree.rootNode.descendantsOfType('location_name')) locationName(node.text);
  visit(tree.rootNode);
  out += maskText(text.slice(pos));
  return { text: out, names };
}
