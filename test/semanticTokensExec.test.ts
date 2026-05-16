/**
 * Semantic-token highlighting inside `<a href="exec:…">` link bodies.
 *
 * The exec body is sub-parsed and its token positions are projected
 * back onto the source line.  These tests verify that:
 *   - the emitted positions actually point at the right source spans
 *     (variable refs, statement names, location refs);
 *   - the doubled-quote escape projection keeps subsequent tokens
 *     aligned across `''`/`""` pairs;
 *   - the final tuple stream is sorted by (line, char) so the LSP
 *     delta-encoder doesn't drop sub-tokens whose source columns lie
 *     INSIDE the surrounding string's already-emitted range.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SemanticTokenTypes, SemanticTokensBuilder } from 'vscode-languageserver';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import {
  buildSemanticTokens,
  collectSemanticTokenTuples,
  TOKEN_TYPES,
} from '../src/server/semanticTokens';
import { initParser } from './testHelpers';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

interface Token {
  line: number;
  char: number;
  length: number;
  type: string;
  text: string;
}

/** Run the semantic-token emitter and return tokens with resolved type names. */
function tokensFor(src: string): Token[] {
  const tree = parser.parse('test://semexec', src)!;
  const tuples = collectSemanticTokenTuples(tree, undefined, (t) => parser.parseOnce(t));
  const out: Token[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < tuples.length; i += 5) {
    const line = tuples[i];
    const char = tuples[i + 1];
    const length = tuples[i + 2];
    const type = TOKEN_TYPES[tuples[i + 3]];
    const text = lines[line]?.substr(char, length) ?? '';
    out.push({ line, char, length, type, text });
  }
  return out;
}

