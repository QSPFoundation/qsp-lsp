/**
 * Core types for the QSP symbol table and binding analysis.
 *
 * Shared between LocationSymbols and DocumentSymbols — extracted to a
 * separate module so both can import it without circular dependencies.
 */

export interface SymbolLocation {
  /** URI of the document */
  uri: string;
  /** 0-based line */
  line: number;
  /** 0-based column */
  column: number;
  /** End line */
  endLine: number;
  /** End column */
  endColumn: number;
  /**
   * Scope identifier — labels inside different act blocks get different
   * scopeIds so they are not flagged as duplicates of each other.
   * 0 = top-level (outside any act), >0 = inside an act block.
   */
  scopeId?: number;
  /**
   * Local variable base-names visible at this call site, mapped to the
   * scopeId of the innermost `LOCAL` declaration for that name.
   * Populated on locationRef references (gs/func/@/@@) and on
   * dynamic/dyneval code-block references to enable cross-location
   * local-variable tracking.
   */
  localsInScope?: ReadonlyMap<string, number>;
  /**
   * Category of call that created this location reference.
   * 'func' = func/@, 'gosub' = gosub/gs/@@, 'goto' = goto/gt/xgoto/xgt, 'desc' = desc.
   */
  callType?: 'func' | 'gosub' | 'goto' | 'desc';
  /** Whether this reference is a definition (assignment LHS or LOCAL declaration). */
  isDefinition?: boolean;
  /**
   * For location-call references (gs/gosub/func/@/@@/gt/goto/xgt/xgoto)
   * and inline dynamic/dyneval blocks, the number of *extra* positional
   * arguments after the location/block (i.e. those passed via `args`).
   * `undefined` for non-call references.
   */
  argCount?: number;
  /**
   * Full source text of the call site (statement, function call, or
   * `@`/`@@` user call) — used by hover renderers to display "Called
   * from" / "Navigated from" entries verbatim.  Whitespace inside is
   * collapsed to single spaces.  `undefined` for non-call references.
   */
  callText?: string;
  /**
   * Whether this reference is a genuine read of the variable — not a definition
   * (plain `=` or `local`) and not the LHS of a compound assignment
   * (`+=` / `-=` / `*=` / `/=`).  Compound LHS refs read-then-write at runtime
   * and count as references for go-to-definition / find-references, but NOT as
   * "pure reads" for `unusedVariables`.
   */
  isProperUsage?: boolean;
  /**
   * For `args` references: true iff this ref consumes a caller slot
   * (read, or compound-LHS read-then-write).  Undefined for pure
   * overwrites (`args[0] = …`) and refs to other variables.
   *
   * Consumed by `extraArgsToTargetWithoutArgs`.
   */
  argsConsumer?: boolean;
  /**
   * Literal slot index of an `args[N]` consumer (`args[2]` → `2`).
   * Undefined when `argsConsumer` is also undefined (not an args
   * consumer) or when the index is opaque (bare `args`, non-literal).
   */
  argsIndex?: number;
}

export interface QspSymbol {
  /** Name as written in source */
  name: string;
  /** Lowercase for case-insensitive matching */
  nameLower: string;
  /** Symbol kind */
  kind: QspSymbolKind;
  /** Where this symbol is defined (first assignment or declaration) */
  definition?: SymbolLocation;
  /**
   * True iff this symbol has at least one value-bearing definition —
   * an assignment with an RHS (`x = 10`, `local x = 10`, `x += 1`),
   * or a side-effect write that produces a value (`setvar 'x', 1`,
   * `copyarr 'x', src`, …).  A bare `local x` declaration is a
   * definition (it pins the local in scope) but is NOT value-bearing.
   *
   * The `uninitializedVariables` diagnostic uses this flag so that
   * reads of `local x` (with no companion assignment) still warn even
   * when a same-named global is assigned elsewhere — the local
   * shadows the global with an empty value.
   */
  hasValueDefinition?: boolean;
  /** Full range of the containing block (e.g. act…end) */
  blockRange?: SymbolLocation;
  /** All references to this symbol */
  references: SymbolLocation[];
  /** Is this a local variable? */
  isLocal: boolean;
  /** Containing location name (for scoping) */
  locationName?: string;
  /** Type prefixes used to access this variable ('#', '$', '%'). */
  prefixes?: Set<string>;
  /** Scope ID for local variables (0 = top-level). */
  scopeId?: number;
}

export enum QspSymbolKind {
  Variable = 'variable',
  Location = 'location',
  Label = 'label',
  Action = 'action',
  Object = 'object',
  UserFunction = 'user_function',
}

