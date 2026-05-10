/**
 * QSP built-in keyword data for completions, hover, and diagnostics.
 */

export interface BuiltinInfo {
  name: string;
  kind: 'statement' | 'function' | 'variable';
  description: string;
  signature?: string;
  /** Which type prefixes ($, #, %) are valid for this function.
   *  e.g. '$' = string-only, '#' = number-only, '$#%' = polymorphic.
   *  Omitted for statements/variables (not applicable). */
  validPrefixes?: string;
  /**
   * Fixed return type for this function, derived from the engine's
   * QSP_TYPE_* constant.  Omitted (undefined) for polymorphic functions
   * whose return type depends on the call-site prefix (QSP_TYPE_UNDEF).
   *   '#' → numeric  (QSP_TYPE_NUM / QSP_TYPE_BOOL)
   *   '$' → string   (QSP_TYPE_STR / QSP_TYPE_CODE)
   *   '%' → tuple    (QSP_TYPE_TUPLE)
   */
  returnType?: '#' | '$' | '%';
  /** Minimum number of positional arguments accepted.  Omitted = no
   *  lower-bound check (don't warn on too few args). */
  minArgs?: number;
  /** Maximum number of positional arguments accepted.  Omitted = no
   *  upper-bound check (variadic / open-ended). */
  maxArgs?: number;
  /** Marks an outdated/legacy builtin. The string names the modern
   *  replacement (used in diagnostics and hovers).  Omitted = current. */
  deprecated?: string;
}

