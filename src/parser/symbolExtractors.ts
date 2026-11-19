/**
 * Symbol extraction functions — convert AST nodes into symbol-table entries.
 *
 * Each function takes a tree-sitter node, a LocationSymbols store, and
 * document URI; it registers variables, labels, actions, location refs,
 * object refs, action refs, or call-site warnings.
 */


import type Parser from 'web-tree-sitter';
import type { SymbolLocation, SyntaxFeatureUse, TypePrefix } from './symbolTypes';
import type { LocationSymbols } from './locationSymbols';
import { classifyAssignmentLhs, isAssignmentTarget, isLocalVariable, variableDefinitionHasValue } from './variableUtils';
import {
  LOCATION_REF_NAMES,
  LOCALS_PROPAGATING_NAMES,
  CALL_TYPE_MAP,
  OBJECT_DEF_NAMES,
  OBJECT_REF_NAMES,
  ACTION_REF_NAMES,
  VAR_DEF_STMT_NAMES,
  VAR_REF_STMT_NAMES,
  VAR_MUTATE_STMT_NAMES,
  VAR_REF_FUNC_NAMES,
  VAR_REF_FUNC_1ARG_NAMES,
  ARGS_VAR_NAME,
} from './lookupTables';
import {
  nodeLoc,
  findStringInFirstArg,
  findDirectString,
  getFirstArgNode,
  getNthArgNode,
  extractQuotedRefInfo,
  extractExactQuotedRefInfo,
  countCallArgs,
  countUserCallExtraArgs,
  isSingleArgCall,
  collapseNewlines,
} from './walkHelpers';
import { lookupValidPrefixes, lookupArgConstraints, lookupDeprecated, argCountValidEverywhere, lookupBuiltin } from './builtins';
import { parseVarStringArg } from './variableBindings';
import { argPatternsOf, targetPatternOf } from './targetPattern';

// ── Variable extraction ───────────────────────────────────────────────

export function extractVariable(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId = 0,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.isMissing) return;

  const name = nameNode.text.trim();
  if (!name) return;
  // The record a field is read from or written to (`r.x`, `$s.name`, QSP
  // 5.9.6): its prefix types the field, and says nothing of the variable.
  const holdsField = node.parent?.type === 'field_access';
  const prefixNode = holdsField ? null : node.childForFieldName('prefix');
  const prefix = holdsField ? '' : (prefixNode?.text || '#') as TypePrefix;

  const loc: SymbolLocation = nodeLoc(nameNode, docUri);

  const lhsKind = classifyAssignmentLhs(node);
  const isLocal = isLocalVariable(node);
  const hasValue = lhsKind === 'definition' && variableDefinitionHasValue(node);

  // Compound assignment LHS (`x += 1`, or self-referential `hp = hp + 5`)
  // is neither a proper read nor a proper write: it mutates an existing
  // value without exposing the old value as a read elsewhere and without
  // introducing a new definition.  So `a = 4 & a += 5` leaves `a` flagged
  // as "assigned but never read" and bare `x += 1` leaves `x` flagged as
  // "used but never assigned" (the bare-reference loop in
  // `checkUninitializedVariables` walks every non-definition ref, and the
  // compound binding fails the `compoundOp === undefined` guard in the
  // value-binding check).  The compound binding is still recorded by
  // `bindingCollector` so hover / possible-values display it.
  if (lhsKind === null) loc.isProperUsage = true;

  // For non-local, non-pure-definition refs to the built-in `args`,
  // capture which slot is being read so `extraArgsToTargetWithoutArgs`
  // can detect "callee reads fewer args than caller passed".  Pure
  // writes (`args[0] = 99`) overwrite the slot rather than consuming
  // the caller's value, so they're excluded.  Compound LHS refs
  // (`args[0] += 1`) do read first and are included.
  if (!isLocal && lhsKind !== 'definition' && name.toLowerCase() === ARGS_VAR_NAME) {
    loc.argsConsumer = true;
    const idx = readArgsLiteralIndex(node);
    if (idx !== undefined) loc.argsIndex = idx;
  }

  locSymbols.addVariable(name, loc, isLocal, lhsKind === 'definition', prefix, scopeId, hasValue, prefixNode?.text ?? '');
}

