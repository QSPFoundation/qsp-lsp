/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

/**
 * Tree-sitter grammar for QSP (Quest Soft Player).
 * Translated from qsp_grammar.peg (Ohm.js PEG format).
 *
 * Architecture:
 * - Horizontal whitespace (spaces, tabs) is in `extras` → auto-skipped between tokens.
 * - Newlines are NOT in extras → they act as statement terminators.
 * - Line continuations (" _\n") are in `extras` → transparent mid-statement.
 * - THREE expression contexts (matching PEG):
 *     _na_expression  = nonAmpersand (& is statement separator)
 *     _ext_expression = extended (& is value-concat operator)
 *     _ml_expression  = multiline (& is operator, newlines are whitespace)
 * - Operator precedence from PEG priority table (6–18).
 * - Case-insensitive keywords via ci() helper.
 * - Strings are multiline per PEG (rawSingleQuotedChar = ~"'" any).
 * - Comments/noteStrings support { } and quotes for multi-line.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function ci(word) {
  return new RegExp(
    word.split('').map(c => {
      if (/[a-zA-Z]/.test(c)) return `[${c.toLowerCase()}${c.toUpperCase()}]`;
      if (/[.*+?^${}()|[\]\\]/.test(c)) return `\\${c}`;
      return c;
    }).join('')
  );
}

// Sort longest-first, wrap each in token(prec(2, ...)) for keyword priority
function kw(words) {
  const sorted = [...new Set(words)].sort((a, b) => b.length - a.length);
  return choice(...sorted.map(w => token(prec(2, ci(w)))));
}

// keyword-with-colon: fuse "keyword" + optional-whitespace + ":" into a
// single atomic token so the colon can't be stolen by label_statement.
function kwc(word) {
  return token(prec(2, seq(ci(word), /[ \t]*/, ':')));
}

const STATEMENTS = [
  '*clear', '*clr', '*nl', '*pl', '*p',
  'add obj', 'addobj', 'cla', 'clear', 'close all', 'close', 'clr', 'cls',
  'cmdclear', 'cmdclr', 'copyarr',
  'del act', 'del obj', 'delact', 'delobj', 'dynamic', 'exit',
  'freelib', 'killqst',
  'gosub', 'goto', 'gs', 'gt',
  'inclib', 'addqst',
  'jump',
  'killall', 'killobj', 'killvar',
  'menu', 'mod obj', 'modobj', 'msg',
  'nl',
  'opengame', 'openqst',
  'p', 'pl', 'play',
  'refint', 'resetobj',
  'savegame', 'scanstr', 'settimer',
  'showacts', 'showinput', 'showobjs', 'showstat',
  'sortarr',
  'unpackarr', 'unsel', 'unselect',
  'view',
  'wait',
  'xgoto', 'xgt',
  'setvar',
];

const FUNCTIONS = [
  'arrcomp', 'arritem', 'arrpack', 'arrpos', 'arrsize', 'arrtype',
  'countobj', 'curacts', 'curloc', 'curobjs',
  'desc', 'dyneval',
  'func',
  'getobj',
  'iif', 'input', 'instr', 'isnum', 'isplay',
  'lcase', 'len',
  'maintxt', 'max', 'mid', 'min', 'msecscount',
  'qspver',
  'rand', 'replace', 'rgb', 'rnd',
  'selact', 'selobj', 'stattxt', 'str', 'strcomp', 'strfind', 'strpos',
  'trim',
  'ucase', 'user_text', 'usrtxt',
  'val',
];

/*
 * Operator precedence (from PEG):
 *   6  = or         7  = and        8  = no (unary)
 *  10  = comparisons (!, <>, <=, =<, >=, =>, =, <, >)
 *  11  = loc, obj (unary)
 *  12  = & (value concatenation — only in ext/ml contexts)
 *  14  = +, -       16 = mod        17 = *, /
 *  18  = - (unary negation)
 */

// ── Grammar ──────────────────────────────────────────────────────────────────