export const QSP_STATEMENTS: BuiltinInfo[] = [
  // Output
  { name: 'pl', kind: 'statement', description: 'Output text to the secondary description window, then move to a new line', signature: 'PL [value]' },
  { name: 'p', kind: 'statement', description: 'Output text to the secondary description window', signature: 'P [value]' },
  { name: 'nl', kind: 'statement', description: 'Move to a new line, then output text to the secondary description window', signature: 'NL [value]' },
  { name: '*pl', kind: 'statement', description: 'Output text to the main description window, then move to a new line', signature: '*PL [value]' },
  { name: '*p', kind: 'statement', description: 'Output text to the main description window', signature: '*P [value]' },
  { name: '*nl', kind: 'statement', description: 'Move to a new line, then output text to the main description window', signature: '*NL [value]' },
  { name: 'clear', kind: 'statement', description: 'Clear the secondary description window', signature: 'CLEAR' },
  { name: 'clr', kind: 'statement', description: 'Clear the secondary description window', signature: 'CLR' },
  { name: '*clear', kind: 'statement', description: 'Clear the main description window', signature: '*CLEAR' },
  { name: '*clr', kind: 'statement', description: 'Clear the main description window', signature: '*CLR' },
  { name: 'cls', kind: 'statement', description: 'Clear the screen leaving only the inventory', signature: 'CLS' },
  { name: 'msg', kind: 'statement', description: 'Display a message in the information window', signature: 'MSG [$message]' },
  // Timing
  { name: 'wait', kind: 'statement', description: 'Pause program execution for the specified number of milliseconds', signature: 'WAIT [#delay]' },
  { name: 'settimer', kind: 'statement', description: 'Set the timer interval in milliseconds for the counter location', signature: 'SETTIMER [#interval]' },
  // Media
  { name: 'play', kind: 'statement', description: 'Play a sound file at the specified volume', signature: 'PLAY [$file],[#volume]' },
  { name: 'close', kind: 'statement', description: 'Stop playing the specified sound file', signature: 'CLOSE [$file]' },
  { name: 'close all', kind: 'statement', description: 'Stop playing all sound files', signature: 'CLOSE ALL' },
  { name: 'view', kind: 'statement', description: 'Show an image / hide the current image', signature: 'VIEW [$file]' },
  // Navigation
  { name: 'goto', kind: 'statement', description: 'Go to the specified location', signature: 'GOTO [$location],[parameter 1],[parameter 2], ...' },
  { name: 'gt', kind: 'statement', description: 'Go to the specified location', signature: 'GT [$location],[parameter 1],[parameter 2], ...' },
  { name: 'xgoto', kind: 'statement', description: 'Go to the specified location without clearing the main description window', signature: 'XGOTO [$location],[parameter 1],[parameter 2], ...' },
  { name: 'xgt', kind: 'statement', description: 'Go to the specified location without clearing the main description window', signature: 'XGT [$location],[parameter 1],[parameter 2], ...' },
  { name: 'gosub', kind: 'statement', description: 'Process the specified location', signature: 'GOSUB [$location],[parameter 1],[parameter 2], ...' },
  { name: 'gs', kind: 'statement', description: 'Process the specified location', signature: 'GS [$location],[parameter 1],[parameter 2], ...' },
  { name: 'jump', kind: 'statement', description: 'Jump to the specified label', signature: 'JUMP [$label]' },
  { name: 'exit', kind: 'statement', description: 'Terminate execution of the current code', signature: 'EXIT' },
  // Dynamic execution
  { name: 'dynamic', kind: 'statement', description: 'Dynamically execute code', signature: 'DYNAMIC [$code string],[parameter 1],[parameter 2], ...' },
  // Objects
  { name: 'addobj', kind: 'statement', description: 'Add an inventory object', signature: 'ADDOBJ [$name],[$image file],[#position]' },
  { name: 'add obj', kind: 'statement', description: 'Add an inventory object', signature: 'ADD OBJ [$name],[$image file],[#position]' },
  { name: 'delobj', kind: 'statement', description: 'Delete inventory objects with the specified name', signature: 'DELOBJ [$name],[#objects count]' },
  { name: 'del obj', kind: 'statement', description: 'Delete inventory objects with the specified name', signature: 'DEL OBJ [$name],[#objects count]' },
  { name: 'modobj', kind: 'statement', description: 'Change how inventory objects with the specified name are visually represented', signature: 'MODOBJ [$name],[$title],[$image file]' },
  { name: 'mod obj', kind: 'statement', description: 'Change how inventory objects with the specified name are visually represented', signature: 'MOD OBJ [$name],[$title],[$image file]' },
  { name: 'resetobj', kind: 'statement', description: 'Revert modifications made by MODOBJ. If [$name] is given, only that object is reset; otherwise all objects are reset', signature: 'RESETOBJ [$name]' },
  { name: 'killobj', kind: 'statement', description: 'Clear the inventory / remove the inventory object at the specified position', signature: 'KILLOBJ [#position]' },
  { name: 'unselect', kind: 'statement', description: 'Cancel the selection of an inventory object', signature: 'UNSELECT' },
  { name: 'unsel', kind: 'statement', description: 'Cancel the selection of an inventory object', signature: 'UNSEL' },
  { name: 'killall', kind: 'statement', description: 'Delete all variables and clear the inventory', signature: 'KILLALL' },
  // Actions
  { name: 'cla', kind: 'statement', description: 'Clear the action list', signature: 'CLA' },
  { name: 'delact', kind: 'statement', description: 'Delete an action', signature: 'DELACT [$name]' },
  { name: 'del act', kind: 'statement', description: 'Delete an action', signature: 'DEL ACT [$name]' },
  // Input
  { name: 'cmdclear', kind: 'statement', description: 'Clear the input line', signature: 'CMDCLEAR' },
  { name: 'cmdclr', kind: 'statement', description: 'Clear the input line', signature: 'CMDCLR' },
  { name: 'menu', kind: 'statement', description: 'Show a menu from the array with the given name', signature: 'MENU [$array name]' },
  // Variables & arrays
  { name: 'setvar', kind: 'statement', description: 'Assign a value to the specified array element at the given index', signature: 'SETVAR [$variable name],[value],[index]' },
  { name: 'killvar', kind: 'statement', description: 'Delete all variables / the specified variable / the value at the specified index', signature: 'KILLVAR [$variable name],[index]' },
  { name: 'copyarr', kind: 'statement', description: 'Copy the contents of one array into another array', signature: 'COPYARR [$destination array],[$source array],[#start index],[#count]' },
  { name: 'sortarr', kind: 'statement', description: 'Sort an array', signature: 'SORTARR [$array name],[#reverse order]' },
  { name: 'scanstr', kind: 'statement', description: 'Find all substrings matching the regular expression', signature: 'SCANSTR [$array name],[$string],[$pattern],[#group number]' },
  { name: 'unpackarr', kind: 'statement', description: 'Create an array from the elements of the specified slice of a tuple', signature: 'UNPACKARR [$array name],[%tuple],[#start],[#length]' },
  // Save/load
  { name: 'opengame', kind: 'statement', description: 'Load the game state', signature: 'OPENGAME [$file]' },
  { name: 'savegame', kind: 'statement', description: 'Save the game state', signature: 'SAVEGAME [$file]' },
  { name: 'openqst', kind: 'statement', description: 'Open and run a game file', signature: 'OPENQST [$file]' },
  { name: 'inclib', kind: 'statement', description: 'Add locations from the specified file', signature: 'INCLIB [$file]' },
  { name: 'addqst', kind: 'statement', description: 'Add locations from the specified file (replaced by INCLIB)', signature: 'ADDQST [$file]', deprecated: 'inclib' },
  { name: 'freelib', kind: 'statement', description: 'Remove all locations added via INCLIB', signature: 'FREELIB' },
  { name: 'killqst', kind: 'statement', description: 'Remove all locations added via ADDQST (replaced by FREELIB)', signature: 'KILLQST', deprecated: 'freelib' },
  // UI
  { name: 'refint', kind: 'statement', description: 'Refresh the user interface', signature: 'REFINT' },
  { name: 'showacts', kind: 'statement', description: 'Show / hide the action list', signature: 'SHOWACTS [#show]' },
  { name: 'showinput', kind: 'statement', description: 'Show / hide the input line', signature: 'SHOWINPUT [#show]' },
  { name: 'showobjs', kind: 'statement', description: 'Show / hide the inventory', signature: 'SHOWOBJS [#show]' },
  { name: 'showstat', kind: 'statement', description: 'Show / hide the secondary description window', signature: 'SHOWSTAT [#show]' },
];