/**
 * Inspect a `variable_ref`/`ml_variable_ref` node on the built-in
 * `args` and return the literal numeric index when statically
 * determinable, else `undefined` (an "opaque" consumer: bare `args`,
 * multi-dimension index, or a non-literal index expression).
 */
function readArgsLiteralIndex(node: Parser.SyntaxNode): number | undefined {
  const idx = node.childForFieldName('index');
  if (!idx) return undefined;
  // `idx` is an `array_index` AST node — `[ expr (, expr)* ]`.  Look
  // for exactly one named expression child; multi-dimension index or
  // empty bracket → opaque.
  if (idx.namedChildCount !== 1) return undefined;
  const inner = idx.namedChild(0);
  if (!inner || inner.type !== 'number_literal') return undefined;
  const n = Number(inner.text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

// ── Label extraction ──────────────────────────────────────────────────

/**
 * In real QSP a label is recognized by the runtime only when it begins
 * a line — never after `&` in a `&`-chain, never as the body of an
 * inline `if` / `loop` / `act`.  We detect this uniformly by checking
 * whether any previous sibling ends on the same line as the label
 * starts: if so, something precedes the label on the line and it is
 * unreachable.  Such labels are tracked in `unreachableLabels` for
 * diagnostics and hover but never registered in the label / labelRef
 * buckets — they cannot be jumped to, defined to, or renamed.
 */
export function extractLabel(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  labelNamespace = 0,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const raw = nameNode.text;
  const trimmed = raw.trim();
  const leadingSpaces = raw.length - raw.trimStart().length;
  const trailingSpaces = raw.length - raw.trimEnd().length;

  const loc: SymbolLocation = {
    ...nodeLoc(nameNode, docUri),
    column: nameNode.startPosition.column + leadingSpaces,
    endColumn: nameNode.endPosition.column - trailingSpaces,
    scopeId: labelNamespace || undefined,
  };

  const prev = node.previousSibling;
  const atLineStart = !prev || prev.endPosition.row < node.startPosition.row;

  if (!atLineStart) {
    locSymbols.unreachableLabels.push(loc);
    return;
  }

  locSymbols.addLabel(trimmed, loc, labelNamespace);
}

// ── Action extraction ─────────────────────────────────────────────────

export function extractAction(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const argsNode = node.childForFieldName('args');
  if (!argsNode) return;

  let targetNode: Parser.SyntaxNode = argsNode;
  if (argsNode.type === 'paren_args') {
    const firstArg = argsNode.namedChild(0);
    if (firstArg) targetNode = firstArg;
  }

  const blockRange: SymbolLocation = nodeLoc(node, docUri);

  const directStr = findDirectString(targetNode);
  if (directStr) {
    const { name, loc } = extractExactQuotedRefInfo(directStr, docUri);
    locSymbols.addAction(name, loc, blockRange);
  } else {
    const name = targetNode.text.trim();
    const loc: SymbolLocation = nodeLoc(targetNode, docUri);
    locSymbols.addAction(name, loc, blockRange);
  }
}

// ── Location reference extraction ─────────────────────────────────────

// A jump or call whose target isn't a plain string literal (a variable,
// an expression, an interpolated string). It has no name to be a location
// ref under, but the jump graph still shows it as a jump to an unknown target.
function recordDynamicLocationRef(
  node: Parser.SyntaxNode,
  callName: string,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const target = getFirstArgNode(node);
  if (!target) return;
  const loc = nodeLoc(target, docUri);
  loc.callType = CALL_TYPE_MAP.get(callName);
  loc.callText = collapseNewlines(node.text);
  loc.argCount = Math.max(0, countCallArgs(node) - 1);
  locSymbols.dynamicLocationRefs.push({
    loc, exprText: collapseNewlines(target.text), target: targetPatternOf(target, true), callColumn: node.startPosition.column,
  });
}

// The arguments after the location name of `gs 'name', a, b` / `func('name', a)`.
function setArgPatterns(loc: SymbolLocation, node: Parser.SyntaxNode): void {
  if (!loc.argCount) return;
  const args: Parser.SyntaxNode[] = [];
  for (let i = 1; i <= Math.min(loc.argCount, 4); i++) {
    const a = getNthArgNode(node, i);
    if (a) args.push(a);
  }
  const patterns = argPatternsOf(args);
  if (patterns) loc.argPatterns = patterns;
}

export function extractLocationRef(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId: number,
  labelNamespace = 0,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const stmtName = nameNode.text.toLowerCase();

  if (stmtName === 'jump') {
    const firstString = findStringInFirstArg(node);
    if (!firstString) return;
    const { name: refName, loc } = extractQuotedRefInfo(firstString, docUri);
    loc.scopeId = labelNamespace || undefined;
    locSymbols.addLabelRef(refName, loc, labelNamespace);
    return;
  }

  if (LOCATION_REF_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (!firstString) {
      recordDynamicLocationRef(node, stmtName, locSymbols, docUri);
      return;
    }
    const { name: refName, loc } = extractQuotedRefInfo(firstString, docUri);
    if (LOCALS_PROPAGATING_NAMES.has(stmtName)) {
      loc.localsInScope = locSymbols.getLocalsInScope(scopeId);
    }
    loc.callType = CALL_TYPE_MAP.get(stmtName);
    loc.callText = collapseNewlines(node.text);
    loc.argCount = Math.max(0, countCallArgs(node) - 1);
    setArgPatterns(loc, node);
    locSymbols.addLocationRef(refName, loc);
    return;
  }

  if (OBJECT_DEF_NAMES.has(stmtName) || OBJECT_REF_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (!firstString) return;
    const { name: refName, loc } = extractExactQuotedRefInfo(firstString, docUri);
    locSymbols.addObjectRef(refName, loc, OBJECT_DEF_NAMES.has(stmtName));
    return;
  }

  if (ACTION_REF_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (!firstString) return;
    const { name: refName, loc } = extractExactQuotedRefInfo(firstString, docUri);
    locSymbols.addActionRef(refName, loc);
    return;
  }

  if (VAR_DEF_STMT_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (firstString) {
      addVarRefFromString(firstString, docUri, locSymbols, true, scopeId);
    }
    // copyarr/movearr(dst, src): second arg is a proper-usage source
    // reference (MOVEARR empties it after reading it).
    if (stmtName === 'copyarr' || stmtName === 'movearr') {
      const srcNode = getNthArgNode(node, 1);
      const srcString = srcNode ? findDirectString(srcNode) : null;
      if (srcString) addVarRefFromString(srcString, docUri, locSymbols, false, scopeId);
    }
    return;
  }

  if (VAR_REF_STMT_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (firstString) {
      addVarRefFromString(firstString, docUri, locSymbols, false, scopeId);
    }
    return;
  }

  if (VAR_MUTATE_STMT_NAMES.has(stmtName)) {
    const firstString = findStringInFirstArg(node);
    if (firstString) {
      addVarRefFromString(firstString, docUri, locSymbols, false, scopeId, false);
    }
    return;
  }
}

// ── Function-call location refs ───────────────────────────────────────

export function extractFuncCallLocationRef(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId: number,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text.toLowerCase();

  if (LOCATION_REF_NAMES.has(funcName)) {
    const firstString = findStringInFirstArg(node);
    if (!firstString) {
      recordDynamicLocationRef(node, funcName, locSymbols, docUri);
      return;
    }
    const { name: refName, loc } = extractQuotedRefInfo(firstString, docUri);
    if (LOCALS_PROPAGATING_NAMES.has(funcName)) {
      loc.localsInScope = locSymbols.getLocalsInScope(scopeId);
    }
    loc.callType = CALL_TYPE_MAP.get(funcName);
    loc.callText = collapseNewlines(node.text);
    loc.argCount = Math.max(0, countCallArgs(node) - 1);
    setArgPatterns(loc, node);
    locSymbols.addLocationRef(refName, loc);
    return;
  }

  if (VAR_REF_FUNC_NAMES.has(funcName)) {
    const firstString = findStringInFirstArg(node);
    if (firstString) {
      addVarRefFromString(firstString, docUri, locSymbols, false, scopeId);
    }
    return;
  }

  if (VAR_REF_FUNC_1ARG_NAMES.has(funcName) && isSingleArgCall(node)) {
    const firstString = findStringInFirstArg(node);
    if (firstString) addVarRefFromString(firstString, docUri, locSymbols, false, scopeId);
    return;
  }
}

// ── Call-site warning extractors ──────────────────────────────────────

export function checkFuncCallPrefix(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const prefixNode = node.childForFieldName('prefix');
  if (!prefixNode) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const funcName = nameNode.text.toLowerCase();
  const validPrefixes = lookupValidPrefixes(funcName);
  if (validPrefixes === undefined) return;

  const prefix = prefixNode.text;
  if (validPrefixes.includes(prefix)) return;

  const loc: SymbolLocation = {
    uri: docUri,
    line: prefixNode.startPosition.row,
    column: prefixNode.startPosition.column,
    endLine: nameNode.endPosition.row,
    endColumn: nameNode.endPosition.column,
  };

  locSymbols.prefixWarnings.push({ loc, funcName, prefix, validPrefixes });
}

export function checkArgCount(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const nameText = nameNode.text.toLowerCase();
  const info = lookupArgConstraints(nameText);
  if (!info) return;

  const actual = countCallArgs(node);
  // The counts differ between syntax versions (COUNTOBJ, ARRITEM): the
  // diagnostic reads them for the version chosen.
  if (argCountValidEverywhere(nameText, actual)) return;
  const min = info.minArgs;
  const max = info.maxArgs;

  const kind: 'statement' | 'function' =
    node.type === 'statement' ? 'statement' : 'function';

  const loc: SymbolLocation = nodeLoc(nameNode, docUri);

  locSymbols.argCountWarnings.push({ loc, name: nameText, kind, actual, min, max });
}

// Characters that end a name in 5.9.6 but are part of one in 5.9.5.
const NAME_DELIMITERS_596 = /[\\;^@?]/;

/**
 * Record a construct that only some syntax versions have (see
 * `SyntaxFeatureUse`). Called for every node the walker visits.
 */
export function noteSyntaxFeature(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const uses = locSymbols.syntaxFeatureUses;
  switch (node.type) {
    case 'undefined_literal':
      uses.push({ loc: nodeLoc(node, docUri), feature: 'undefinedValue' });
      return;
    case 'op_pos':
      uses.push({ loc: nodeLoc(node, docUri), feature: 'unaryPlus' });
      return;
    case 'line_continuation_ext': {
      // The token starts at `_`; the blanks before it are skipped. 5.9.5
      // joins a line only when it ends in a space and `_`.
      if (node.tree.rootNode.text.charAt(node.startIndex - 1) !== '\t') return;
      const { row, column } = node.startPosition;
      uses.push({
        loc: { uri: docUri, line: row, column, endLine: row, endColumn: column + 1 },
        feature: 'tabContinuation',
      });
      return;
    }
    case 'variable_ref':
    case 'ml_variable_ref': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || nameNode.isMissing) return;
      const builtin = lookupBuiltin(nameNode.text);
      if (NAME_DELIMITERS_596.test(nameNode.text)) {
        uses.push({ loc: nodeLoc(nameNode, docUri), feature: 'nameDelimiter', name: nameNode.text });
      } else if (builtin?.since === '5.9.6' && builtin.kind !== 'variable') {
        // ALIAS, INSVAR, ARRKEY: names in 5.9.5, builtins in 5.9.6.
        uses.push({ loc: nodeLoc(nameNode, docUri), feature: 'reservedName', name: nameNode.text });
      }
      return;
    }
    case 'alias_statement':
    case 'local_statement':
    case 'loop_inline':
    case 'loop_block': {
      const keyword = node.childForFieldName('keyword');
      if (keyword) uses.push({ loc: nodeLoc(keyword, docUri), feature: 'builtin', name: keyword.text.toLowerCase() });
      if (node.type === 'local_statement') noteSeveralValues(node, uses, docUri);
      return;
    }
    case 'assignment_statement':
      noteSeveralValues(node, uses, docUri);
      return;
    case 'bracket_tuple':
    case 'paren_tuple':
      uses.push({ loc: nodeLoc(node, docUri), feature: 'tuple' });
      return;
    case 'type_prefix':
      if (node.text === '%') uses.push({ loc: nodeLoc(node, docUri), feature: 'tuplePrefix' });
      return;
    case 'array_index':
      if (node.namedChildCount > 1 && node.children.some(c => c.type === ',')) uses.push({ loc: nodeLoc(node, docUri), feature: 'multipleIndex' });
      return;
    case 'tuple_field': {
      const name = node.childForFieldName('name');
      if (name) uses.push({ loc: nodeLoc(name, docUri), feature: 'recordField' });
      return;
    }
    case 'field_access':
      noteFieldAccess(node, uses, docUri);
      return;
    case 'elseif_inline': {
      const keyword = node.childForFieldName('keyword');
      if (keyword) uses.push({ loc: nodeLoc(keyword, docUri), feature: 'inlineElseif' });
      return;
    }
    case 'if_block':
    case 'act_block':
    case 'elseif_clause':
    case 'else_clause':
      noteCommentAfterColon(node, uses, docUri);
      return;
    case 'user_func_call':
    case 'ml_user_func_call':
    case 'user_call_statement': {
      const opener = node.child(0);
      const nameNode = node.childForFieldName('name');
      if (opener) uses.push({ loc: nodeLoc(opener, docUri), feature: 'userFunctionCall', name: opener.type });
      if (opener && nameNode && !nameNode.isMissing && opener.endIndex !== nameNode.startIndex) {
        uses.push({
          loc: { uri: docUri, line: opener.endPosition.row, column: opener.endPosition.column, endLine: nameNode.startPosition.row, endColumn: nameNode.startPosition.column },
          feature: 'spaceAfterAt',
          name: opener.type,
        });
      }
      return;
    }
    case 'statement':
    case 'na_func_call':
    case 'ext_func_call':
    case 'ml_func_call': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || nameNode.isMissing) return;
      const name = nameNode.text.toLowerCase();
      if (lookupBuiltin(name)?.since) uses.push({ loc: nodeLoc(nameNode, docUri), feature: 'builtin', name });
      return;
    }
  }
}

