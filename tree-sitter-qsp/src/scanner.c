/**
 * External scanner for tree-sitter-qsp.
 *
 * Handles six external token types:
 *
 * 1. LINE_CONTINUATION_EXT (" _\n")
 * 2. LOCATION_END_MARK_EXT ("--" at column 0)
 * 3. LOCATION_START_MARK_EXT ("#" at column 0)
 * 4. NEWLINE_OR_RBRACE_EXT
 * 5. INTP_RAW_BODY_SQ (raw `<<…>>` body with `''` inside a '-quoted string)
 * 6. INTP_RAW_BODY_DQ (raw `<<…>>` body with `""` inside a "-quoted string)
 */

#include "tree_sitter/parser.h"

enum {
  LINE_CONTINUATION,
  LOCATION_END_MARK,
  LOCATION_START_MARK,
  NEWLINE_OR_RBRACE,
  INTP_RAW_BODY_SQ,
  INTP_RAW_BODY_DQ,
};

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

bool tree_sitter_qsp_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;

  // During error recovery tree-sitter marks EVERY symbol valid.  The
  // raw-body scan is greedy, so it must never run in recovery mode —
  // outside of recovery the _sq/_dq tokens are mutually exclusive.
  bool in_recovery = valid_symbols[INTP_RAW_BODY_SQ] && valid_symbols[INTP_RAW_BODY_DQ];

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
    if (lexer->lookahead == '-') {
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

  if (valid_symbols[NEWLINE_OR_RBRACE]) {
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      lexer->advance(lexer, true);
    }

    if (lexer->lookahead == '}') {
      lexer->mark_end(lexer);
      lexer->result_symbol = NEWLINE_OR_RBRACE;
      return true;
    }

    if (lexer->lookahead == '\r') {
      lexer->advance(lexer, false);
    }
    if (lexer->lookahead == '\n') {
      lexer->advance(lexer, false);
      lexer->mark_end(lexer);
      lexer->result_symbol = NEWLINE_OR_RBRACE;
      return true;
    }

    return false;
  }

  if (!valid_symbols[LINE_CONTINUATION]) return false;
  if (lexer->lookahead != ' ' && lexer->lookahead != '\t') return false;

  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    lexer->advance(lexer, true);
  }

  if (lexer->lookahead != '_') return false;
  lexer->advance(lexer, false);

  if (lexer->lookahead == '\r') {
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != '\n') return false;
  lexer->advance(lexer, false);

  lexer->mark_end(lexer);
  lexer->result_symbol = LINE_CONTINUATION;
  return true;
}