export const QSP_FUNCTIONS: BuiltinInfo[] = [
  { name: 'desc', kind: 'function', description: 'Returns the base description text of the location', signature: 'DESC([$location])', validPrefixes: '$', returnType: '$' },
  { name: 'max', kind: 'function', description: 'Returns the maximum value among the arguments', signature: 'MAX([expression 1],[expression 2], ...)', validPrefixes: '$#%' },
  { name: 'min', kind: 'function', description: 'Returns the minimum value among the arguments', signature: 'MIN([expression 1],[expression 2], ...)', validPrefixes: '$#%' },
  { name: 'rand', kind: 'function', description: 'Returns a random number between the specified values', signature: 'RAND([#expression 1],[#expression 2],[#normal distribution mode])', validPrefixes: '#', returnType: '#' },
  { name: 'rnd', kind: 'function', description: 'Returns a random value from 1 to 1000 inclusive', signature: 'RND', validPrefixes: '#', returnType: '#' },
  { name: 'val', kind: 'function', description: 'Converts an expression to a number', signature: 'VAL(expression)', validPrefixes: '#', returnType: '#' },
  { name: 'iif', kind: 'function', description: 'Returns one of the expressions based on the condition', signature: 'IIF([#condition],[true expression],[false expression])', validPrefixes: '$#%' },
  { name: 'dyneval', kind: 'function', description: 'Returns the value of the dynamically evaluated expression', signature: 'DYNEVAL([$code string],[parameter 1],[parameter 2], ...)', validPrefixes: '$#%' },
  { name: 'func', kind: 'function', description: 'Process the specified location as a function', signature: 'FUNC([$location],[parameter 1],[parameter 2], ...)', validPrefixes: '$#%' },
  { name: 'input', kind: 'function', description: 'Shows the text input window and returns the entered value', signature: 'INPUT([$message])', validPrefixes: '$', returnType: '$' },
  { name: 'usrtxt', kind: 'function', description: 'Returns the text in the input line', signature: 'USRTXT', validPrefixes: '$', returnType: '$' },
  { name: 'user_text', kind: 'function', description: 'Returns the text in the input line', signature: 'USER_TEXT', validPrefixes: '$', returnType: '$' },
  { name: 'maintxt', kind: 'function', description: 'Returns the text in the main description window', signature: 'MAINTXT', validPrefixes: '$', returnType: '$' },
  { name: 'stattxt', kind: 'function', description: 'Returns the text in the secondary description window', signature: 'STATTXT', validPrefixes: '$', returnType: '$' },
  { name: 'getobj', kind: 'function', description: 'Returns the name of the inventory object located at the specified position', signature: 'GETOBJ([#position])', validPrefixes: '$', returnType: '$' },
  { name: 'countobj', kind: 'function', description: 'Returns the number of objects in the inventory', signature: 'COUNTOBJ', validPrefixes: '#', returnType: '#' },
  { name: 'selobj', kind: 'function', description: 'Returns the name of the selected inventory object', signature: 'SELOBJ', validPrefixes: '$', returnType: '$' },
  { name: 'curloc', kind: 'function', description: 'Returns the name of the current location', signature: 'CURLOC', validPrefixes: '$', returnType: '$' },
  { name: 'curobjs', kind: 'function', description: 'Returns all current inventory objects as code', signature: 'CUROBJS', validPrefixes: '$', returnType: '$' },
  { name: 'selact', kind: 'function', description: 'Returns the name of the selected action', signature: 'SELACT', validPrefixes: '$', returnType: '$' },
  { name: 'curacts', kind: 'function', description: 'Returns all current actions as code', signature: 'CURACTS', validPrefixes: '$', returnType: '$' },
  { name: 'arrsize', kind: 'function', description: 'Returns the number of elements in the specified array', signature: 'ARRSIZE([$array name])', validPrefixes: '#', returnType: '#' },
  { name: 'arrtype', kind: 'function', description: "Returns the type prefix (''/'#'/'$'/'%') of the value of the element in the specified array", signature: 'ARRTYPE([$array name],[index])', validPrefixes: '$', returnType: '$' },
  { name: 'arritem', kind: 'function', description: 'Returns the value of the element in the specified array', signature: 'ARRITEM([$array name],[index])', validPrefixes: '$#%' },
  { name: 'arrpack', kind: 'function', description: 'Returns a tuple obtained from the specified part of the array', signature: 'ARRPACK([$array name],[#start],[#length])', validPrefixes: '%', returnType: '%' },
  { name: 'arrpos', kind: 'function', description: 'Search the array for an element with the specified value', signature: 'ARRPOS([$array name],[value],[#start index])', validPrefixes: '#', returnType: '#' },
  { name: 'arrcomp', kind: 'function', description: 'Search the array for an element matching the regular expression', signature: 'ARRCOMP([$array name],[$pattern],[#start index])', validPrefixes: '#', returnType: '#' },
  { name: 'strcomp', kind: 'function', description: 'Checks whether the specified text matches the regular expression', signature: 'STRCOMP([$text],[$pattern])', validPrefixes: '#', returnType: '#' },
  { name: 'strfind', kind: 'function', description: 'Returns the substring corresponding to group [#group number] of the regular expression', signature: 'STRFIND([$text],[$pattern],[#group number])', validPrefixes: '$', returnType: '$' },
  { name: 'strpos', kind: 'function', description: 'Returns the position of the substring corresponding to group [#group number] of the regular expression', signature: 'STRPOS([$text],[$pattern],[#group number])', validPrefixes: '#', returnType: '#' },
  { name: 'instr', kind: 'function', description: 'Search for a substring', signature: 'INSTR([$text],[$search text],[#start position])', validPrefixes: '#', returnType: '#' },
  { name: 'isnum', kind: 'function', description: 'Checks whether the specified expression is a number', signature: 'ISNUM(expression)', validPrefixes: '#', returnType: '#' },
  { name: 'trim', kind: 'function', description: 'Removes adjacent spaces and tab characters from the text', signature: 'TRIM([$text])', validPrefixes: '$', returnType: '$' },
  { name: 'ucase', kind: 'function', description: 'Converts lowercase letters of the text to uppercase', signature: 'UCASE([$text])', validPrefixes: '$', returnType: '$' },
  { name: 'lcase', kind: 'function', description: 'Converts uppercase letters of the text to lowercase', signature: 'LCASE([$text])', validPrefixes: '$', returnType: '$' },
  { name: 'len', kind: 'function', description: 'Returns the length of the specified string or the number of elements in the tuple', signature: 'LEN([$text]) / LEN([%tuple])', validPrefixes: '#', returnType: '#' },
  { name: 'mid', kind: 'function', description: 'Cuts from the text a string of the specified length starting from the given position', signature: 'MID([$text],[#start],[#length])', validPrefixes: '$', returnType: '$' },
  { name: 'replace', kind: 'function', description: 'Replace the specified substring in the text', signature: 'REPLACE([$text],[$search text],[$replacement text],[#replace count])', validPrefixes: '$', returnType: '$' },
  { name: 'str', kind: 'function', description: 'Converts an expression to a string', signature: 'STR(expression)', validPrefixes: '$', returnType: '$' },
  { name: 'isplay', kind: 'function', description: 'Checks whether the specified sound file is currently playing', signature: 'ISPLAY([$file])', validPrefixes: '#', returnType: '#' },
  { name: 'rgb', kind: 'function', description: 'Returns a color code based on the 3 components', signature: 'RGB([#red],[#green],[#blue])', validPrefixes: '#', returnType: '#' },
  { name: 'msecscount', kind: 'function', description: 'Returns the number of milliseconds elapsed since the start of the game', signature: 'MSECSCOUNT', validPrefixes: '#', returnType: '#' },
  { name: 'qspver', kind: 'function', description: 'Returns the interpreter version', signature: 'QSPVER', validPrefixes: '$', returnType: '$' },
];