// A chain of fields, noted once at its outermost one: `a.b.c` read with a
// plain name at each step is one name to older players (`dottedName`), and
// the rest is 5.9.6 (`fieldAccess`). An index after a field isn't 5.9.6.
function noteFieldAccess(node: Parser.SyntaxNode, uses: SyntaxFeatureUse[], docUri: string): void {
  const parent = node.parent;
  if (parent?.type === 'field_access' && parent.childForFieldName('object')?.id === node.id) return;
  let dotted = true;
  let base: Parser.SyntaxNode = node;
  const names: string[] = [];
  for (let n: Parser.SyntaxNode | null = node; n?.type === 'field_access'; n = n.childForFieldName('object')) {
    const index = n.childForFieldName('index');
    if (index) uses.push({ loc: nodeLoc(index, docUri), feature: 'fieldIndex' });
    const field = n.childForFieldName('field')?.namedChild(0);
    if (n.childForFieldName('prefix') || field?.type !== 'identifier_text' || (index && n.id !== node.id)) dotted = false;
    names.unshift(field?.text ?? '');
    base = n.childForFieldName('object') ?? n;
  }
  const isVariable = base.type === 'variable_ref' || base.type === 'ml_variable_ref';
  if (dotted && isVariable && !base.childForFieldName('index')) {
    const end = (node.childForFieldName('field') ?? node).endPosition;
    uses.push({
      loc: { uri: docUri, line: base.startPosition.row, column: base.startPosition.column, endLine: end.row, endColumn: end.column },
      feature: 'dottedName',
      name: [base.text, ...names].join('.'),
    });
  } else {
    const dot = node.child(1) ?? node;
    const end = (node.childForFieldName('field') ?? node).endPosition;
    uses.push({
      loc: { uri: docUri, line: dot.startPosition.row, column: dot.startPosition.column, endLine: end.row, endColumn: end.column },
      feature: 'fieldAccess',
    });
  }
}