module.exports = grammar({
  name: 'qsp',

  // Horizontal whitespace is auto-skipped between tokens.
  // Line continuation (" _\n") is also auto-skipped.
  // Newlines are NOT here — they terminate statements.
  extras: $ => [
    /[ \t]+/,
    $.line_continuation_ext,
  ],

  // Line continuation is handled by an external scanner (src/scanner.c)
  // to avoid the space/extras ambiguity that causes incorrect token
  // positions in the generated internal lexer.
  externals: $ => [
    $.line_continuation_ext,
    $._location_end_mark_ext,
    $._location_start_mark_ext,
    $._newline_or_rbrace_ext,
  ],

  word: $ => $.identifier_text,

  conflicts: $ => [
    // variable_ref could start variable_list (assignment) or be a primary expression
    [$.variable_list, $._na_primary],
    // `if cond : !comment \n` — comment_statement could belong to
    // _stmt_single (if_inline's body) or be if_block's trailing comment.
    // Same pattern applies to act, loop, elseif, and else.
    [$._stmt_single, $.if_block],
    [$._stmt_single, $.act_block],
    [$._stmt_single, $.loop_block],
    [$._stmt_single, $.elseif_clause],
    [$._stmt_single, $.else_clause],
    // `ELSE IF` could be elseif keyword or else + nested if
    [$.if_inline, $.elseif_inline],
    // newlines between operands/operators in ml_binary are optional,
    // creating ambiguity about where \n belongs (end of LHS or start of op).
    [$.ml_binary],
    // Unary operators take _ml_expression as their operand so that
    // higher-precedence binary ops bind tighter (e.g. `no x = 1` →
    // `no (x = 1)`, not `(no x) = 1`).  The ml context needs an
    // explicit conflict due to optional newlines creating extra ambiguity.
    [$.ml_unary, $.ml_binary],
    // ml_func_call without prec.right: after function_name, seeing a token
    // that could start a bare arg (e.g. '-', string, number) the parser
    // must GLR-fork between "consume as bare arg" vs "reduce as no-arg call".
    [$.ml_func_call],
    // ml_user_func_call without prec.right: after @user_name, seeing '\n'
    // the parser must GLR-fork between "newline before (" vs "no-arg call".
    [$.ml_user_func_call],
    // ml_variable_ref without prec.right: after identifier, seeing '\n'
    // the parser must GLR-fork between "newline before [" vs "bare variable".
    [$.ml_variable_ref],
    [$.code_block, $.raw_code_block],
  ],

  rules: {

    // ══════════════════════════════════════════════════════════════════════════
    // TOP LEVEL
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: start = interLocText (locationBlock interLocText)* end
    source_file: $ => seq(
      optional($.inter_loc_text),
      repeat(seq($.location_block, optional($.inter_loc_text))),
    ),

    // ── Location blocks ─────────────────────────────────────────────────────

    // PEG: locationBlock = startOfLoc (~endLocMarker statementGroup)* endOfLoc
    location_block: $ => seq(
      $.location_header,
      repeat($._statement_group),
      $.location_end,
    ),

    // PEG: startOfLoc = "#" space* locName space* newline
    // Note: extras handles the spaces around location_name automatically
    location_header: $ => seq($._location_start_mark_ext, $.location_name, $._newline),

    // PEG: locName = locNameChar+ (space+ locNameChar+)*
    // locNameChar = ~(space | newline) any
    location_name: $ => /[^ \t\r\n]+([ \t]+[^ \t\r\n]+)*/,

    // PEG: endOfLoc = "--" endOfLocChar* (newline | &end)
    location_end: $ => prec.right(seq(
      $._location_end_mark_ext,
      optional(token.immediate(/[^\r\n]*/)),
      optional($._newline),
    )),

    // PEG: interLocText = (interLocLine | newline)*
    inter_loc_text: $ => repeat1(choice($.inter_loc_line, $._newline)),

    // PEG: interLocLine = ~startLocMarker interLocChar+ (newline | &end)
    inter_loc_line: $ => prec.right(seq(
      token(prec(-1, /[^#\r\n][^\r\n]*/)),
      optional($._newline),
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // STATEMENT GROUPS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: statementGroup = ws (multiLineBlock | singleLineBlock | newline)
    // Note: tree-sitter is GLR, not PEG — choice() order doesn't affect priority.
    // Multi vs single line ambiguity is resolved by prec() and the conflicts array.
    _statement_group: $ => choice(
      $.single_line_block,
      $.multi_line_block,
      $._newline,
    ),

    // PEG: singleLineBlock = singleLineGroup ws (newline | &end)
    single_line_block: $ => prec.right(seq(
      $._single_line_group,
      $._newline,
    )),

    // PEG: singleLineGroup      = singleLineStatements | statementSeparators
    // PEG: singleLineStatements = (statementSeparators ws)? statementUnitSingleLine (ws statementSeparators ws statementUnitSingleLine)* (ws statementSeparators)?
    // PEG: statementSeparators  = statementSeparator (ws statementSeparator)*
    _single_line_group: $ => prec.right(choice(
      $._single_line_statements,
      $._statement_separators,
    )),

    _single_line_statements: $ => prec.right(seq(
      optional($._statement_separators),
      $._stmt_single,
      repeat(seq($._statement_separators, $._stmt_single)),
      optional($._statement_separators),
    )),

    _statement_separators: $ => repeat1('&'),

    // PEG: multiLineBlock = statementUnitMultiLine (ws "&" ws singleLineGroup)? ws (newline | &end)
    multi_line_block: $ => prec.right(seq(
      $._stmt_multi,
      optional(seq('&', $._single_line_group)),
      $._newline,
    )),

    // ── Code-block statement groups (terminate at "}" not EOF) ──────────────

    _stmt_group_in_code_block: $ => choice(
      $._single_line_code_block,
      $._multi_line_code_block,
      $._newline,
    ),

    // PEG: singleLineCodeBlock = singleLineGroup ws (newline | &"}"))
    _single_line_code_block: $ => prec.right(seq($._single_line_group, $._newline_or_rbrace_ext)),

    // PEG: multiLineCodeBlock = statementUnitMultiLine (...) (newline | &"}")
    _multi_line_code_block: $ => prec.right(seq(
      $._stmt_multi,
      optional(seq('&', $._single_line_group)),
      $._newline_or_rbrace_ext,
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // STATEMENT UNITS
    // ══════════════════════════════════════════════════════════════════════════

    _stmt_single: $ => choice(
      $.comment_statement,
      $.label_statement,
      $.if_inline,
      $.act_inline,
      $.loop_inline,
      $.local_statement,
      $.assignment_statement,
      $.user_call_statement,
      $.statement,
      $.implicit_statement,
    ),

    _stmt_multi: $ => choice(
      $.if_block,
      $.act_block,
      $.loop_block,
    ),

    // ══════════════════════════════════════════════════════════════════════════
    // COMMENTS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: commentStatement = "!" commentText
    // PEG: commentText = (rawCodeBlock | rawStringLiteral | commentChar)*
    // PEG: commentChar = ~newline any
    //
    // rawCodeBlock {..} and rawStringLiteral '...' / "..." can span newlines,
    // making comments multi-line when they contain those constructs.
    comment_statement: $ => prec.right(seq('!', optional($.comment_text))),

    // PEG: commentText = (rawStringLiteral | rawCodeBlock | commentChar)*
    // PEG: commentChar = ~(newline | "'" | "\"" | "{" | "}") any
    comment_text: $ => prec.right(repeat1(choice(
      $._raw_string,
      $.raw_code_block,
      /[^\r\n{}'"]+/,
    ))),

    // ══════════════════════════════════════════════════════════════════════════
    // ASSIGNMENTS & LOCALS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: assignmentStatement = (setMarker &delimiterChar ws)? variableList ws assignmentOperator ws nonAmpersandArgument1plusList
    assignment_statement: $ => prec.dynamic(1, prec.right(seq(
      optional(field('keyword', alias(choice(ci('set'), ci('let')), $.set_keyword))),
      field('variables', $.variable_list),
      field('operator', $.assignment_operator),
      field('value', $._na_arg_list),
    ))),

    // PEG: localStatement = localMarker &delimiterChar ws variableList (ws "=" ws nonAmpersandArgument1plusList)?
    local_statement: $ => prec.right(seq(
      field('keyword', alias(ci('local'), $.local_keyword)),
      field('variables', $.variable_list),
      optional(seq('=', field('value', $._na_arg_list))),
    )),

    variable_list: $ => prec.right(seq(
      $.variable_ref,
      repeat(seq(',', $.variable_ref)),
    )),

    assignment_operator: $ => choice('=', '+=', '-=', '*=', '/='),

    // ══════════════════════════════════════════════════════════════════════════
    // IF STATEMENTS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: ifSingleLine = ifMarker &delimiterChar ws expression ws ":" ws singleLineGroup
    //   (ws elseIfMarker &delimiterChar ws expression ws ":" ws singleLineGroup)*
    //   (ws elseMarker &delimiterChar (ws ":")? ws singleLineGroup)?
    if_inline: $ => prec.right(seq(
      field('keyword', alias(ci('if'), $.if_keyword)),
      field('condition', $._ext_expression),
      ':',
      field('then', $._single_line_group),
      repeat($.elseif_inline),
      optional($.else_inline),
    )),

    elseif_inline: $ => seq(
      field('keyword', alias(choice(ci('elseif'), seq(ci('else'), ci('if'))), $.elseif_keyword)),
      field('condition', $._ext_expression),
      ':',
      field('body', $._single_line_group),
    ),

    else_inline: $ => choice(
      seq(
        field('keyword', alias(kwc('else'), $.else_keyword)),
        field('body', $._single_line_group),
      ),
      seq(
        field('keyword', alias(ci('else'), $.else_keyword)),
        field('body', $._single_line_group),
      ),
    ),

    // PEG: ifMultiLine = ifMarker ... ":" ws commentStatement? newline statementGroup* elseifClause* elseClause? ws endIfMarker (ws noteString)?
    if_block: $ => prec.right(seq(
      field('keyword', alias(ci('if'), $.if_keyword)),
      field('condition', $._ext_expression),
      ':',
      optional($.comment_statement),
      $._newline,
      repeat($._statement_group),
      repeat($.elseif_clause),
      optional($.else_clause),
      field('end', alias(ci('end'), $.end_keyword)),
      optional(field('note', $.note_string)),
    )),

    // PEG: elseifClause = elseifMultiLine | elseifSingleLine (multi tried first)
    // elseifSingleLine = elseif expr ":" singleLineGroup newline
    // elseifMultiLine  = elseif expr ":" commentStatement? newline statementGroup*
    //
    // The ":" after the condition is mandatory in both variants.
    // We don't fuse it with the keyword since there's an expression between them.
    elseif_clause: $ => prec.right(choice(
      // Multi-line: only optional comment after ":", then newline + body lines
      seq(
        field('keyword', alias(choice(ci('elseif'), seq(ci('else'), ci('if'))), $.elseif_keyword)),
        field('condition', $._ext_expression),
        ':', optional($.comment_statement), $._newline,
        repeat($._statement_group),
      ),
      // Single-line: body on same line as ":"
      seq(
        field('keyword', alias(choice(ci('elseif'), seq(ci('else'), ci('if'))), $.elseif_keyword)),
        field('condition', $._ext_expression),
        ':', $._single_line_group, $._newline,
      ),
    )),

    // PEG: elseClause = elseMultiLine | elseSingleLine
    // elseSingleLine = elseMarker (":" ws)? singleLineGroup newline
    // elseMultiLine  = elseMarker (":" commentStatement?)? newline statementGroup*
    //
    // The colon after "else" is optional. To prevent ":" from being stolen
    // by label_statement in the body, we fuse "else" + ":" into a single
    // atomic keyword token (kwc). Variants:
    //   1. else:  [!comment] \n stmts    — multi-line with colon (fused token)
    //   2. else   \n stmts              — multi-line without colon
    //   3. else:  body \n               — single-line with colon (fused token)
    //   4. else   body \n               — single-line without colon
    else_clause: $ => prec.right(choice(
      // Multi-line with colon: else: [!comment] \n stmts
      seq(field('keyword', alias(kwc('else'), $.else_keyword)), optional($.comment_statement), $._newline, repeat($._statement_group)),
      // Multi-line without colon: else [!comment] \n stmts
      seq(field('keyword', alias(ci('else'), $.else_keyword)), optional($.comment_statement), $._newline, repeat($._statement_group)),
      // Single-line with colon: else: body \n
      seq(field('keyword', alias(kwc('else'), $.else_keyword)), $._single_line_group, $._newline),
      // Single-line without colon: else body \n
      seq(field('keyword', alias(ci('else'), $.else_keyword)), $._single_line_group, $._newline),
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // ACT STATEMENTS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: actSingleLine = actMarker ... ws (parenthesizedArgList | argList) ws ":" ws singleLineGroup
    act_inline: $ => seq(
      field('keyword', alias(ci('act'), $.act_keyword)),
      field('args', choice($.paren_args, $._ext_arg_list)),
      ':',
      field('body', $._single_line_group),
    ),

    // PEG: actMultiLine
    act_block: $ => prec.right(seq(
      field('keyword', alias(ci('act'), $.act_keyword)),
      field('args', choice($.paren_args, $._ext_arg_list)),
      ':',
      optional($.comment_statement),
      $._newline,
      repeat($._statement_group),
      field('end', alias(ci('end'), $.end_keyword)),
      optional(field('note', $.note_string)),
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // LOOP STATEMENTS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: loopSingleLine = loopMarker (ws singleLineGroup)? ws whileMarker ws expression (ws stepMarker ws singleLineGroup)? ws ":" ws singleLineGroup
    loop_inline: $ => prec.right(seq(
      field('keyword', alias(ci('loop'), $.loop_keyword)),
      optional(field('init', $._single_line_group)),
      field('while', alias(ci('while'), $.while_keyword)),
      field('condition', $._ext_expression),
      optional(seq(
        field('step_kw', alias(ci('step'), $.step_keyword)),
        field('step', $._single_line_group),
      )),
      ':',
      field('body', $._single_line_group),
    )),

    // PEG: loopMultiLine
    loop_block: $ => prec.right(seq(
      field('keyword', alias(ci('loop'), $.loop_keyword)),
      optional(field('init', $._single_line_group)),
      field('while', alias(ci('while'), $.while_keyword)),
      field('condition', $._ext_expression),
      optional(seq(
        field('step_kw', alias(ci('step'), $.step_keyword)),
        field('step', $._single_line_group),
      )),
      ':',
      optional($.comment_statement),
      $._newline,
      repeat($._statement_group),
      field('end', alias(ci('end'), $.end_keyword)),
      optional(field('note', $.note_string)),
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // REGULAR STATEMENTS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: statement = statementEmptyArgs | statementWithArgs | statementNoArgs
    // Unified — tree-sitter can't do PEG ordered choice
    statement: $ => prec.right(seq(
      field('name', $.statement_name),
      optional(choice(
        prec(2, seq('(', ')')),                    // empty args (higher prec than paren_tuple)
        $.paren_args,                              // parenthesized args
        $._na_arg_list,                            // bare args (no &)
      )),
    )),

    statement_name: $ => kw(STATEMENTS),

    // ══════════════════════════════════════════════════════════════════════════
    // USER CALLS  (@@name / @name)
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: userCallStatement = @@name [args]
    user_call_statement: $ => prec.right(seq(
      '@@',
      field('name', $.user_name),
      optional(choice(
        prec(2, seq('(', ')')),
        $.paren_args,
        $._na_arg_list,
      )),
    )),

    // PEG: userFunctionCall = @name [args]  (expression context)
    user_func_call: $ => prec.right(seq(
      '@',
      field('name', $.user_name),
      optional(choice(
        prec(2, seq('(', ')')),
        $.paren_args,
      )),
    )),

    // PEG: multilineUserFunctionCall — mws between name and args
    ml_user_func_call: $ => seq(
      '@',
      field('name', $.user_name),
      optional(choice(
        seq(optional($._nls), prec(2, seq('(', ')'))),
        seq(optional($._nls), $.paren_args),
      )),
    ),

    user_name: $ => token(prec(1, /[^\s&'"()\[\]=!<>+\-\/*:,{}]+/)),

    // ══════════════════════════════════════════════════════════════════════════
    // FUNCTION CALLS — 3 variants matching 3 expression contexts
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: nonAmpersandFunctionCall — single arg uses nonAmpersandExpression
    // Bare arg uses _na_unary (not _na_expression) so that binary operators
    // are NOT consumed: `len 'abc' + 1` → `len('abc') + 1`.
    na_func_call: $ => prec.right(seq(
      field('prefix', optional($.type_prefix)),
      field('name', $.function_name),
      optional(choice(
        prec(2, seq('(', ')')),
        $.paren_args,
        $._na_unary,                  // single bare arg (no binary ops)
      )),
    )),

    // PEG: functionCall — single arg uses expression (with &)
    // Bare arg uses _ext_unary (not _ext_expression) so that binary operators
    // are NOT consumed: `len 'abc' + 1` → `len('abc') + 1`.
    ext_func_call: $ => prec.right(seq(
      field('prefix', optional($.type_prefix)),
      field('name', $.function_name),
      optional(choice(
        prec(2, seq('(', ')')),
        $.paren_args,
        $._ext_unary,                 // single bare arg (no binary ops)
      )),
    )),

    // PEG: multilineFunctionCall — mws, single arg uses multilineExpression
    // Bare arg uses _ml_unary (not _ml_expression) so that binary operators
    // are NOT consumed: `len 'abc' + 1` → `len('abc') + 1`.
    ml_func_call: $ => seq(
      field('prefix', optional($.type_prefix)),
      field('name', $.function_name),
      optional(choice(
        seq(optional($._nls), prec(2, seq('(', ')'))),
        seq(optional($._nls), $.paren_args),
        $._ml_unary,                 // single bare arg (no binary ops)
      )),
    ),

    function_name: $ => kw(FUNCTIONS),

    // ══════════════════════════════════════════════════════════════════════════
    // LABEL / NOTE / IMPLICIT
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: labelStatement = ":" ws labelName
    // PEG: labelName = noteString
    label_statement: $ => prec.right(seq(':', field('name', $.label_name))),

    // PEG: noteString = (rawStringLiteral | rawCodeBlock | noteChar)+
    // PEG: noteChar = ~(statementSeparator | newline | "'" | "\"" | "{" | "}"
    //                  | "(" | ")" | "[" | "]") any
    // {..} and '...'/"..." can span multiple lines.
    label_name: $ => prec.right(repeat1(choice(
      $._raw_string,
      $.raw_code_block,
      /[^\r\n&{}'"()\[\]]+/,
    ))),

    // Used after `end` in multi-line if/act/loop
    note_string: $ => prec.right(repeat1(choice(
      $._raw_string,
      $.raw_code_block,
      /[^\r\n&{}'"()\[\]]+/,
    ))),

    // PEG: implicitStatement = nonAmpersandExpression
    implicit_statement: $ => $._na_expression,

    // ══════════════════════════════════════════════════════════════════════════
    // EXPRESSIONS — THREE CONTEXTS
    // ══════════════════════════════════════════════════════════════════════════
    //
    // Since horizontal whitespace is in extras, binary ops just need
    // prec.left(N, seq(left, op, right)) — no manual ws handling.

    // ── nonAmpersand expression (& is statement separator, NOT operator) ────

    _na_expression: $ => choice($.na_binary, $._na_unary),

    na_binary: $ => choice(
      prec.left(6,  seq($._na_expression, alias(ci('or'),  $.op_or),  $._na_expression)),
      prec.left(7,  seq($._na_expression, alias(ci('and'), $.op_and), $._na_expression)),
      prec.left(10, seq($._na_expression, $._cmp_op, $._na_expression)),
      // NO & at precedence 12
      prec.left(14, seq($._na_expression, alias(choice('+', '-'), $.op_arith), $._na_expression)),
      prec.left(16, seq($._na_expression, alias(ci('mod'), $.op_mod), $._na_expression)),
      prec.left(17, seq($._na_expression, alias(choice('*', '/'), $.op_arith), $._na_expression)),
    ),

    _na_unary: $ => choice($.na_unary, $._na_primary),

    na_unary: $ => choice(
      prec(8,  seq(alias(ci('no'),  $.op_no),  $._na_expression)),
      prec(11, seq(alias(ci('obj'), $.op_obj), $._na_expression)),
      prec(11, seq(alias(ci('loc'), $.op_loc), $._na_expression)),
      prec(18, seq(alias('-', $.op_neg),       $._na_expression)),
    ),

    _na_primary: $ => choice(
      $.paren_expr,
      $.number_literal,
      $.string,
      $.code_block,
      $.tuple,
      $.user_func_call,
      $.na_func_call,
      $.variable_ref,
    ),

    // ── extended expression (& IS operator at precedence 12) ────────────────

    _ext_expression: $ => choice($.ext_binary, $._ext_unary),

    ext_binary: $ => choice(
      prec.left(6,  seq($._ext_expression, alias(ci('or'),  $.op_or),  $._ext_expression)),
      prec.left(7,  seq($._ext_expression, alias(ci('and'), $.op_and), $._ext_expression)),
      prec.left(10, seq($._ext_expression, $._cmp_op, $._ext_expression)),
      prec.left(12, seq($._ext_expression, alias('&', $.op_amp), $._ext_expression)),
      prec.left(14, seq($._ext_expression, alias(choice('+', '-'), $.op_arith), $._ext_expression)),
      prec.left(16, seq($._ext_expression, alias(ci('mod'), $.op_mod), $._ext_expression)),
      prec.left(17, seq($._ext_expression, alias(choice('*', '/'), $.op_arith), $._ext_expression)),
    ),

    _ext_unary: $ => choice($.ext_unary, $._ext_primary),

    ext_unary: $ => choice(
      prec(8,  seq(alias(ci('no'),  $.op_no),  $._ext_expression)),
      prec(11, seq(alias(ci('obj'), $.op_obj), $._ext_expression)),
      prec(11, seq(alias(ci('loc'), $.op_loc), $._ext_expression)),
      prec(18, seq(alias('-', $.op_neg),       $._ext_expression)),
    ),

    _ext_primary: $ => choice(
      $.paren_expr,
      $.number_literal,
      $.string,
      $.code_block,
      $.tuple,
      $.user_func_call,
      $.ext_func_call,
      $.variable_ref,
    ),

    // ── multiline expression (& IS operator, newlines are whitespace) ───────

    _ml_expression: $ => choice($.ml_binary, $._ml_unary),

    ml_binary: $ => choice(
      prec.left(6,  seq($._ml_expression, optional($._nls), alias(ci('or'),  $.op_or),  optional($._nls), $._ml_expression)),
      prec.left(7,  seq($._ml_expression, optional($._nls), alias(ci('and'), $.op_and), optional($._nls), $._ml_expression)),
      prec.left(10, seq($._ml_expression, optional($._nls), $._cmp_op, optional($._nls), $._ml_expression)),
      prec.left(12, seq($._ml_expression, optional($._nls), alias('&', $.op_amp), optional($._nls), $._ml_expression)),
      prec.left(14, seq($._ml_expression, optional($._nls), alias(choice('+', '-'), $.op_arith), optional($._nls), $._ml_expression)),
      prec.left(16, seq($._ml_expression, optional($._nls), alias(ci('mod'), $.op_mod), optional($._nls), $._ml_expression)),
      prec.left(17, seq($._ml_expression, optional($._nls), alias(choice('*', '/'), $.op_arith), optional($._nls), $._ml_expression)),
    ),

    _ml_unary: $ => choice($.ml_unary, $._ml_primary),

    ml_unary: $ => choice(
      prec(8,  seq(alias(ci('no'),  $.op_no),  optional($._nls), $._ml_expression)),
      prec(11, seq(alias(ci('obj'), $.op_obj), optional($._nls), $._ml_expression)),
      prec(11, seq(alias(ci('loc'), $.op_loc), optional($._nls), $._ml_expression)),
      prec(18, seq(alias('-', $.op_neg),       optional($._nls), $._ml_expression)),
    ),

    _ml_primary: $ => choice(
      $.paren_expr,
      $.number_literal,
      $.string,
      $.code_block,
      $.tuple,
      $.ml_user_func_call,
      $.ml_func_call,
      $.ml_variable_ref,
    ),

    // ══════════════════════════════════════════════════════════════════════════
    // SHARED EXPRESSION COMPONENTS
    // ══════════════════════════════════════════════════════════════════════════

    _cmp_op: $ => alias(choice('<>', '!', '<=', '=<', '>=', '=>', '=', '<', '>'), $.op_cmp),

    // PEG: parenthesizedExpression = "(" mws multilineExpression mws ")"
    // Inside parens → multiline context
    paren_expr: $ => seq('(', optional($._nls), $._ml_expression, optional($._nls), ')'),

    // ── Argument lists ──────────────────────────────────────────────────────

    // PEG: nonAmpersandArgument1plusList
    _na_arg_list: $ => seq($._na_expression, repeat(seq(',', $._na_expression))),

    // PEG: argument1plusList (with &)
    _ext_arg_list: $ => seq($._ext_expression, repeat(seq(',', $._ext_expression))),

    // PEG: parenthesizedArgument1plusList = "(" mws multilineArgList mws ")"
    paren_args: $ => prec(1, seq(
      '(', optional($._nls),
      $._ml_expression, optional($._nls),
      repeat(seq(',', optional($._nls), $._ml_expression, optional($._nls))),
      ')',
    )),

    // ══════════════════════════════════════════════════════════════════════════
    // TUPLES
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: tuple = emptyTuple | nonEmptyTuple | emptyPseudoTuple | nonEmptyPseudoTuple
    tuple: $ => choice(
      $.bracket_tuple,
      $.paren_tuple,
    ),

    // PEG: emptyTuple / nonEmptyTuple — [...]
    bracket_tuple: $ => seq(
      '[', optional($._nls),
      optional(seq(
        $._ml_expression, optional($._nls),
        repeat(seq(',', optional($._nls), $._ml_expression, optional($._nls))),
      )),
      ']',
    ),

    // PEG: emptyPseudoTuple / nonEmptyPseudoTuple — (...)
    // Must have 0 or 2+ elements (1 element = paren_expr, not tuple)
    paren_tuple: $ => choice(
      seq('(', optional($._nls), ')'),     // empty
      seq(                                     // 2+ elements
        '(', optional($._nls),
        $._ml_expression, optional($._nls),
        repeat1(seq(',', optional($._nls), $._ml_expression, optional($._nls))),
        ')',
      ),
    ),

    // ══════════════════════════════════════════════════════════════════════════
    // VARIABLES
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: variableRef = varNameWithPrefix (ws (emptyArrayIndex | arrayIndex))?
    // Keyword exclusion (including builtin function names) is handled by
    // tree-sitter's keyword-extraction via the `word` directive: any lexeme
    // that matches a declared keyword token is emitted as that token, not
    // as `identifier_text`.  Consequences (matching the PEG):
    //   - `$mid = $src` does NOT parse as assignment; it falls through to
    //     `implicit_statement → na_binary` (two zero-arg func calls around
    //     an `=` comparison).
    //   - `$if`, `$and`, `$play`, etc. cannot be variable names either.
    variable_ref: $ => prec.right(seq(
      field('prefix', optional($.type_prefix)),
      field('name', $.identifier_text),
      optional(field('index', $.array_index)),
    )),

    // PEG: multilineVariableRef = varNameWithPrefix (mws (emptyArrayIndex | arrayIndex))?
    // No prec.right — GLR conflict declared so the parser forks on '\n':
    // one version tries array access (x\n[0]), the other reduces as a bare
    // variable and lets ml_binary handle 'x\n+ y'.
    ml_variable_ref: $ => seq(
      field('prefix', optional($.type_prefix)),
      field('name', $.identifier_text),
      optional(seq(optional($._nls), field('index', $.array_index))),
    ),

    // PEG: arrayIndex = "[" mws multilineArgument1plusList mws "]"
    // PEG: emptyArrayIndex = "[" mws "]"
    array_index: $ => seq(
      '[', optional($._nls),
      optional(seq(
        $._ml_expression, optional($._nls),
        repeat(seq(',', optional($._nls), $._ml_expression, optional($._nls))),
      )),
      ']',
    ),

    // QSP type prefixes: $ = string, # = numeric (explicit), % = tuple.
    // No prefix means numeric variable.
    type_prefix: $ => choice('#', '$', '%'),

    // ══════════════════════════════════════════════════════════════════════════
    // STRINGS
    // ══════════════════════════════════════════════════════════════════════════

    // All QSP strings can contain <<expr>> interpolation.
    // Strings CAN span multiple lines (PEG: rawSingleQuotedChar = ~"'" any).
    // Unified: interpolated string IS the string — if no <<>> appears, it's
    // simply a string without subexpressions.
    string: $ => choice(
      $.single_quoted_string,
      $.double_quoted_string,
    ),

    single_quoted_string: $ => seq(
      "'",
      repeat(choice($.string_interpolation, "''", token(prec(1, /[^'<]+/)), token(prec(-1, '<')))),
      "'",
    ),

    double_quoted_string: $ => seq(
      '"',
      repeat(choice($.string_interpolation, '""', token(prec(1, /[^"<]+/)), token(prec(-1, '<')))),
      '"',
    ),

    // PEG: stringSubexpression = "<<" mws multilineExpression mws ">>"
    //
    // Invalid expressions inside <<>> produce ERROR nodes, which are
    // reported as info-level diagnostics (not errors) by the LSP.
    string_interpolation: $ => seq(
      '<<', optional($._nls), $._ml_expression, optional($._nls), '>>',
    ),

    number_literal: $ => /\d+/,

    // ══════════════════════════════════════════════════════════════════════════
    // CODE BLOCKS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: codeBlock = syntacticCodeBlock | rawCodeBlock
    //   Try syntactic first; fall back to raw when syntactic fails to balance.
    //
    // Tree-sitter is GLR (not PEG).  We unify both alternatives in one
    // rule by listing the syntactic statement-group first (preferred via
    // higher static prec) and the raw-text fallbacks last.  When the
    // syntactic alternative produces a valid parse, it wins; when it
    // would introduce ERROR/MISSING (e.g. an unbalanced `if a=0:` inside
    // `{<qhtml>... if a=0: ...</qhtml>}`), the raw alternative absorbs
    // the offending span as anonymous text instead, preventing the
    // unclosed block from swallowing the rest of the location.
    //
    // The per-char raw token uses `token(prec(-10, ...))` so it loses
    // the lexer race against every normal lexical token (identifiers,
    // keywords, numbers, operators, …).  It only fires when the
    // syntactic branch can't make progress at the current position.
    code_block: $ => seq(
      '{',
      repeat(choice(
        prec(2, $._stmt_group_in_code_block),
        // raw_code_block (nested `{...}`) and per-char text are the only
        // raw fallbacks here.  We deliberately do NOT include
        // `_raw_string` — that token is greedy and would beat the
        // syntactic `string` rule at lex time, regressing bare-string
        // code blocks.  Strings still parse via the syntactic path's
        // `string` primary; only the gaps BETWEEN strings (or other
        // syntactic constructs) need raw fallback.
        prec(0, $.raw_code_block),
        // Exclude whitespace from the per-char raw token so the lexer
        // doesn't consume leading spaces as raw text (which would pull
        // them into adjacent token spans like `statement_name` and
        // break downstream consumers that compare keyword text).
        // Whitespace continues to be handled by `extras`.
        prec(-1, token(prec(-10, /[^{}'"\s]/))),
      )),
      '}',
    ),

    // PEG: rawCodeBlock = "{" (rawStringLiteral | rawCodeBlock | rawCodeBlockChar)* "}"
    // PEG: rawCodeBlockChar = ~("{" | "}" | "'" | "\"") any
    // Recursive, handles balanced braces. Also used inside comments/noteStrings.
    raw_code_block: $ => prec(-1, seq(
      '{',
      repeat(choice(
        $._raw_string,                   // string literals (balance quotes)
        $.raw_code_block,                // nested
        /[^{}'"][^{}]*/,                 // regular chars (bulk match)
      )),
      '}',
    )),

    // Raw string literal — used in comments, noteStrings, and rawCodeBlock.
    // NOT the same as $.string (which has interpolation support).
    // PEG: rawSingleQuotedString = "'" (apostropheEscape | rawSingleQuotedChar)* "'"
    _raw_string: $ => choice(
      alias(token(seq("'", repeat(choice("''", /[^']/)), "'")), $.raw_string),
      alias(token(seq('"', repeat(choice('""', /[^"]/)), '"')), $.raw_string),
    ),

    // ══════════════════════════════════════════════════════════════════════════
    // IDENTIFIERS
    // ══════════════════════════════════════════════════════════════════════════

    // PEG: varName = ~(keyword delimiterChar) ~digit nonDelimiterChar+
    // delimiterChar = space | tab | newline | & ' " ( ) [ ] = ! < > + - / * : , { }
    //
    // Keyword exclusion at the grammar level is handled by tree-sitter's
    // `word:` keyword extraction: at any parse state where both a keyword
    // token and `identifier_text` could match, the keyword wins. This
    // covers statement-start positions (`if`, `act`, `loop`, `local`,
    // `set`, `let`), function/statement names, and operator words.
    //
    // It does NOT cover block-continuation keywords (`end`, `while`,
    // `step`, `else`, `elseif`). They only appear as fields inside
    // if/act/loop block rules and never contest with `identifier_text`
    // at the lexer level, so a line like `end = 1` inside a code block
    // parses as a valid assignment to a variable named `end`. That
    // divergence from the PEG spec is instead flagged by a post-parse
    // lint — see `checkReservedWordMisuse` in src/parser/extractErrors.ts.
    //
    // First char: non-delimiter, non-digit, non-typePrefix (#$%), non-@
    //   (`@` at start always introduces a user call: `@foo` / `@@foo`).
    // Rest: any non-delimiter char — `@` and `.` ARE allowed inside a name,
    //   so `a@b`, `a.b`, `foo@bar` are valid variable / location names
    //   (matches PEG `nonDelimiterChar+`, where delimiter set has no `@`/`.`).
    identifier_text: $ => /[^\s&'"()\[\]=!<>+\-\/*:,{}@0-9#$%][^\s&'"()\[\]=!<>+\-\/*:,{}]*/,

    // ══════════════════════════════════════════════════════════════════════════
    // WHITESPACE / NEWLINES
    // ══════════════════════════════════════════════════════════════════════════

    // lineContinuation = <space or tab> "_" newline
    // line_continuation is declared in externals and handled by src/scanner.c

    _newline: $ => /\r?\n/,

    // One or more newlines — used in multiline contexts (parens, brackets, <<>>)
    // as optional($._nls) to mean "zero or more newlines".
    _nls: $ => prec.right(repeat1($._newline)),
  },
});