export const QSP_VARIABLES: BuiltinInfo[] = [
  { name: 'args', kind: 'variable', description: 'Array with procedure/function parameters', signature: 'ARGS / $ARGS / %ARGS' },
  { name: 'result', kind: 'variable', description: 'Variable contains the result returned by the current function', signature: 'RESULT / $RESULT / %RESULT' },
  { name: 'disablescroll', kind: 'variable', description: 'If the variable is not 0, it forbids automatic text scrolling when outputting', signature: 'DISABLESCROLL' },
  { name: 'nosave', kind: 'variable', description: 'If the variable is not 0, saving the game state by the user is impossible', signature: 'NOSAVE' },
  { name: 'debug', kind: 'variable', description: 'If the variable is not 0, the game identifier check is disabled when loading the state', signature: 'DEBUG' },
  { name: 'counter', kind: 'variable', description: 'Variable contains the name of the counter location', signature: '$COUNTER' },
  { name: 'ongload', kind: 'variable', description: 'Variable contains the name of the state-loading handler location', signature: '$ONGLOAD' },
  { name: 'ongsave', kind: 'variable', description: 'Variable contains the name of the state-saving handler location', signature: '$ONGSAVE' },
  { name: 'onnewloc', kind: 'variable', description: 'Variable contains the name of the new-location transition handler location', signature: '$ONNEWLOC' },
  { name: 'onactsel', kind: 'variable', description: 'Variable contains the name of the action-selection handler location', signature: '$ONACTSEL' },
  { name: 'onobjsel', kind: 'variable', description: 'Variable contains the name of the object-selection handler location', signature: '$ONOBJSEL' },
  { name: 'onobjadd', kind: 'variable', description: 'Variable contains the name of the object-addition handler location', signature: '$ONOBJADD' },
  { name: 'onobjdel', kind: 'variable', description: 'Variable contains the name of the object-deletion handler location', signature: '$ONOBJDEL' },
  { name: 'usercom', kind: 'variable', description: 'Variable contains the name of the input-line handler location', signature: '$USERCOM' },
  { name: 'usehtml', kind: 'variable', description: 'If the variable is not 0, enables the use of HTML', signature: 'USEHTML' },
  { name: 'bcolor', kind: 'variable', description: 'Variable contains the background color', signature: 'BCOLOR' },
  { name: 'fcolor', kind: 'variable', description: 'Variable contains the main font color', signature: 'FCOLOR' },
  { name: 'lcolor', kind: 'variable', description: 'Variable contains the main link color', signature: 'LCOLOR' },
  { name: 'fsize', kind: 'variable', description: 'Variable contains the main font size', signature: 'FSIZE' },
  { name: 'fname', kind: 'variable', description: 'Variable contains the name of the main font', signature: '$FNAME' },
  { name: 'backimage', kind: 'variable', description: 'Variable contains the path to the background image', signature: '$BACKIMAGE' },
];