// `a, b = 1, 2` and `x = 1, 2`: several variables or values (5.9 tuples).
function noteSeveralValues(node: Parser.SyntaxNode, uses: SyntaxFeatureUse[], docUri: string): void {
  const variables = node.childForFieldName('variables');
  const values = node.childrenForFieldName('value').filter(v => v.isNamed);
  if ((variables && variables.namedChildCount > 1) || values.length > 1) {
    uses.push({ loc: nodeLoc(node, docUri), feature: 'multipleAssignment' });
  }
}

// A comment right after the `:` (or ELSE) of a multi-line block. 5.7 makes
// such a line a one-line IF (ACT, ELSE…) whose code is the comment, so an
// ELSEIF or ELSE with no lines below it means the same in every version.
function noteCommentAfterColon(node: Parser.SyntaxNode, uses: SyntaxFeatureUse[], docUri: string): void {
  const keyword = node.childForFieldName('keyword');
  if (!keyword) return;
  const header = new Set([keyword, node.childForFieldName('condition'), ...node.childrenForFieldName('args')]
    .filter(h => h !== null).map(h => h.id));
  let comment: Parser.SyntaxNode | null = null;
  for (let i = 0; i < node.childCount && !comment; i++) {
    const c = node.child(i)!;
    if (c.type === 'comment_statement') comment = c;
    else if (c.isNamed && !header.has(c.id)) return;
  }
  if (!comment) return;
  const isClause = node.type === 'elseif_clause' || node.type === 'else_clause';
  if (isClause && !node.namedChildren.some(c => c.startPosition.row > comment!.endPosition.row)) return;
  const name = node.type === 'if_block' ? 'if' : node.type === 'act_block' ? 'act'
    : node.type === 'elseif_clause' ? 'elseif' : 'else';
  uses.push({ loc: nodeLoc(comment, docUri), feature: 'commentAfterColon', name });
}

