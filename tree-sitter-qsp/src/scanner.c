/**
 * External scanner for tree-sitter-qsp.
 *
 * Handles these external token types:
 *
 * 1. LINE_CONTINUATION_EXT (" _\n", blanks allowed before the line break)
 * 2. LOCATION_END_MARK_EXT ("--" at column 0)
 * 3. LOCATION_START_MARK_EXT ("#" at column 0)
 * 4. INTP_RAW_BODY_SQ (raw `<<…>>` body with `''` inside a '-quoted string)
 * 5. INTP_RAW_BODY_DQ (raw `<<…>>` body with `""` inside a "-quoted string)
 * 6. ML_NL_OR … ML_NL_MUL (newlines before a binary operator in a
 *    multiline expression, one token per precedence level)
 * 7. BLOCK_BODY (the inside of a `{…}`, up to its closing brace)
 * 8. ALIAS_KEYWORD (`alias` when a name follows it)
 */

#include "tree_sitter/parser.h"

enum {
  LINE_CONTINUATION,
  LOCATION_END_MARK,
  LOCATION_START_MARK,
  INTP_RAW_BODY_SQ,
  INTP_RAW_BODY_DQ,
  ML_NL_OR,
  ML_NL_AND,
  ML_NL_CMP,
  ML_NL_AMP,
  ML_NL_ADD,
  ML_NL_MOD,
  ML_NL_MUL,
  BLOCK_BODY,
  ALIAS_KEYWORD,
};

static bool is_hspace(int32_t c) { return c == ' ' || c == '\t'; }

// Characters that cannot continue an identifier (mirrors identifier_text in
// grammar.js), so `or(` is the operator but `orange` is a name.
static bool ends_word(int32_t c) {
  switch (c) {
    case 0: case ' ': case '\t': case '\r': case '\n': case '\f': case '\v':
    case '&': case '\'': case '"': case '(': case ')': case '[': case ']':
    case '=': case '!': case '<': case '>': case '+': case '-': case '/':
    case '*': case ':': case ',': case '{': case '}':
      return true;
    default:
      return false;
  }
}

static int32_t lower_ascii(int32_t c) { return (c >= 'A' && c <= 'Z') ? c + 32 : c; }

// Consume `word` case-insensitively and require a word boundary after it.
static bool match_keyword(TSLexer *lexer, const char *word) {
  for (const char *p = word; *p; p++) {
    if (lower_ascii(lexer->lookahead) != *p) return false;
    lexer->advance(lexer, false);
  }
  return ends_word(lexer->lookahead);
}

// ALIAS (QSP 5.9.6) starts a statement only when a name follows it, as in
// `aliasMarker &delimiterChar ws variableList`: in 5.9.5 `alias = 1` assigns
// to a variable named alias, and a keyword token would always beat the name
// at the start of a statement. The token is the word; the name is peeked.
static bool scan_alias(TSLexer *lexer) {
  if (!match_keyword(lexer, "alias")) return false;
  lexer->mark_end(lexer);
  if (!is_hspace(lexer->lookahead)) return false;
  while (is_hspace(lexer->lookahead)) lexer->advance(lexer, false);
  int32_t c = lexer->lookahead;
  if (c == '$' || c == '#' || c == '%') return true;
  return !ends_word(c) && c != '@' && !(c >= '0' && c <= '9');
}

/**
 * Newlines inside a multiline expression, when a binary operator follows.
 * The token covers only the newlines (and the blanks between them); the
 * operator is peeked, not consumed, and picks which of the ML_NL_* tokens
 * is emitted. Returns false when no operator follows or its token is not
 * valid here, and the internal lexer then produces a plain `_newline`.
 */