export const QSP_KEYWORDS: BuiltinInfo[] = [
  { name: 'if', kind: 'statement', description: 'Conditional statement', signature: 'IF [#condition]: [code for true condition] ELSE [code to execute otherwise]' },
  { name: 'elseif', kind: 'statement', description: 'Alternative condition', signature: 'ELSEIF [#condition]: [code for true condition]' },
  { name: 'else', kind: 'statement', description: 'Execute code when the IF condition is not true', signature: 'ELSE' },
  { name: 'end', kind: 'statement', description: 'End the multi-line form of IF / ACT / LOOP', signature: 'END' },
  { name: 'act', kind: 'statement', description: 'Add an action', signature: 'ACT [$name],[$image file]: [action code]' },
  { name: 'loop', kind: 'statement', description: 'Loop', signature: 'LOOP [initialization code] WHILE [#condition] STEP [step code]: [loop body code]' },
  { name: 'while', kind: 'statement', description: 'Loop condition (used with LOOP)', signature: 'WHILE [#condition]' },
  { name: 'step', kind: 'statement', description: 'Loop step expression (used with LOOP)', signature: 'STEP [step code]' },
  { name: 'set', kind: 'statement', description: 'Set variable values', signature: 'SET [variable names] = [variable values]' },
  { name: 'let', kind: 'statement', description: 'Set variable values', signature: 'LET [variable names] = [variable values]' },
  { name: 'local', kind: 'statement', description: 'Declare local variables and set their values', signature: 'LOCAL [variable names] = [variable values]' },
  { name: 'and', kind: 'function', description: 'Logical "AND". The resulting expression is true if both conditions are true', signature: '[#condition 1] AND [#condition 2]' },
  { name: 'or', kind: 'function', description: 'Logical "OR". The resulting expression is true if at least one condition is true', signature: '[#condition 1] OR [#condition 2]' },
  { name: 'no', kind: 'function', description: 'Logical negation. The resulting expression is true if the specified condition is not true', signature: 'NO [#condition]' },
  { name: 'mod', kind: 'function', description: 'Calculate the remainder of division', signature: '[#expression 1] MOD [#expression 2]' },
  { name: 'obj', kind: 'function', description: 'Returns the number of objects with the specified name in the inventory', signature: 'OBJ [$object]' },
  { name: 'loc', kind: 'function', description: 'Check if the location exists', signature: 'LOC [$location]' },
];