/**
 * QSP type-prefix forms.  In modern QSP a variable like `player` has
 * a single underlying value; the prefix on a read or write is just a
 * type-coercion lens, not a separate slot — `$player`, `#player`, and
 * `%player` all read or write the same variable.  `'#'` is the
 * explicit numeric prefix.  We retain the prefix used at each binding
 * / read site as metadata so diagnostics (e.g. `mixedVariablePrefixes`)
 * can still surface inconsistent usage.
 */
export type TypePrefix = '#' | '$' | '%';

/** Compound assignment operators. */
export type CompoundOp = '+=' | '-=' | '*=' | '/=';

/** Set of all compound assignment operators for fast membership checks. */
export const COMPOUND_OPS: ReadonlySet<string> = new Set<CompoundOp>(['+=' , '-=', '*=', '/=']);

/**
 * A statically-known value assigned to a variable at a single site.
 * - `code-block`: the RHS was a `{…}` block.  `blockRange` is the full
 *   range of the block (useful for hover / jump-to-definition).
 * - `string` / `number`: the RHS was a literal (no interpolation).
 * - `var-ref`: the RHS was a bare variable reference (e.g.
 *   `local $g = $fn`).  At runtime the value depends on whichever
 *   `<varBaseName>` binding is in scope at the assignment site — it
 *   may come from a `local` declaration in an enclosing scope, or the
 *   location-level global binding.  `readPrefix` records the type
 *   prefix the RHS used (informational only; chain following is
 *   prefix-agnostic).  Consumers that want a concrete value must
 *   resolve the chain via `LocationSymbols.variableBindings` (cycles
 *   are possible and must be detected by the caller).
 * - `other`: the RHS is some other expression (binary op, call,
 *   interpolated string, …).  Recorded so we know the variable is
 *   "written" here even if its value isn't statically known.
 */
export type BindingValue =
  | {
      kind: 'code-block';
      blockRange: SymbolLocation;
      /**
       * Writes that happen inside this code block's body.  Populated
       * at extraction time so cross-location var-mediated dynamic/dyneval
       * dispatch (where the block is held in a caller-local `$code` and
       * called in a callee's `dynamic $code`) can flow these writes back
       * to caller-locals via the call graph.
       *
       * `varBaseName` is the lowercased base name (no prefix).  The
       * write prefix lives on the nested `binding.writePrefix`.
       */
      bodyWrites?: Array<{ varBaseName: string; binding: VariableBinding }>;
    }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | {
      kind: 'var-ref';
      /** Lowercased base name of the RHS variable (no prefix). */
      varBaseName: string;
      /** Type prefix that appeared on the RHS reference, if any. */
      readPrefix?: TypePrefix;
    }
  | {
      kind: 'other';
      /**
       * Source-text snippet of the RHS expression (whitespace
       * collapsed, length-capped).  Populated for opaque RHS forms
       * — tuple literals (`[1, 2, 3]`, `(a, b)`), arithmetic, function
       * calls, interpolated strings, compound operators, etc. — so
       * hover/completion surfaces can render the written expression
       * instead of an opaque "(expr)" placeholder.  Absent for
       * side-effect writes (e.g. `killvar 'x'`) where there is no
       * RHS to capture.
       */
      text?: string;
    };

/**
 * A single `<var> = <rhs>` or `local <var> = <rhs>` binding site.
 * Stored in `LocationSymbols.variableBindings[<base name>]` — keyed
 * by the lowercased BASE name with no type prefix, since QSP variables
 * have a single underlying value regardless of `$/#/%` prefix usage.
 * The LHS prefix used at the write site is preserved on `writePrefix`
 * for diagnostics that care about prefix consistency.
 */