static bool scan_ml_newline(TSLexer *lexer, const bool *valid_symbols) {
  bool saw_newline = false;
  for (;;) {
    if (lexer->lookahead == '\r') lexer->advance(lexer, false);
    if (lexer->lookahead != '\n') break;
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    saw_newline = true;
    while (is_hspace(lexer->lookahead)) lexer->advance(lexer, false);
  }
  if (!saw_newline) return false;

  int symbol;
  switch (lower_ascii(lexer->lookahead)) {
    case '&': symbol = ML_NL_AMP; break;
    case '+': case '-': symbol = ML_NL_ADD; break;
    case '*': case '/': symbol = ML_NL_MUL; break;
    case '=': case '!': symbol = ML_NL_CMP; break;
    case '<': case '>': {
      // `>>` closes an interpolation and `<<` opens one; neither is an operator.
      int32_t first = lexer->lookahead;
      lexer->advance(lexer, false);
      if (lexer->lookahead == first) return false;
      symbol = ML_NL_CMP;
      break;
    }
    case 'o':
      if (!match_keyword(lexer, "or")) return false;
      symbol = ML_NL_OR;
      break;
    case 'a':
      if (!match_keyword(lexer, "and")) return false;
      symbol = ML_NL_AND;
      break;
    case 'm':
      if (!match_keyword(lexer, "mod")) return false;
      symbol = ML_NL_MOD;
      break;
    default:
      return false;
  }
  if (!valid_symbols[symbol]) return false;
  lexer->result_symbol = symbol;
  return true;
}

/**
 * Scan a raw `<<…>>` interpolation body whose host string is quoted with
 * `host_quote`.  Called with the lexer positioned just past the `<<`.
 *
 * QSP escaping rule: EVERY literal host-quote character inside the host
 * string is doubled in source — at any nesting depth — and a LONE host
 * quote always terminates the host string.  The default lexer treats a
 * doubled host quote inside `<<…>>` as a host-string escape, which
 * garbles the parse.  This scan recognises the body as one opaque token
 * instead; the LSP decodes the doubled quotes and re-parses the body.
 *
 * The token is only emitted when the body actually contains a doubled
 * host quote (returns false otherwise) so clean interpolations keep the
 * precise inline expression parse.
 *
 * Tracking, in DECODED terms, whether we are inside an inner string
 * lets us treat `>>`, `<<` and host quotes inside inner string literals
 * as plain content:
 *   - a run of N source host-quotes = N/2 decoded quotes (+ lone
 *     terminator if N is odd); an odd number of DECODED quotes toggles
 *     the inner Q-string state (when not inside an R-string);
 *   - a run of N source other-quotes toggles the inner R-string state
 *     when N is odd (when not inside a Q-string).
 */
static bool scan_intp_raw_body(TSLexer *lexer, int32_t host_quote) {
  const int32_t Q = host_quote;
  const int32_t R = (host_quote == '\'') ? '"' : '\'';

  // Decoded inner-string state: 0 = code, 1 = inside Q-quoted inner
  // string, 2 = inside R-quoted inner string.
  int str = 0;
  // `<<` nesting depth (only counted in code state).
  unsigned depth = 1;
  bool saw_doubled = false;

  lexer->mark_end(lexer);

  for (;;) {
    if (lexer->eof(lexer)) {
      // Unterminated — fall back to the inline parse / normal error
      // recovery.
      return false;
    }
    int32_t c = lexer->lookahead;

    if (c == Q) {
      // Consume the run of host quotes pairwise.
      unsigned pairs = 0;
      bool lone = false;
      while (lexer->lookahead == Q) {
        lexer->advance(lexer, false);
        if (lexer->lookahead == Q) {
          lexer->advance(lexer, false);
          lexer->mark_end(lexer);
          pairs++;
        } else {
          lone = true;
          break;
        }
      }
      if (pairs > 0) {
        saw_doubled = true;
        if ((pairs & 1) && str != 2) str = (str == 0) ? 1 : 0;
      }
      if (lone) {
        // A lone host quote terminates the HOST string regardless of
        // decoded nesting; end the body before it.  The grammar will
        // record the missing `>>`.
        return saw_doubled;
      }
      continue;
    }

    if (c == R) {
      unsigned n = 0;
      while (lexer->lookahead == R) {
        lexer->advance(lexer, false);
        lexer->mark_end(lexer);
        n++;
      }
      if ((n & 1) && str != 1) str = (str == 0) ? 2 : 0;
      continue;
    }

    if (c == '>' && str == 0) {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '>') {
        if (depth == 1) {
          // Closing `>>` of this interpolation; body ends before it.
          return saw_doubled;
        }
        depth--;
        lexer->advance(lexer, false);
      }
      lexer->mark_end(lexer);
      continue;
    }

    if (c == '<' && str == 0) {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '<') {
        depth++;
        lexer->advance(lexer, false);
      }
      lexer->mark_end(lexer);
      continue;
    }

    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
  }
}