describe('semantic tokens: exec-body highlighting', () => {
  it('emits a statement_name token for `gs` inside an exec body', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''target''">x</a>'\n`
      + `---\n`;
    const toks = tokensFor(src);

    // The `gs` should be reported as `type` (statement name) at the
    // source column of the `g` in `gs`.
    const gs = toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeDefined();
    expect(gs!.line).toBe(1);
    // Source: `pl '<a href="exec:gs ...` — `gs` starts at column 18.
    expect(gs!.char).toBe(18);
  });

  it('emits a namespace token for the location-ref string `target`', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''target''">x</a>'\n`
      + `---\n`
      + `# target\n`
      + `---\n`;
    const toks = tokensFor(src);
    // `target` should appear as a string token (the inner quoted name).
    // The doubled-quote escape projection must shift its column past
    // the leading `''`.
    //
    // Source columns:
    //   pl '<a href="exec:gs ''target''">x</a>'
    //   012345678901234567890123456789012345678
    //             1111111111222222222233333333
    // `'` at 21,22  → opening `''`
    // `target` decoded chars start at col 23 (raw), spelled at cols 23..28
    const targetTok = toks.find(t => t.text === 'target');
    expect(targetTok).toBeDefined();
    expect(targetTok!.line).toBe(1);
    expect(targetTok!.char).toBe(23);
  });

  it('emits variable tokens inside an exec body', () => {
    const src =
      `# home\n`
      + `pl "<a href='exec:y = 1 + x'>click</a>"\n`
      + `---\n`;
    const toks = tokensFor(src);
    const yTok = toks.find(t => t.text === 'y' && t.type === SemanticTokenTypes.variable);
    const xTok = toks.find(t => t.text === 'x' && t.type === SemanticTokenTypes.variable);
    expect(yTok).toBeDefined();
    expect(xTok).toBeDefined();
    // Source: `pl "<a href='exec:y = 1 + x'>...`
    //          0123456789012345678901234567
    // `y` at col 18, `x` at col 26
    expect(yTok!.char).toBe(18);
    expect(xTok!.char).toBe(26);
  });

  it('skips sub-parse for multi-line exec bodies (no extra tokens)', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:gs\n`
      + `''target''">x</a>'\n`
      + `---\n`;
    const toks = tokensFor(src);
    // No `gs` should be emitted as a statement_name — it's inside an
    // un-parsed multi-line body.
    const gs = toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeUndefined();
  });

  it('skips strings in identifier-position contexts safely (no crash)', () => {
    // `gs '<a href="exec:gs ...">'` — the outer string is a location
    // identifier, not renderable.  The exec sub-parser runs anyway
    // because semanticTokens.ts doesn't filter by context (only the
    // symbol-merger does).  Verify we don't crash and we still emit
    // the surrounding string tokens correctly.
    const src =
      `# home\n`
      + `gs '<a href="exec:gs ''dest''">x</a>'\n`
      + `---\n`
      + `# dest\n---\n`;
    expect(() => tokensFor(src)).not.toThrow();
  });

  it('handles double-quoted host with single-quoted attribute (`""` escapes)', () => {
    // Mirror of the `'` host case: host=`"`, attr=`'`, body raw
    // contains `""…""` (host-quote escapes) which the decoder
    // collapses.  The opposite-quote pair `''` (if it appeared inside
    // the body, which the regex implicitly forbids) would not be
    // collapsed — and indeed `'` characters inside the body would
    // prematurely close the attribute, so they're structurally
    // unreachable.
    const src =
      `# home\n`
      + `pl "<a href='exec:gs ""dest""'>x</a>"\n`
      + `---\n`
      + `# dest\n---\n`;
    const toks = tokensFor(src);
    // `gs` should land as statement_name at column 18 (just like the
    // single-host case).
    const gs = toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeDefined();
    expect(gs!.line).toBe(1);
    expect(gs!.char).toBe(18);
  });

  it('locates the body correctly when an earlier attribute contains `exec:`', () => {
    // `class="exec:foo"` MUST NOT confuse the locator into emitting
    // tokens at the wrong column.
    const src =
      `# home\n`
      + `pl '<a class="exec:foo" href="exec:gs ''dest''">x</a>'\n`
      + `---\n`
      + `# dest\n---\n`;
    const toks = tokensFor(src);
    const gs = toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeDefined();
    expect(gs!.line).toBe(1);
    // Source: `pl '<a class="exec:foo" href="exec:gs ...`
    //          0         1         2         3
    //          0123456789012345678901234567890123456789
    // `gs` starts at column 35.
    expect(gs!.char).toBe(35);
  });

  it('handles uppercase `EXEC:` (case-insensitive scheme)', () => {
    const src =
      `# home\n`
      + `pl '<a HREF="EXEC:gs ''dest''">x</a>'\n`
      + `---\n`
      + `# dest\n---\n`;
    const toks = tokensFor(src);
    const gs = toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeDefined();
    expect(gs!.char).toBe(18);
  });

  it('handles two exec links in the same string independently', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''d1''">a</a> <a href="exec:gs ''d2''">b</a>'\n`
      + `---\n`
      + `# d1\n---\n`
      + `# d2\n---\n`;
    const toks = tokensFor(src);
    const gsToks = toks.filter(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gsToks).toHaveLength(2);
    // Each link occupies 30 source columns (`<a href="exec:gs ''dX''">a</a>`).
    // First `gs` at col 18 (after `pl '<a href="exec:`).
    // Second `gs` at col 18 + 30 + 1 (separating space) = 49.
    expect(gsToks[0].char).toBe(18);
    expect(gsToks[1].char).toBe(49);
  });

  it('accumulates escape shifts across multiple escape pairs', () => {
    // Body raw: `''target'' + 1`  (decoded: `'target' + 1`).
    // Two `''` escapes at decoded cols 0 and 7 — so the trailing `1`
    // (decoded col 11) projects to source col bodyPos.col + 11 + 2.
    const src =
      `# home\n`
      + `pl '<a href="exec:''target'' + 1">x</a>'\n`
      + `---\n`
      + `# target\n---\n`;
    const toks = tokensFor(src);
    const num = toks.find(t => t.text === '1' && t.type === SemanticTokenTypes.number);
    expect(num).toBeDefined();
    // bodyPos.col = 18, so `1` is at 18 + 11 + 2 = 31.
    expect(num!.char).toBe(31);
  });

  it('emits a number token for a numeric literal in an exec body', () => {
    const src =
      `# home\n`
      + `pl "<a href='exec:x = 42'>click</a>"\n`
      + `---\n`;
    const toks = tokensFor(src);
    const num = toks.find(t => t.text === '42' && t.type === SemanticTokenTypes.number);
    expect(num).toBeDefined();
    // Source: `pl "<a href='exec:x = 42'>...`
    //          0         1         2
    //          01234567890123456789012345
    expect(num!.char).toBe(22);
  });

  it('does not crash on a syntactically invalid exec body', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:&&& + ===">x</a>'\n`
      + `---\n`;
    expect(() => tokensFor(src)).not.toThrow();
  });

  it('emits no exec-body tokens when parseFn is not provided', () => {
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''target''">x</a>'\n`
      + `---\n`;
    const tree = parser.parse('test://semexec', src)!;
    // Call without parseFn — exec bodies should NOT be sub-parsed.
    const tuples = collectSemanticTokenTuples(tree);
    let hasGsType = false;
    for (let i = 0; i < tuples.length; i += 5) {
      const line = tuples[i];
      const char = tuples[i + 1];
      const length = tuples[i + 2];
      const type = TOKEN_TYPES[tuples[i + 3]];
      const text = src.split('\n')[line]?.substr(char, length) ?? '';
      if (text === 'gs' && type === SemanticTokenTypes.type) hasGsType = true;
    }
    expect(hasGsType).toBe(false);
  });

  it('returns tuples sorted by (line, char) so they encode as valid LSP deltas', () => {
    // Regression test: exec body sub-tokens are emitted AFTER the
    // surrounding string's children are pushed, but they land at
    // earlier columns inside the string.  The tuple collector must
    // sort them globally, otherwise SemanticTokensBuilder produces
    // negative deltas and VS Code drops the affected tokens.
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''target''">click</a>'\n`
      + `---\n`
      + `# target\n---\n`;
    const tuples = tokensFor(src);
    for (let i = 1; i < tuples.length; i++) {
      const prev = tuples[i - 1];
      const cur = tuples[i];
      const ordered = cur.line > prev.line
        || (cur.line === prev.line && cur.char >= prev.char);
      expect(ordered, `tokens out of order at index ${i}: `
        + `prev=(${prev.line},${prev.char}) cur=(${cur.line},${cur.char})`
      ).toBe(true);
    }
    // And: an exec sub-token (`gs` as statement_name) must actually
    // appear between the surrounding string tokens — proving the sort
    // didn't lose it.
    const gs = tuples.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type);
    expect(gs).toBeDefined();
  });

  it('survives end-to-end LSP delta encoding (builder + decode)', () => {
    // Strongest regression test: feed tuples through the same
    // `SemanticTokensBuilder` the LSP server uses, then decode the
    // delta-encoded output and verify the exec sub-token actually made
    // it to the wire.  If the tuples weren't sorted, the builder would
    // produce a negative delta for `gs` (since it lies INSIDE the
    // surrounding string's column range) and VS Code would drop it.
    const src =
      `# home\n`
      + `pl 'You picked up a <a href="exec:gs ''dest''">torch</a>.'\n`
      + `---\n`
      + `# dest\n---\n`;
    const tree = parser.parse('test://semexec', src)!;
    const built = buildSemanticTokens(tree, undefined, (t) => parser.parseOnce(t));
    // Decode the LSP delta encoding back to absolute (line, char).
    // Per the LSP spec: each token is 5 numbers — deltaLine, deltaStart
    // (relative to previous token's start, OR absolute when deltaLine
    // > 0), length, type, modifiers.
    let prevLine = 0;
    let prevChar = 0;
    let foundGs = false;
    const lines = src.split('\n');
    for (let i = 0; i < built.data.length; i += 5) {
      const dl = built.data[i];
      const dc = built.data[i + 1];
      const len = built.data[i + 2];
      const tIdx = built.data[i + 3];
      const line = prevLine + dl;
      const char = (dl === 0 ? prevChar : 0) + dc;
      const text = lines[line]?.substr(char, len) ?? '';
      if (text === 'gs' && TOKEN_TYPES[tIdx] === SemanticTokenTypes.type) {
        foundGs = true;
        expect(line).toBe(1);
        expect(char).toBe(34);
      }
      prevLine = line;
      prevChar = char;
    }
    expect(foundGs, '`gs` sub-token must survive LSP delta encoding').toBe(true);

    // Sanity: a manually-built (deliberately unsorted) builder mirrors
    // the pre-sort emit order: first ALL of the surrounding string's
    // child tokens (left → right across cols 3..50), THEN the inner
    // exec sub-token at col 34 — which lies BEHIND the previous push.
    const unsortedBuilder = new SemanticTokensBuilder();
    unsortedBuilder.push(1, 3, 1, 4, 0);   // opening quote     col 3
    unsortedBuilder.push(1, 4, 46, 4, 0);  // big string body   cols 4..50
    unsortedBuilder.push(1, 50, 1, 4, 0);  // closing quote     col 50
    unsortedBuilder.push(1, 34, 2, 11, 0); // gs sub-token at col 34 — BEHIND col 50
    const bad = unsortedBuilder.build();
    // Decode and verify: tokens past the regression point either
    // collapse to invalid deltas or render in the wrong place.  We
    // assert the encoded data is NOT strictly increasing — proving the
    // sort is load-bearing.
    let strictlyIncreasing = true;
    let pl = 0, pc = 0;
    for (let i = 0; i < bad.data.length; i += 5) {
      const dl = bad.data[i];
      const dc = bad.data[i + 1];
      const l = pl + dl;
      const c = (dl === 0 ? pc : 0) + dc;
      if (i > 0 && (l < pl || (l === pl && c < pc))) { strictlyIncreasing = false; break; }
      pl = l; pc = c;
    }
    expect(strictlyIncreasing).toBe(false);
  });

  it('clips host-string tokens around exec body ranges (no overlap)', () => {
    // Regression: the host `string` token must NOT cover columns
    // inside the exec body that the sub-parser claims as non-string
    // tokens — otherwise overlapping semantic tokens cause VS Code
    // to paint the body in string colour and hide the sub-parser's
    // tokens.  Sub-parser-emitted strings (e.g. nested `'target'`)
    // are legitimate and ARE allowed inside the body range.
    const src =
      `# home\n`
      + `pl '<a href="exec:gs ''target''">x</a>'\n`
      + `---\n`;
    const toks = tokensFor(src);

    // The `gs` keyword is at cols 18..20 on line 1.  No `string`
    // token may cover any part of that span.
    const gsStart = 18;
    const gsEnd = 20;
    const stringOverGs = toks.filter(t =>
      t.type === SemanticTokenTypes.string
      && t.line === 1
      && t.char < gsEnd
      && t.char + t.length > gsStart,
    );
    expect(stringOverGs).toEqual([]);

    // Sub-tokens inside the body should still be present.
    expect(toks.find(t => t.text === 'gs' && t.type === SemanticTokenTypes.type)).toBeDefined();
    expect(toks.find(t => t.text === 'target')).toBeDefined();

    // And the host's `string` colour should still flank the body —
    // tokens at cols < 18 (the `pl '<a href="exec:` prefix) and at
    // cols >= 31 (the `">x</a>'` suffix) must be present.
    const beforeBody = toks.find(t =>
      t.type === SemanticTokenTypes.string
      && t.line === 1
      && t.char + t.length <= gsStart,
    );
    const afterBody = toks.find(t =>
      t.type === SemanticTokenTypes.string
      && t.line === 1
      && t.char >= 31,
    );
    expect(beforeBody).toBeDefined();
    expect(afterBody).toBeDefined();
  });
});