/**
 * Record a deprecation warning when the call's name resolves to a
 * builtin marked `deprecated`. Mirrors `checkArgCount` in shape so
 * the walker can call them side-by-side.
 */
export function checkDeprecated(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const nameText = nameNode.text.toLowerCase();
  const replacement = lookupDeprecated(nameText);
  if (!replacement) return;
  const kind: 'statement' | 'function' =
    node.type === 'statement' ? 'statement' : 'function';
  locSymbols.deprecationWarnings.push({
    loc: nodeLoc(nameNode, docUri),
    name: nameText,
    replacement,
    kind,
  });
}

// ── User call / obj operator extraction ───────────────────────────────

export function extractUserCallRef(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId: number,
): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const argCount = countUserCallExtraArgs(node);
  const loc: SymbolLocation = {
    ...nodeLoc(nameNode, docUri),
    localsInScope: locSymbols.getLocalsInScope(scopeId),
    callType: node.type === 'user_call_statement' ? 'gosub' : 'func',
    callText: collapseNewlines(node.text),
    argCount,
  };
  if (argCount > 0) {
    const paren = node.namedChildren.find(c => c.type === 'paren_args');
    const args = paren ? paren.namedChildren : node.namedChildren.filter(c => c.type !== 'user_name');
    const patterns = argPatternsOf(args);
    if (patterns) loc.argPatterns = patterns;
  }

  locSymbols.addLocationRef(nameNode.text.trim(), loc);
}