export interface VariableBinding {
  value: BindingValue;
  /** Range of the whole assignment statement. */
  stmtLoc: SymbolLocation;
  /** True when declared via `local …` — scope-limited binding. */
  isLocal: boolean;
  /**
   * Type prefix used on the LHS at the write site (`$x = …` → `'$'`).
   * Empty string for un-prefixed writes.  Carried for diagnostic
   * surfaces; the binding's storage identity is the base name.
   */
  writePrefix?: TypePrefix;
  /**
   * True iff this binding actually stores a value into the variable.
   *
   *   value-bearing (true): assignment / `local x = …` /
   *     `setvar` / `scanstr` / `unpackarr` / `copyarr`-dest / a
   *     `code-block` definition.  Compound operators (`+=`, `-=`, …)
   *     are also value-bearing (they write a new value) but are
   *     additionally flagged by `writeKind`.
   *   non-value-bearing (false): bare `local x` declarations (pin
   *     a fresh empty slot in scope), and the read/permute/reset
   *     side-effects `sortarr` / `killvar` / `menu`.
   *
   * Consumed by chain-aware diagnostics (uninitialized variables,
   * mixed type prefixes) so that a use whose only "binding" is a
   * non-value-bearing declaration or `sortarr` reference still warns.
   */
  isValueBearing?: boolean;
  /**
   * Tree-sitter node id of the nearest enclosing scope-forming node
   * (act_block, loop_block, if_block, code_block…), or 0 when the
   * binding lives at the top level of the location.  Used by the
   * dataflow pass to decide which bindings are visible at each
   * `dynamic <var>` / `dyneval(<var>, …)` call site.
   *
   * Not shared with the main walker's numeric `scopeId` — different
   * identifier space.  Consumers should treat this as an opaque
   * grouping key and use `isolationAncestorId` for visibility.
   */
  scopeNodeId: number;
  /**
   * Tree-sitter node id of the nearest enclosing *isolating* scope
   * ancestor (act_*, non-dynamic code_block), or 0 when none.
   * Bindings with the same `isolationAncestorId` share a visibility
   * island; bindings with different ids cannot shadow each other.
   */
  isolationAncestorId: number;
  /**
   * Type of the RHS expression at this write site, inferred statically
   * when possible.  Uses the same prefix convention as `writePrefix`:
   *   `'#'`  =  numeric value
   *   `'$'`  =  string value
   *   `'%'`  =  tuple value
   *
   * Absent when the RHS type cannot be determined statically (complex
   * expression, user-function call, etc.).
   * Compared against `writePrefix` by the `typeMismatch` diagnostic.
   */
  rhsTypePrefix?: TypePrefix;
  /**
   * How this binding was written, when it was not a plain `=` assignment.
   * Compound operators use the operator string (`+=`, `-=`, `*=`, `/=`);
   * side-effect statements use the statement name (`'setvar'`, `'scanstr'`,
   * `'unpackarr'`, `'copyarr'`, …).  Any other description string is valid.
   * Distinguish compound ops from stmt names with `COMPOUND_OPS.has(writeOp)`
   * (only the four compound operators are members of that set).
   */
  writeOp?: string;
  /**
   * Index expression text for indexed array writes (e.g. `arr[test] = 6`
   * → `'test'`, `arr[] = 6` → `''`, `arr[1, 2] = 5` → `'1, 2'`).
   * Whitespace-collapsed and capped at 50 chars.  Absent for
   * non-indexed writes.
   *
   * Captured so hover / possible-values surfaces can render the slot
   * being written (`arr[test] = 6`) instead of just the bare RHS (`6`),
   * which is misleading for arrays.  Type-mismatch / mixed-prefix and
   * value-tracking diagnostics still treat indexed writes as opaque.
   */
  indexText?: string;
}

/**
 * Per-location symbol table. Built from a tree-sitter parse of one location.
 */
export interface PrefixWarning {
  loc: SymbolLocation;
  funcName: string;
  prefix: string;
  validPrefixes: string;
}

/**
 * Warning for a built-in statement/function called with the wrong
 * number of positional arguments.  The range covers the call's name
 * token (so the squiggle attaches to the keyword, not the args).
 */
export interface ArgCountWarning {
  loc: SymbolLocation;
  /** Lowercase name of the builtin. */
  name: string;
  /** 'statement' or 'function' — used for the diagnostic message. */
  kind: 'statement' | 'function';
  /** Actual number of positional arguments at the call site. */
  actual: number;
  /** Minimum expected (always set). */
  min: number;
  /** Maximum expected; undefined for variadic builtins. */
  max?: number;
}

/**
 * Warning for a deprecated/outdated built-in statement or function
 * (e.g. ADDQST, replaced by INCLIB).  The range covers the call's
 * name token.
 */
export interface DeprecationWarning {
  loc: SymbolLocation;
  /** Lowercase name of the deprecated builtin. */
  name: string;
  /** Lowercase name of the modern replacement. */
  replacement: string;
  /** 'statement' or 'function'. */
  kind: 'statement' | 'function';
}

/**
 * One entry in the document-wide `globalBindings` index — pairs a
 * binding site with the location it lives in.
 */
export interface GlobalBindingEntry {
  locationName: string;
  binding: VariableBinding;
}