void *tree_sitter_qsp_external_scanner_create(void) {
  return NULL;
}

void tree_sitter_qsp_external_scanner_destroy(void *payload) {
  (void)payload;
}

unsigned tree_sitter_qsp_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_qsp_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

// The inside of a `{…}`, up to its closing brace, found the way QSP finds
// it: by balancing braces and quotes, whatever the text is. A doubled
// quote inside a string closes and reopens it, which leaves the same state.
static bool scan_block_body(TSLexer *lexer) {
  unsigned depth = 0;
  bool any = false;
  while (!lexer->eof(lexer)) {
    int32_t c = lexer->lookahead;
    if (c == '}') {
      if (depth == 0) break;
      depth--;
    } else if (c == '{') {
      depth++;
    } else if (c == '\'' || c == '"') {
      lexer->advance(lexer, false);
      while (!lexer->eof(lexer) && lexer->lookahead != c) lexer->advance(lexer, false);
      if (lexer->eof(lexer)) {
        any = true;
        break;
      }
    }
    lexer->advance(lexer, false);
    any = true;
  }
  lexer->mark_end(lexer);
  return any;
}

bool tree_sitter_qsp_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;

  // During error recovery tree-sitter marks EVERY symbol valid.  The
  // raw-body scan is greedy, so it must never run in recovery mode —
  // outside of recovery the _sq/_dq tokens are mutually exclusive.
  bool in_recovery = valid_symbols[INTP_RAW_BODY_SQ] && valid_symbols[INTP_RAW_BODY_DQ];

  if (!in_recovery && valid_symbols[BLOCK_BODY]) {
    if (!scan_block_body(lexer)) return false;
    lexer->result_symbol = BLOCK_BODY;
    return true;
  }

  uint32_t col = lexer->get_column(lexer);

  if (col == 0) {
    // LOCATION_END_MARK ("--") is emitted UNCONDITIONALLY — without
    // checking valid_symbols[LOCATION_END_MARK].  This is deliberate:
    // when a location body has an unclosed block (e.g. `if x=1:` with
    // no matching `end`), the parser is in a state where
    // LOCATION_END_MARK is NOT in valid_symbols.  Adding the gate
    // causes the scanner to refuse `--`, leaving the `-` characters
    // unmatched, which collapses the rest of the file into one giant
    // ERROR and loses every subsequent location_block.  The
    // unconditional emit acts as a hard recovery boundary that lets
    // tree-sitter resync at the next `# loc` even when the previous
    // location is broken — matching user intent for QSP source.
    //
    // Between locations, where a `#` header is what the parser expects,
    // "--" is plain text instead: txt2gam looks only for `#` there, and
    // authors draw tables and dividers with dashes. Emitting the end mark
    // there turned the rest of the inter-location text into an ERROR. In
    // recovery every symbol is valid, so the end mark stays a boundary.
    if (lexer->lookahead == '-' && !(valid_symbols[LOCATION_START_MARK] && !in_recovery)) {
      lexer->advance(lexer, false);
      if (lexer->lookahead == '-') {
        lexer->advance(lexer, false);
        lexer->mark_end(lexer);
        lexer->result_symbol = LOCATION_END_MARK;
        return true;
      }
      return false;
    }

    // LOCATION_START_MARK ("#" at column 0) IS gated by valid_symbols,
    // unlike LOCATION_END_MARK.  Rationale: `#` has a second meaning
    // as the numeric-variable type prefix (e.g. `#score = 100`).  When
    // the parser is inside a location body, LOCATION_START_MARK is not
    // in valid_symbols, so refusing to emit here lets the internal
    // lexer match `#` as `type_prefix` instead.
    if (valid_symbols[LOCATION_START_MARK] && lexer->lookahead == '#') {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);
      lexer->result_symbol = LOCATION_START_MARK;
      return true;
    }
  }

  if (!in_recovery && (valid_symbols[INTP_RAW_BODY_SQ] || valid_symbols[INTP_RAW_BODY_DQ])) {
    // The raw body is only valid immediately after `<<`.  Line
    // continuation (an extra) is also valid here; give it first shot
    // when the lookahead could start one, since the raw-body scan
    // consumes lookahead irrecoverably for other external tokens.
    if (valid_symbols[LINE_CONTINUATION] &&
        (lexer->lookahead == ' ' || lexer->lookahead == '\t')) {
      while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        lexer->advance(lexer, true);
      }
      if (lexer->lookahead == '_') {
        lexer->advance(lexer, false);
        // QSP trims every line before joining those that end in ` _`.
        while (is_hspace(lexer->lookahead)) lexer->advance(lexer, false);
        if (lexer->lookahead == '\r') {
          lexer->advance(lexer, false);
        }
        if (lexer->lookahead == '\n') {
          lexer->advance(lexer, false);
          lexer->mark_end(lexer);
          lexer->result_symbol = LINE_CONTINUATION;
          return true;
        }
        // The consumed `_` (and possible `\r`) are plain body content;
        // the raw-body scan below continues from here.
      }
    }
    bool sq = valid_symbols[INTP_RAW_BODY_SQ];
    if (scan_intp_raw_body(lexer, sq ? '\'' : '"')) {
      lexer->result_symbol = sq ? INTP_RAW_BODY_SQ : INTP_RAW_BODY_DQ;
      return true;
    }
    return false;
  }

  // Only states right after a multiline operand accept these tokens, and
  // any of them being valid means the lookahead is examined here first.
  if (!in_recovery &&
      (valid_symbols[ML_NL_OR] || valid_symbols[ML_NL_AND] || valid_symbols[ML_NL_CMP] ||
       valid_symbols[ML_NL_AMP] || valid_symbols[ML_NL_ADD] || valid_symbols[ML_NL_MOD] ||
       valid_symbols[ML_NL_MUL]) &&
      (lexer->lookahead == '\r' || lexer->lookahead == '\n')) {
    // Only on the newline itself: blanks before it arrive earlier as their
    // own extra token, and a ` _` line continuation starts with a blank, so
    // it must reach the LINE_CONTINUATION scan below instead. On false the
    // lexer rewinds and lexes a plain `_newline`.
    return scan_ml_newline(lexer, valid_symbols);
  }

  // The blanks before a statement reach the scanner too, so ALIAS is
  // looked for after them, where a line continuation would start.
  bool alias_valid = !in_recovery && valid_symbols[ALIAS_KEYWORD];
  if (!valid_symbols[LINE_CONTINUATION] && !alias_valid) return false;
  bool blank = false;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, true);
    blank = true;
  }

  if (alias_valid && lower_ascii(lexer->lookahead) == 'a') {
    if (!scan_alias(lexer)) return false;
    lexer->result_symbol = ALIAS_KEYWORD;
    return true;
  }

  if (!valid_symbols[LINE_CONTINUATION] || !blank) return false;
  if (lexer->lookahead != '_') return false;
  lexer->advance(lexer, false);
  // QSP trims every line before joining those that end in ` _`.
  while (is_hspace(lexer->lookahead)) lexer->advance(lexer, false);

  if (lexer->lookahead == '\r') {
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != '\n') return false;
  lexer->advance(lexer, false);

  lexer->mark_end(lexer);
  lexer->result_symbol = LINE_CONTINUATION;
  return true;
}