export function extractObjOperator(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId: number,
): void {
  // `#obj` / `#loc`: the prefix comes first.
  const first = node.namedChildren.find(c => c.type !== 'type_prefix');
  if (!first) return;

  if (first.type === 'op_obj') {
    const firstString = operandString(node);
    if (!firstString) return;
    const { name: refName, loc } = extractExactQuotedRefInfo(firstString, docUri);
    locSymbols.addObjectRef(refName, loc);
  } else if (first.type === 'op_loc') {
    const firstString = operandString(node);
    if (!firstString) return;
    const { name: refName, loc } = extractQuotedRefInfo(firstString, docUri);
    loc.localsInScope = locSymbols.getLocalsInScope(scopeId);
    locSymbols.addLocationRef(refName, loc);
  }
}

// The name `obj` / `loc` checks, written bare or in parentheses
// (`loc 'room'`, `loc('room')`).
function operandString(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let operand = node.namedChildren.at(-1) ?? null;
  while (operand?.type === 'paren_expr' && operand.namedChildCount === 1) operand = operand.namedChild(0);
  return operand ? findDirectString(operand) : null;
}

// ── ALIAS ─────────────────────────────────────────────────────────────

/**
 * Link the locals an `alias_statement` declares to the arrays its values
 * name: `ALIAS a, $b = 'arr1', '$arr2'` makes `a` share `arr1` and `b`
 * share `arr2`. A name in a string is also a reference to that array (for
 * references and rename), neither a read nor a write (QSP makes the array
 * if there is none), with no type prefix. Called after the statement's
 * variables are recorded.
 */