export const ALL_BUILTINS: BuiltinInfo[] = [
  ...QSP_STATEMENTS,
  ...QSP_FUNCTIONS,
  ...QSP_VARIABLES,
  ...QSP_KEYWORDS,
];

// ──────────────────────────────────────────────────────────────────────
// Argument-count constraints for built-in statements/functions.
//
// `min` is the minimum positional argument count required at runtime.
// `max` is the maximum allowed; omit to mark a variadic builtin (no
// upper bound).  Builtins not in this table are not range-checked.
//
// Where the QSP runtime accepts a default value for a missing trailing
// argument, that argument is treated as optional (i.e. not counted in
// `min`).  Keep this conservative — false positives on common idioms
// are worse than missed warnings.
// ──────────────────────────────────────────────────────────────────────

interface ArgRange { min: number; max?: number }

const ARG_CONSTRAINTS: Record<string, ArgRange> = {
  // ── Output (text optional) ──────────────────────────────────────
  pl: { min: 0, max: 1 },
  p: { min: 0, max: 1 },
  nl: { min: 0, max: 1 },
  '*pl': { min: 0, max: 1 },
  '*p': { min: 0, max: 1 },
  '*nl': { min: 0, max: 1 },
  clear: { min: 0, max: 0 },
  clr: { min: 0, max: 0 },
  '*clear': { min: 0, max: 0 },
  '*clr': { min: 0, max: 0 },
  cls: { min: 0, max: 0 },
  msg: { min: 1, max: 1 },
  // ── Timing ──────────────────────────────────────────────────────
  wait: { min: 1, max: 1 },
  settimer: { min: 1, max: 1 },
  // ── Media ───────────────────────────────────────────────────────
  play: { min: 1, max: 2 },
  close: { min: 1, max: 1 },
  'close all': { min: 0, max: 0 },
  view: { min: 0, max: 1 },
  // ── Navigation ──────────────────────────────────────────────────
  goto: { min: 1, max: 20 },
  gt: { min: 1, max: 20 },
  xgoto: { min: 1, max: 20 },
  xgt: { min: 1, max: 20 },
  gosub: { min: 1, max: 20 },
  gs: { min: 1, max: 20 },
  jump: { min: 1, max: 1 },
  exit: { min: 0, max: 0 },
  // ── Dynamic ─────────────────────────────────────────────────────
  dynamic: { min: 1, max: 20 },
  // ── Objects ─────────────────────────────────────────────────────
  addobj: { min: 1, max: 3 },
  'add obj': { min: 1, max: 3 },
  delobj: { min: 1, max: 2 },
  'del obj': { min: 1, max: 2 },
  modobj: { min: 2, max: 3 },
  'mod obj': { min: 2, max: 3 },
  resetobj: { min: 0, max: 1 },
  killobj: { min: 0, max: 1 },
  unselect: { min: 0, max: 0 },
  unsel: { min: 0, max: 0 },
  killall: { min: 0, max: 0 },
  // ── Actions ─────────────────────────────────────────────────────
  cla: { min: 0, max: 0 },
  delact: { min: 1, max: 1 },
  'del act': { min: 1, max: 1 },
  // ── Input ───────────────────────────────────────────────────────
  cmdclear: { min: 0, max: 0 },
  cmdclr: { min: 0, max: 0 },
  menu: { min: 1, max: 3 },
  // ── Variables & arrays ──────────────────────────────────────────
  setvar: { min: 2, max: 3 },
  killvar: { min: 0, max: 2 },
  copyarr: { min: 2, max: 4 },
  sortarr: { min: 1, max: 2 },
  scanstr: { min: 3, max: 4 },
  unpackarr: { min: 2, max: 4 },
  // ── Save/load ───────────────────────────────────────────────────
  opengame: { min: 0, max: 1 },
  savegame: { min: 0, max: 1 },
  openqst: { min: 1, max: 1 },
  inclib: { min: 1, max: 1 },
  addqst: { min: 1, max: 1 },
  freelib: { min: 0, max: 0 },
  killqst: { min: 0, max: 0 },
  // ── UI ──────────────────────────────────────────────────────────
  refint: { min: 0, max: 0 },
  showacts: { min: 1, max: 1 },
  showinput: { min: 1, max: 1 },
  showobjs: { min: 1, max: 1 },
  showstat: { min: 1, max: 1 },

  // ── Functions ───────────────────────────────────────────────────
  desc: { min: 1, max: 1 },
  max: { min: 1, max: 20 },
  min: { min: 1, max: 20 },
  rand: { min: 1, max: 3 },
  rnd: { min: 0, max: 0 },
  val: { min: 1, max: 1 },
  iif: { min: 3, max: 3 },
  dyneval: { min: 1, max: 20 },
  func: { min: 1, max: 20 },
  input: { min: 1, max: 1 },
  usrtxt: { min: 0, max: 0 },
  user_text: { min: 0, max: 0 },
  maintxt: { min: 0, max: 0 },
  stattxt: { min: 0, max: 0 },
  getobj: { min: 1, max: 1 },
  countobj: { min: 0, max: 0 },
  selobj: { min: 0, max: 0 },
  curloc: { min: 0, max: 0 },
  curobjs: { min: 0, max: 0 },
  selact: { min: 0, max: 0 },
  curacts: { min: 0, max: 0 },
  arrsize: { min: 1, max: 1 },
  arrtype: { min: 1, max: 2 },
  arritem: { min: 1, max: 2 },
  arrpack: { min: 1, max: 3 },
  arrpos: { min: 2, max: 3 },
  arrcomp: { min: 2, max: 3 },
  strcomp: { min: 2, max: 2 },
  strfind: { min: 2, max: 3 },
  strpos: { min: 2, max: 3 },
  instr: { min: 2, max: 3 },
  isnum: { min: 1, max: 1 },
  trim: { min: 1, max: 1 },
  ucase: { min: 1, max: 1 },
  lcase: { min: 1, max: 1 },
  len: { min: 1, max: 1 },
  mid: { min: 2, max: 3 },
  replace: { min: 2, max: 4 },
  str: { min: 1, max: 1 },
  isplay: { min: 1, max: 1 },
  rgb: { min: 3, max: 4 },
  msecscount: { min: 0, max: 0 },
  qspver: { min: 0, max: 1 },
};

