/**
 * The TextMate grammar (syntaxes/qsp.tmLanguage.json), which colours a file
 * before the language server's tokens arrive and wherever they don't.
 *
 * Why
 * ───
 * - QSP ignores the text outside locations. Coloured as code, a quote in it
 *   opened a string that ran into the next location, and every string after
 *   it was coloured inside out. Code rules apply only inside a location;
 *   the text around them is a comment.
 * - A location starts and ends where buildLocationIndex says it does, or
 *   the colours and the analysis disagree about what is code.
 * - A block ends at its first unpaired `}`, even on a comment line; read
 *   otherwise, the block stayed open and coloured the rest of the file.
 *   The Sublime Text package's syntax showcase (test/fixtures) is
 *   tokenized here as VS Code does it, with vscode-textmate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as oniguruma from 'vscode-oniguruma';
import * as textmate from 'vscode-textmate';
import { buildLocationIndex } from '../src/common/locations';

interface Rule { begin?: string; end?: string; match?: string; include?: string; patterns?: Rule[] }
const grammar = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'syntaxes', 'qsp.tmLanguage.json'), 'utf8')) as
  { patterns: Rule[]; repository: Record<string, Rule> };

describe('qsp.tmLanguage.json', () => {
  it('has only locations and the text around them at the top level', () => {
    expect(grammar.patterns).toEqual([{ include: '#location' }, { include: '#outside-location' }]);
    expect(grammar.repository.location.patterns).toEqual([{ include: '#code' }]);
    // `$self` would bring the top-level rules into a block.
    expect(JSON.stringify(grammar)).not.toContain('$self');
  });

  it('ends a comment or an end note in a block at an unpaired }, which ends the block', () => {
    // QSP ends a block at its first `}` that pairs with nothing, whatever
    // the line is: `dynamic {*pl a` / `! comment}` closes the block.
    expect(grammar.repository['code-block'].patterns).toEqual([
      { include: '#comment-in-block' }, { include: '#end-note-in-block' }, { include: '#code' },
    ]);
    // Where an end pattern first matches in `} more`: at the `}` or at the line's end.
    const endsAt = (name: string) => new RegExp(grammar.repository[name].end!).exec('} more')!.index;
    for (const name of ['comment-in-block', 'end-note-in-block']) {
      expect(endsAt(name), name).toBe(0);
      // Braces and quotes in it pair up first.
      expect(grammar.repository[name].patterns).toContainEqual({ include: '#comment-brace' });
    }
    // Outside a block a `}` is text.
    expect(endsAt('comment')).toBe(6);
    expect(endsAt('end-note')).toBe(6);
  });

  it('starts and ends a location where the location index does', () => {
    const begin = new RegExp(grammar.repository.location.begin!);
    const end = new RegExp(grammar.repository.location.end!);
    const text = ['# первая', 'pl 1', '--- первая ---', '#', '#   ', ' # не локация', '# вторая  ', '--', ''].join('\n');
    const index = buildLocationIndex(text);
    const lines = text.split('\n');
    expect(index.map(l => l.startLine)).toEqual(lines.flatMap((l, i) => (begin.test(l) ? [i] : [])));
    expect(index.map(l => l.endLine)).toEqual(lines.flatMap((l, i) => (end.test(l) ? [i] : [])));
  });
});

// ── The whole showcase, tokenized as VS Code does ───────────────────

interface Token { text: string; scopes: string[] }

describe('qsp.tmLanguage.json on syntax_test_qsp.qsps', () => {
  const grammarPath = path.join(__dirname, '..', 'syntaxes', 'qsp.tmLanguage.json');
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'syntax_test_qsp.qsps'), 'utf8');
  const lines = text.split('\n');
  let tokens: Token[][];
  let tokenize: (text: string) => Token[][];

  beforeAll(async () => {
    const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
    await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
    const registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      }),
      loadGrammar: async () => textmate.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath),
    });
    const qsp = (await registry.loadGrammar('source.qsp'))!;
    tokenize = (code) => {
      let stack = textmate.INITIAL;
      return code.split('\n').map((line) => {
        const result = qsp.tokenizeLine(line, stack);
        stack = result.ruleStack;
        return result.tokens.map(t => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
      });
    };
    tokens = tokenize(text);
  });

  // 1-based, as an editor shows them.
  const line = (n: number) => tokens[n - 1];
  const has = (n: number, scope: string) => line(n).some(t => t.scopes.includes(scope));

  it('starts and ends every location where the location index does', () => {
    const starts: number[] = [], ends: number[] = [];
    tokens.forEach((ts, i) => {
      if (ts.some(t => t.scopes.includes('meta.location.header.qsp'))) starts.push(i);
      if (ts.some(t => t.scopes.includes('meta.location.end.qsp'))) ends.push(i);
    });
    const index = buildLocationIndex(text);
    expect(starts).toEqual(index.map(l => l.startLine));
    expect(ends).toEqual(index.map(l => l.endLine));
  });

  it('colours the text outside locations as a comment, whatever it holds', () => {
    const inside = new Set(buildLocationIndex(text).flatMap(l => Array.from({ length: l.endLine - l.startLine + 1 }, (_, k) => l.startLine + k)));
    tokens.forEach((ts, i) => {
      if (inside.has(i)) return;
      for (const t of ts) {
        if (t.text.trim()) expect(t.scopes, `line ${i + 1}`).toEqual(['source.qsp', 'comment.block.outside-location.qsp']);
      }
    });
  });

  it('closes a block at the } that ends a comment line or an end note', () => {
    for (const n of [136, 144, 151, 158]) {
      const last = line(n).filter(t => t.text.trim()).at(-1)!;
      expect(last.text, `line ${n}`).toBe('}');
      expect(last.scopes, `line ${n}`).toContain('punctuation.section.block.end.qsp');
    }
    // After the block: code again, not the block's.
    for (const n of [137, 138, 145, 152]) expect(has(n, 'meta.code-block.qsp'), `line ${n}`).toBe(false);
    // A } that pairs with nothing outside a block stays in its comment.
    for (const n of [134, 137, 140, 141, 153]) {
      expect(line(n).filter(t => t.text.trim()).every(t => t.scopes.includes('comment.line.bang.qsp')), `line ${n}`).toBe(true);
    }
  });

  it('reads the note after end as a note, up to & or the line end', () => {
    const note = (n: number) => line(n).filter(t => t.scopes.includes('variable.other.enummember.note.qsp')).map(t => t.text).join('');
    expect(note(94)).toBe(' весь текст после правильного end подсвечивается как комментарий');
    expect(note(102)).toBe(' однострочный комментарий прерывается на ');
    expect(has(102, 'string.quoted.double.qsp')).toBe(true);
    // Braces in a note span lines, as in a comment.
    expect(note(105)).toContain('продолжается здесь');
  });

  it('ends the code of an exec: link with its href, whether or not the string closes the tag', () => {
    // `</a>` in another string (or nowhere) used to keep the link open
    // past its string's quote, inverting every string after it.
    const code = [
      '# a',
      `$args['hr.b']='<a href="exec:gosub ''back.varriors''" class="plain" id="avs_back_btn">'`,
      "$args['hr.b.n']='Назад'",
      `$args['/hr.b']="</a>"`,
      `*pl "<a href='exec:gt ""дом""'>x"`,
      `*pl '<a href=''exec:gt "лес"''>z' + 'после'`,
      `*pl '<a href="exec:gt 1'`,
      'x = 1',
      '--- a ---',
    ].join('\n');
    const lines = tokenize(code);
    const stringEnds = (n: number) => lines[n].filter(t => t.scopes.includes('punctuation.definition.string.end.qsp')).length;
    expect(lines[1].find(t => t.text === 'exec')!.scopes).toContain('keyword.control.exec.qsp');
    expect(lines[1].at(-1)!.scopes).toContain('punctuation.definition.string.end.qsp');
    expect(lines[1].find(t => t.text.includes('class='))!.scopes.at(-1)).toBe('string.quoted.single.qsp');
    // Every string on lines 1–6 closes on its own line.
    expect([1, 2, 3, 4, 5, 6].map(stringEnds)).toEqual([2, 2, 2, 1, 2, 1]);
    expect(lines[7].map(t => t.scopes.at(-1))).toContain('variable.other.readwrite.qsp');
    expect(lines[8][0].scopes).toContain('meta.location.end.qsp');
  });

  it('colours ? alone as no value, and ?abc as a name', () => {
    const [, line] = tokenize('# a\n$x = ? & y = ?abc + (?)\n--- a ---');
    expect(line.filter(t => t.scopes.includes('constant.language.undefined.qsp')).map(t => t.text)).toEqual(['?', '?']);
    expect(line.some(t => t.text.includes('?abc') && t.scopes.includes('constant.language.undefined.qsp'))).toBe(false);
  });

  it('colours #obj and #loc as the operators, and #objx as a variable', () => {
    const [, line] = tokenize("# a\nx = #obj 'k' + #loc('s') + #objx\n--- a ---");
    const scopeOf = (text: string) => line.find(t => t.text === text)!.scopes.at(-1);
    expect([scopeOf('obj'), scopeOf('loc'), scopeOf('objx')]).toEqual(['keyword.operator.word.qsp', 'keyword.operator.word.qsp', 'variable.other.readwrite.qsp']);
  });

  it('colours alias as a keyword only when a name follows it', () => {
    const [, first, second] = tokenize("# a\nalias a, $b = 'x', 'y'\nalias = 1\n--- a ---");
    expect(first.find(t => t.text === 'alias')!.scopes.at(-1)).toBe('keyword.other.statement.qsp');
    expect(second.find(t => t.text.trim() === 'alias')!.scopes.at(-1)).toBe('variable.other.readwrite.qsp');
  });

  it('colours the whole file as it did when checked', async () => {
    const compact = tokens.map((ts, i) => `${i + 1}: ` + ts
      .filter(t => t.text.length > 0)
      .map(t => `${JSON.stringify(t.text)} ${t.scopes.slice(1).filter(sc => sc !== 'meta.location.qsp').map(sc => sc.replace(/\.qsp$/, '')).join(' > ') || '-'}`)
      .join(' | ')).join('\n') + '\n';
    await expect(compact).toMatchFileSnapshot('__snapshots__/syntax_test_qsp.tokens.txt');
  });
});