export function extractAliasTargets(
  node: Parser.SyntaxNode,
  locSymbols: LocationSymbols,
  docUri: string,
  scopeId: number,
): void {
  // A field (`alias r.x = …`) takes its place but declares no alias.
  const names = (node.childForFieldName('variables')?.namedChildren ?? []).filter(isAssignmentTarget);
  // The field also holds the commas between the values.
  const values = node.childrenForFieldName('value').filter(v => v.isNamed);
  for (const [i, v] of names.entries()) {
    const name = v.type === 'field_access' ? undefined : v.childForFieldName('name')?.text;
    const sym = name ? locSymbols.findLocalInScope(name, scopeId) : undefined;
    if (!sym) continue;
    const alias = sym.alias ??= { targets: [], declarations: 0 };
    alias.declarations++;
    // QSP pairs names and values one to one, and stops on any other count.
    const str = values.length === names.length ? findDirectString(values[i]) : null;
    const quoted = str && str.type !== 'code_block' ? extractQuotedRefInfo(str, docUri) : null;
    const target = quoted ? parseVarStringArg(quoted.name) : null;
    if (!quoted || !target) {
      alias.unknownTarget = true;
      continue;
    }
    const base = target.base.toLowerCase();
    if (!alias.targets.includes(base)) alias.targets.push(base);
    // The name alone, without a prefix: QSP takes only the name ('$arr1'
    // is arr1), and a rename keeps the prefix.
    const at = quoted.name.indexOf(target.base);
    const loc = quoted.loc.line === quoted.loc.endLine
      ? { ...quoted.loc, column: quoted.loc.column + at, endColumn: quoted.loc.column + at + target.base.length }
      : quoted.loc;
    loc.aliasName = true;
    locSymbols.addVariable(target.base, loc, false, false, '', scopeId, false);
  }
}

// ── Variable-from-string reference ────────────────────────────────────

/**
 * Record a variable reference whose name lives inside a string literal
 * (e.g. `killvar 'x'`, `setvar '$score', 100`, `arrsize('#arr')`).
 */
function addVarRefFromString(
  stringNode: Parser.SyntaxNode,
  docUri: string,
  locSymbols: LocationSymbols,
  isDefinition: boolean,
  scopeId = 0,
  isProperUsage = !isDefinition,
): void {
  const { name: rawName, loc } = extractQuotedRefInfo(stringNode, docUri);
  const parsed = parseVarStringArg(rawName);
  if (!parsed) return;
  if (isProperUsage) loc.isProperUsage = true;
  locSymbols.addVariable(
    parsed.base, loc, false, isDefinition, parsed.prefix, scopeId, isDefinition,
  );
}
