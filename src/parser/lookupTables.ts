/**
 * Lookup tables for statement/function name classification.
 *
 * These sets and maps categorise QSP built-in names so the
 * walker and extractors can dispatch each call to the correct
 * symbol-table method without repeated string comparisons.
 */


/**
 * Name of the implicit per-call-frame arguments variable in QSP.
 * Callers pass extras as `args[0]`, `args[1]`, …; the callee reads
 * them through this built-in.  Centralised here so detection of
 * `args` references (in extractors / diagnostics / hover) doesn't
 * depend on scattered string literals.
 */
export const ARGS_VAR_NAME = 'args';

/**
 * Name of the implicit per-call-frame return-value variable in QSP.
 * Function-call locations (`func` / `@`) and `dyneval` blocks write
 * their result here for the caller to read.
 */
export const RESULT_VAR_NAME = 'result';

/**
 * The two implicit per-call-frame built-ins (`args` and `result`).
 * They behave as locals to each invocation, not as globals, and are
 * excluded from propagation, "uses globals" hover lists, and unused-
 * variable analysis.
 */
export const CALL_FRAME_BUILTINS: ReadonlySet<string> = new Set([ARGS_VAR_NAME, RESULT_VAR_NAME]);

/** Statement/function names whose first argument is a location name. */
export const LOCATION_REF_NAMES = new Set([
  'gosub', 'goto', 'gs', 'gt', 'xgoto', 'xgt', 'func', 'desc',
]);

/**
 * Statement names whose execution breaks/transfers control flow.
 * Used for semantic-token highlighting (the `controlFlow` modifier).
 */
export const CONTROL_FLOW_STMT_NAMES: ReadonlySet<string> = new Set([
  'exit', 'goto', 'gt', 'xgoto', 'xgt', 'jump',
]);

/** Subset of LOCATION_REF_NAMES where locals propagate to the called location. */
export const LOCALS_PROPAGATING_NAMES = new Set([
  'gosub', 'gs', 'func', 'desc',
]);

/** Maps call names to their category for mixed-call-type diagnostics. */
export const CALL_TYPE_MAP = new Map<string, 'func' | 'gosub' | 'goto' | 'desc'>([
  ['desc', 'desc'],
  ['func', 'func'],
  ['gosub', 'gosub'], ['gs', 'gosub'],
  ['goto', 'goto'], ['gt', 'goto'], ['xgoto', 'goto'], ['xgt', 'goto'],
]);

/** Statement names that define an object (addobj). */
export const OBJECT_DEF_NAMES = new Set(['addobj', 'add obj']);

/** Statement names that reference an existing object. */
export const OBJECT_REF_NAMES = new Set([
  'delobj', 'del obj', 'modobj', 'mod obj', 'resetobj',
]);

/** Statement names whose first argument is an action name. */
export const ACTION_REF_NAMES = new Set(['delact', 'del act']);

/**
 * Statements whose first string argument is a variable name being defined.
 * `copyarr` also reads its second string arg as a proper-usage source
 * reference — handled inline in the statement walker.
 */
export const VAR_DEF_STMT_NAMES = new Set(['setvar', 'scanstr', 'unpackarr', 'copyarr']);

/**
 * Statements whose first string argument is a variable name being mutated.
 * Neither counts as a "proper usage" for `unusedVariables` — they do not
 * prevent an "assigned but never read" warning.
 */
export const VAR_MUTATE_STMT_NAMES = new Set(['sortarr', 'killvar']);

/** Statements whose first string argument is a variable name being read. */
export const VAR_REF_STMT_NAMES = new Set(['menu']);

/**
 * Statement names that side-effectively write their first string-arg
 * variable.  These get a `{ kind: 'other' }` entry in variableBindings
 * so analyses see the mutation site even though the RHS can't be tracked.
 */
export const SIDE_EFFECT_WRITE_STMTS = new Set([
  ...VAR_DEF_STMT_NAMES, ...VAR_MUTATE_STMT_NAMES,
]);

/** Functions whose first argument is a variable name (reference). */
export const VAR_REF_FUNC_NAMES = new Set([
  'arrsize', 'arrtype', 'arritem', 'arrpack', 'arrpos', 'arrcomp',
]);

/** Functions that reference a variable name ONLY when called with a single argument. */
export const VAR_REF_FUNC_1ARG_NAMES = new Set(['max', 'min']);
