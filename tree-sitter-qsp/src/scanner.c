/**
 * External scanner for tree-sitter-qsp.
 *
 * Handles four external token types:
 *
 * 1. LINE_CONTINUATION_EXT (" _\n")
 * 2. LOCATION_END_MARK_EXT ("--" at column 0)
 * 3. LOCATION_START_MARK_EXT ("#" at column 0)
 * 4. NEWLINE_OR_RBRACE_EXT
 */

#include "tree_sitter/parser.h"

enum {
  LINE_CONTINUATION,
  LOCATION_END_MARK,
  LOCATION_START_MARK,
  NEWLINE_OR_RBRACE,
};

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