// Merge the constraint table into BuiltinInfo entries so consumers can
// read them off the same object as the rest of the metadata.
for (const b of ALL_BUILTINS) {
  if (b.kind === 'variable') continue;
  const r = ARG_CONSTRAINTS[b.name.toLowerCase()];
  if (!r) continue;
  b.minArgs = r.min;
  if (r.max !== undefined) b.maxArgs = r.max;
}

/**
 * Lookup a built-in by name (case-insensitive).
 */
const builtinMap = new Map<string, BuiltinInfo>();
for (const b of ALL_BUILTINS) {
  builtinMap.set(b.name.toLowerCase(), b);
}

export function lookupBuiltin(name: string, hasTypePrefix = false): BuiltinInfo | undefined {
  const lower = name.toLowerCase();
  const exact = builtinMap.get(lower);
  if (exact) {
    // When the original token had a $#% prefix (stripped by caller),
    // statements are not valid matches — only variables/functions
    // can carry a type prefix.
    if (hasTypePrefix && exact.kind === 'statement') return undefined;
    return exact;
  }
  // Also try stripping $#% from the raw name (e.g. for callers that
  // pass the un-stripped token like "$func").  Only functions and
  // variables are valid here — statements can't have type prefixes.
  if (/^[$#%]/.test(lower)) {
    const stripped = builtinMap.get(lower.slice(1));
    if (stripped && stripped.kind !== 'statement') return stripped;
  }
  return undefined;
}

/**
 * Lookup valid prefixes for a function by name (case-insensitive).
 * Returns undefined if the function is unknown.
 */
const funcPrefixMap = new Map<string, string>();
for (const f of QSP_FUNCTIONS) {
  if (f.validPrefixes) funcPrefixMap.set(f.name.toLowerCase(), f.validPrefixes);
}

export function lookupValidPrefixes(funcNameLower: string): string | undefined {
  return funcPrefixMap.get(funcNameLower);
}

/**
 * Returns the fixed return-type prefix for a known built-in function
 * ('' = numeric, '$' = string, '%' = tuple), or undefined when the
 * function is either not a built-in or is polymorphic (return type
 * depends on the call-site prefix).
 */
const returnTypeMap = new Map<string, '#' | '$' | '%'>();
for (const f of QSP_FUNCTIONS) {
  if (f.returnType !== undefined) {
    returnTypeMap.set(f.name.toLowerCase(), f.returnType);
  }
}

export function lookupFunctionReturnType(funcNameLower: string): '#' | '$' | '%' | undefined {
  return returnTypeMap.get(funcNameLower);
}

/**
 * Lookup argument-count constraints for a built-in by lowercase name.
 * Returns the BuiltinInfo entry when constraints are recorded, else
 * undefined. Callers read `.minArgs` / `.maxArgs` directly to avoid
 * a per-call object allocation on the hot path.
 */
export function lookupArgConstraints(
  nameLower: string,
): BuiltinInfo | undefined {
  const b = builtinMap.get(nameLower);
  if (!b || b.minArgs === undefined) return undefined;
  return b;
}

/**
 * Lookup the deprecation marker for a built-in by lowercase name.
 * Returns the lowercase name of the modern replacement if the builtin
 * is deprecated, else undefined.
 */
export function lookupDeprecated(nameLower: string): string | undefined {
  return builtinMap.get(nameLower)?.deprecated;
}
