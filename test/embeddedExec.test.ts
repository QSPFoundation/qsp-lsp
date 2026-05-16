/**
 * Tests for the embedded `exec:` link scanner.
 *
 * Verifies that references inside `<a href="exec:CODE">…</a>` are
 * lifted out of the host string and projected back into the host
 * `LocationSymbols` with correctly remapped positions, while strings
 * in identifier-position contexts are skipped.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { extractEmbeddedExec } from '../src/parser/embeddedExec';
import type { DocumentSymbols } from '../src/parser/symbolTable';
import { initParser } from './testHelpers';
import { buildFileAggregates } from '../src/server/aggregation';
import { buildLocationIndex } from '../src/common/locations';
import { computeDiagnostics, type DiagnosticSettings } from '../src/server/diagnostics';

const URI = 'test://exec';

const parser = new QspTreeSitterParser();
beforeAll(() => initParser(parser));

function run(code: string): DocumentSymbols {
  const tree = parser.parse(URI, code)!;
  const { symbols } = extractSymbols(
    tree, URI, undefined, undefined,
    (t) => parser.parseOnce(t),
  );
  return symbols;
}

describe('embedded exec: link extraction', () => {
  describe('basic emission', () => {
    it('emits a location ref for gs inside an exec link', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''target''">click</a>'
---
# target
pl 'hi'
---
`,
      );
      const home = symbols.getLocation('home')!;
      const ref = home.locationRefs.get('target');
      expect(ref).toBeDefined();
      expect(ref!.references.length).toBe(1);
      // The ref position must land inside the host string, not at column 0.
      expect(ref!.references[0].line).toBe(1);
      expect(ref!.references[0].column).toBeGreaterThan(0);
    });

    it('emits refs for gt and xgt as well', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gt ''a''">a</a><a href="exec:xgt ''b''">b</a>'
---
# a
---
# b
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('a')).toBeDefined();
      expect(home.locationRefs.get('b')).toBeDefined();
    });

    it('supports double-quoted strings as the host and exec body', () => {
      const symbols = run(
        `# home
pl "<a href='exec:gs ""dest""'>x</a>"
---
# dest
---
`,
      );
      const ref = symbols.getLocation('home')!.locationRefs.get('dest');
      expect(ref).toBeDefined();
    });

    it('emits multiple links from one string', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''a''">A</a> and <a href="exec:gs ''b''">B</a>'
---
# a
---
# b
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('a')).toBeDefined();
      expect(home.locationRefs.get('b')).toBeDefined();
    });

    it('emits object and action refs', () => {
      const symbols = run(
        `# home
pl '<a href="exec:addobj ''sword''">take</a>'
pl '<a href="exec:delobj ''sword''">drop</a>'
pl '<a href="exec:delact ''Look''">x</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.objectRefs.get('sword')).toBeDefined();
      expect(home.objectRefs.get('sword')!.references.length).toBe(2);
      expect(home.actionRefs.get('look')).toBeDefined();
    });

    it('emits a user-call ref for @ inside exec', () => {
      const symbols = run(
        `# home
pl '<a href="exec:@helper">go</a>'
---
# helper
---
`,
      );
      const ref = symbols.getLocation('home')!.locationRefs.get('helper');
      expect(ref).toBeDefined();
      // Bare `@name` parses as either a user_call_statement (gosub) or a
      // user_func_call (func) depending on sub-tree context; both are valid.
      expect(['gosub', 'func']).toContain(ref!.references[0].callType);
    });

    it('emits a location ref for the func() / desc() expression', () => {
      const symbols = run(
        `# home
pl '<a href="exec:x = func(''helper'')">x</a>'
pl '<a href="exec:y = desc(''helper2'')">y</a>'
---
# helper
---
# helper2
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('helper')).toBeDefined();
      expect(home.locationRefs.get('helper2')).toBeDefined();
    });

    it('emits unary op_loc reference', () => {
      const symbols = run(
        `# home
pl '<a href="exec:if loc ''target'': pl 1">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });
  });

  describe('quote escapes', () => {
    it('handles a body whose call argument contains an apostrophe', () => {
      // Host quote `'` doubles to `''` for itself, AND the body's
      // inner string also doubles its quote.  After host decode the
      // body is `addobj 'it''s a hat'` — the standard symbol
      // extractor keeps inner doubled quotes verbatim in the ref name,
      // matching how the same statement would be recorded outside an
      // exec body.
      const symbols = run(
        `# home
pl '<a href="exec:addobj ''it''''s a hat''">x</a>'
---
`,
      );
      const def = symbols.getLocation('home')!.objectRefs.get("it''s a hat");
      expect(def).toBeDefined();
    });

    it('handles a double-quoted host with single-quoted body args', () => {
      const symbols = run(
        `# home
pl "<a href='exec:gs ""target""'>x</a>"
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('handles a body using doubled host-quotes around the inner arg', () => {
      // Classic form: host `'`, body uses doubled `''` to wrap inner.
      // After host decode: body = `gs 'target'`.
      const symbols = run(
        `# home
pl '<a href="exec:gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('handles a host string whose body has no escapes at all', () => {
      // Author switched HTML-attribute quote to `'` so they could keep
      // the QSP arg in plain `"..."`.  Host decode is a no-op.
      const symbols = run(
        `# home
pl '<a href=''exec:gs "target"''>x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });
  });

  describe('position', () => {
    it('reports the ref at a precise span inside the host string body', () => {
      const code = `# home\npl '<a href="exec:gs ''target''">x</a>'\n---\n`;
      const symbols = run(code);
      const ref = symbols.getLocation('home')!.locationRefs.get('target');
      expect(ref).toBeDefined();
      const r = ref!.references[0];
      expect(r.line).toBe(1);
      const line = code.split('\n')[r.line];
      const span = line.substring(r.column, r.endColumn);
      // Span should be inside the host string body — not the whole
      // string — and refer to the target location name.
      expect(span.toLowerCase()).toContain('target');
      expect(span).not.toContain('exec:');
      expect(span).not.toContain('<a href=');
    });

    it('handles bodies where a literal precedes the target call', () => {
      // Proper sub-parsing must recognise `gs 'target'` even when the
      // body contains an earlier expression that confuses regex-based
      // scanning (e.g. `n=''x'' & gs ''target''`).
      const code = `# home
pl '<a href="exec:n=''x'' & gs ''target''">x</a>'
---
# target
---
`;
      const symbols = run(code);
      const ref = symbols.getLocation('home')!.locationRefs.get('target');
      expect(ref).toBeDefined();
      expect(ref!.references[0].line).toBe(1);
    });
  });

  describe('classifier (identifier-position strings are skipped)', () => {
    it('skips strings used as act labels', () => {
      const symbols = run(
        `# home
act '<a href="exec:gs ''nope''">ignored</a>':
  pl 1
end
---
# nope
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });

    it('skips first arg of addobj / delobj / modobj / resetobj / delact', () => {
      const symbols = run(
        `# home
addobj '<a href="exec:gs ''x''">y</a>'
delobj '<a href="exec:gs ''x''">y</a>'
modobj '<a href="exec:gs ''x''">y</a>', 'new'
delact '<a href="exec:gs ''x''">y</a>'
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('x'))
        .toBeUndefined();
    });

    it('skips ALL args of modobj (not just arg 0)', () => {
      const symbols = run(
        `# home
modobj 'old', '<a href="exec:gs ''nope''">y</a>'
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });

    it('skips first arg of gs / gt / gosub / goto (location identifiers)', () => {
      const symbols = run(
        `# home
gs '<a href="exec:gs ''nope''">y</a>'
gt '<a href="exec:gs ''nope2''">y</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('nope')).toBeUndefined();
      expect(home.locationRefs.get('nope2')).toBeUndefined();
    });

    it('skips first arg of func() / desc() / loc()', () => {
      const symbols = run(
        `# home
x = func('<a href="exec:gs ''nope''">y</a>')
y = desc('<a href="exec:gs ''nope2''">y</a>')
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('nope')).toBeUndefined();
      expect(home.locationRefs.get('nope2')).toBeUndefined();
    });

    it('skips strcomp regex pattern arg', () => {
      const symbols = run(
        `# home
if strcomp(s, '<a href="exec:gs ''nope''">y</a>'): pl 1
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });

    it('skips strings used as subscripts', () => {
      const symbols = run(
        `# home
$arr['<a href="exec:gs ''nope''">y</a>'] = 1
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });

    it('skips dynamic / dyneval arg', () => {
      const symbols = run(
        `# home
dynamic '<a href="exec:gs ''nope''">y</a>'
x = dyneval('<a href="exec:gs ''nope2''">y</a>')
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('nope')).toBeUndefined();
      expect(home.locationRefs.get('nope2')).toBeUndefined();
    });

    it('does NOT skip a non-first arg of gs (extra args are values)', () => {
      const symbols = run(
        `# home
gs 'real', '<a href="exec:gs ''found''">y</a>'
---
# real
---
# found
---
`,
      );
      // 'real' is the gs target; the second arg is the data string which
      // CAN end up rendered to HTML if real prints it.
      expect(symbols.getLocation('home')!.locationRefs.get('found'))
        .toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('does nothing when the string does not contain exec:', () => {
      const symbols = run(
        `# home
pl '<a href="https://example.com">plain link</a>'
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);
    });

    it('ignores malformed exec links (no closing quote / no anchor)', () => {
      const symbols = run(
        `# home
pl 'exec:nope'
pl '<a href="exec:gs ''ok''">good</a>'
---
# ok
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('nope')).toBeUndefined();
      expect(home.locationRefs.get('ok')).toBeDefined();
    });

    it('handles empty exec body without crashing', () => {
      const symbols = run(
        `# home
pl '<a href="exec:">click</a>'
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);
    });

    it('runs automatically as part of extractSymbols', () => {
      const tree = parser.parse(URI, `# home
pl '<a href="exec:gs ''skip''">x</a>'
---
# skip
---
`)!;
      const { symbols } = extractSymbols(
        tree, URI, undefined, undefined,
        (t) => parser.parseOnce(t),
      );
      expect(symbols.getLocation('home')!.locationRefs.get('skip'))
        .toBeDefined();
    });

    it('is a no-op when parseFn is not provided', () => {
      const tree = parser.parse(URI, `# home
pl '<a href="exec:gs ''skip''">x</a>'
---
# skip
---
`)!;
      const { symbols } = extractSymbols(tree, URI);
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);
    });

    it('respects the reusedLocations skip set', () => {
      const tree = parser.parse(URI, `# home
pl '<a href="exec:gs ''target''">x</a>'
---
# target
---
`)!;
      // Build symbols WITHOUT the embedded scan (omit parseFn).
      const { symbols } = extractSymbols(tree, URI);
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);

      const reused = new Set(['home']);
      extractEmbeddedExec(
        tree, URI, symbols,
        (t) => parser.parseOnce(t),
        reused,
      );
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);

      // Sanity: without the skip set, the same call DOES extract.
      extractEmbeddedExec(
        tree, URI, symbols,
        (t) => parser.parseOnce(t),
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('skips strings in nested non-target contexts within argument lists', () => {
      // First arg of `play` is a file path identifier — skipped.
      const symbols = run(
        `# home
play '<a href="exec:gs ''nope''">y</a>'
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });

    it('emits refs from exec bodies in two separate location blocks', () => {
      const symbols = run(
        `# a
pl '<a href="exec:gs ''x''">y</a>'
---
# b
pl '<a href="exec:gs ''x''">y</a>'
---
# x
---
`,
      );
      expect(symbols.getLocation('a')!.locationRefs.get('x')).toBeDefined();
      expect(symbols.getLocation('b')!.locationRefs.get('x')).toBeDefined();
    });

    it('emits refs from exec bodies with multiple statements', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''one'' & gs ''two''">go</a>'
---
# one
---
# two
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('one')).toBeDefined();
      expect(home.locationRefs.get('two')).toBeDefined();
    });

    it('case-insensitive HREF / EXEC matching', () => {
      const symbols = run(
        `# home
pl '<A HREF="EXEC:gs ''X''">y</A>'
---
# x
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('x')).toBeDefined();
    });
  });

  describe('integration with unresolved-location diagnostic surface', () => {
    it('emitted refs are visible in locationRefs for diagnostic walking', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''missing''">click</a>'
---
`,
      );
      // 'missing' is referenced but never defined; aggregator/diagnostic
      // pass will surface this via locationRefs.
      const ref = symbols.getLocation('home')!.locationRefs.get('missing');
      expect(ref).toBeDefined();
      // callType set so the diagnostic pass can distinguish kinds.
      expect(ref!.references[0].callType).toBe('gosub');
    });

    it('aggregates multiple refs to the same target across links', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''same''">one</a>'
pl '<a href="exec:gs ''same''">two</a>'
---
# same
---
`,
      );
      const ref = symbols.getLocation('home')!.locationRefs.get('same');
      expect(ref).toBeDefined();
      expect(ref!.references.length).toBe(2);
    });
  });

  describe('HTML edge cases', () => {
    it('matches when href is not the first attribute', () => {
      const symbols = run(
        `# home
pl '<a class="btn" id="go" href="exec:gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('matches self-closing anchor with trailing slash', () => {
      const symbols = run(
        `# home
pl '<a href="exec:gs ''target''" />'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('handles extra whitespace around equals', () => {
      const symbols = run(
        `# home
pl '<a  href  =  "exec:gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('does not match unrelated attributes containing the substring href', () => {
      const symbols = run(
        `# home
pl '<a data-href="exec:gs ''nope''" title="x">y</a>'
---
`,
      );
      // `data-href` is not href (\b boundary on `href` rejects this).
      expect(symbols.getLocation('home')!.locationRefs.get('nope'))
        .toBeUndefined();
    });
  });

  describe('exec body parsing', () => {
    it('emits refs from inside an if-block in the exec body', () => {
      const symbols = run(
        `# home
pl '<a href="exec:if x = 1: gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('does not crash on a body with syntax errors', () => {
      const symbols = run(
        `# home
pl '<a href="exec:if x = : gs">broken</a>'
---
`,
      );
      // Garbage body simply yields no refs; the host scan continues.
      expect(symbols.getLocation('home')).toBeDefined();
      expect(symbols.getLocation('home')!.locationRefs.size).toBe(0);
    });

    it('extracts from the right operand of a concatenated string', () => {
      const symbols = run(
        `# home
pl 'prefix: ' & '<a href="exec:gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });

    it('extracts from a string used as an assignment RHS', () => {
      const symbols = run(
        `# home
$msg = '<a href="exec:gs ''target''">x</a>'
---
# target
---
`,
      );
      expect(symbols.getLocation('home')!.locationRefs.get('target'))
        .toBeDefined();
    });
  });

  describe('full pipeline: variables and diagnostics', () => {
    it('tracks variable definitions and reads inside an exec body', () => {
      const symbols = run(
        `# home
pl '<a href="exec:x = 1 & y = x + 2 & pl y">go</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      const xs = [...home.ownedVariables]
        .filter((s) => s.nameLower === 'x');
      const ys = [...home.ownedVariables]
        .filter((s) => s.nameLower === 'y');
      expect(xs.length).toBeGreaterThan(0);
      expect(ys.length).toBeGreaterThan(0);
      // x should have both a definition and a read
      const x = xs[0]!;
      expect(x.hasValueDefinition).toBe(true);
      // y should be defined too
      expect(ys[0]!.hasValueDefinition).toBe(true);
    });

    it('places exec-body locals in an isolated scope', () => {
      const symbols = run(
        `# home
local outer
outer = 1
pl '<a href="exec:local inner & inner = 2">x</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      const outer = [...home.ownedVariables].find((s) => s.nameLower === 'outer');
      const inner = [...home.ownedVariables].find((s) => s.nameLower === 'inner');
      expect(outer).toBeDefined();
      expect(inner).toBeDefined();
      // Both flagged local but they must live in different scopes —
      // exec scope is isolated so inner cannot see outer.
      expect(outer!.scopeId).not.toBe(inner!.scopeId);
      expect(inner!.isLocal).toBe(true);
    });

    it('records object DEFINITIONS (addobj) and references (obj/delobj) from exec', () => {
      const symbols = run(
        `# home
pl '<a href="exec:addobj ''sword''">take</a>'
pl '<a href="exec:if obj(''sword''): delobj ''sword''">drop</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      const ref = home.objectRefs.get('sword');
      expect(ref).toBeDefined();
      // addobj counts as the definition site.
      expect(ref!.definition).toBeDefined();
    });

    it('records action definitions inside an exec body', () => {
      const symbols = run(
        `# home
pl '<a href="exec:act ''Look'': pl ''boo''">go</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      const look = home.actions.find((a) => a.nameLower === 'look');
      expect(look).toBeDefined();
    });

    it('captures location refs across the full call vocabulary', () => {
      const symbols = run(
        `# home
pl '<a href="exec:@user_proc">a</a>'
pl '<a href="exec:y = func(''user_fn'')">b</a>'
---
# user_proc
---
# user_fn
result = 1
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.locationRefs.get('user_proc')).toBeDefined();
      expect(home.locationRefs.get('user_fn')).toBeDefined();
    });
  });

  describe('precise sub-statement positions inside the host string', () => {
    // The merge layer projects every sub-tree position through the
    // single-line translator so diagnostics underline the offending
    // sub-statement, not the whole host string.  Each test below
    // pins one diagnostic-bearing field to its precise span.

    const sliceOf = (code: string, line: number, col: number, endCol: number) =>
      code.split('\n')[line]!.substring(col, endCol);

    it('resolvedDynamicBlocks.callLoc + blockLocs are precise', () => {
      // `dyneval({ ... })` inside an exec body — the callLoc must
      // cover `dyneval({...})` and the blockLoc the `{...}`.
      const code = `# home
pl '<a href="exec:y = dyneval({ result = 1 })">click</a>'
---
`;
      const symbols = run(code);
      const home = symbols.getLocation('home')!;
      expect(home.resolvedDynamicBlocks.length).toBe(1);
      const d = home.resolvedDynamicBlocks[0]!;
      const callSpan = sliceOf(code, d.callLoc.line, d.callLoc.column, d.callLoc.endColumn);
      expect(callSpan).toContain('dyneval');
      expect(callSpan).toContain('result = 1');
      expect(callSpan.startsWith('dyneval')).toBe(true);
      expect(d.blockLocs.length).toBe(1);
      const blockSpan = sliceOf(
        code, d.blockLocs[0]!.line, d.blockLocs[0]!.column, d.blockLocs[0]!.endColumn);
      expect(blockSpan).toContain('result = 1');
      expect(blockSpan).not.toContain('dyneval');
    });

    it('untrackedDynamicVarCalls.loc pins just the dynamic call site', () => {
      // `dynamic $a + $b` is a complex first-arg expression — the
      // walker records an `untrackedDynamicVarCalls` entry whose loc
      // should cover only the `dynamic` statement.
      const code = `# home
pl '<a href="exec:dynamic $a + $b">click</a>'
---
`;
      const symbols = run(code);
      const home = symbols.getLocation('home')!;
      expect(home.untrackedDynamicVarCalls.length).toBeGreaterThan(0);
      const u = home.untrackedDynamicVarCalls[0]!;
      const span = sliceOf(code, u.loc.line, u.loc.column, u.loc.endColumn);
      expect(span.startsWith('dynamic')).toBe(true);
      expect(span).not.toContain('<a href=');
    });

    it('deferredDynamicVarCalls.loc pins just the dispatch call', () => {
      const code = `# home
pl 'text <a href="exec:y = dyneval($code)">click</a> more'
---
`;
      const symbols = run(code);
      const home = symbols.getLocation('home')!;
      expect(home.deferredDynamicVarCalls.length).toBe(1);
      const c = home.deferredDynamicVarCalls[0]!;
      const span = sliceOf(code, c.loc.line, c.loc.column, c.loc.endColumn);
      expect(span).toContain('dyneval');
      expect(span).not.toContain('<a href=');
      expect(span).not.toContain('text');
    });

    it('unreachableLabels records sub-body label after `&` chain', () => {
      // A label after `&` in an inline chain is unreachable at runtime
      // — the standard walker pushes it onto `unreachableLabels`.
      // The merger must lift it (with translated position).
      const code = `# home
pl '<a href="exec:pl 1 & :lbl">click</a>'
---
`;
      const symbols = run(code);
      const home = symbols.getLocation('home')!;
      expect(home.unreachableLabels.length).toBeGreaterThan(0);
      const u = home.unreachableLabels[0]!;
      const span = sliceOf(code, u.line, u.column, u.endColumn);
      expect(span).toContain('lbl');
      expect(span).not.toContain('<a href=');
    });
  });

  describe('dynamic-dispatch resolution from inside exec bodies', () => {
    // QSP semantics: an `<a href="exec:CODE">` link body runs at click
    // time in the player's CURRENT call frame.  By click time the
    // host location (and any caller frames that propagated locals
    // into it) have long returned, so:
    //
    //   • caller-propagated locals MUST NOT shadow the global lookup;
    //   • the host's OWN globals are visible (globals are namespace-
    //     scoped, not frame-scoped) and must be valid candidates.
    //
    // These tests pin the merge tag + aggregator's exec-frame
    // semantics for var-mediated `dynamic`/`dyneval` dispatch.

    it('merges exec-body dynamic calls into deferredDynamicVarCalls (not unresolvedDynamicVarCalls)', () => {
      const symbols = run(
        `# home
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      // Exec-body calls are routed to their own dedicated list \u2014
      // semantically they live in a different frame than the host's
      // own unresolved dispatches, so mixing them would let the
      // propagated-locals channel apply incorrect frame semantics.
      expect(home.unresolvedDynamicVarCalls.length).toBe(0);
      expect(home.deferredDynamicVarCalls.length).toBe(1);
      const call = home.deferredDynamicVarCalls[0]!;
      expect(call.varBaseName).toBe('code');
      expect(call.kind).toBe('dyneval');
    });

    it('resolves exec-body dyneval to a code-block global written in the SAME host location', () => {
      const symbols = run(
        `# home
$code = { result = 42 }
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('home');
      expect(dispatches).toBeDefined();
      expect(dispatches!.length).toBe(1);
      const d = dispatches![0]!;
      expect(d.kind).toBe('dyneval');
      expect(d.varBaseName).toBe('code');
      expect(d.candidates.length).toBe(1);
      expect(d.candidates[0]!.providerLoc).toBe('home');
      expect(d.candidates[0]!.writesResult).toBe(true);
    });

    it('resolves exec-body dyneval to a code-block global in a DIFFERENT location', () => {
      const symbols = run(
        `# init
$code = { result = 7 }
---
# home
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('home');
      expect(dispatches).toBeDefined();
      expect(dispatches!.length).toBe(1);
      expect(dispatches![0]!.candidates.map(c => c.providerLoc).sort())
        .toEqual(['init']);
    });

    it('resolves exec-body dynamic to BOTH host global AND other-location global', () => {
      const symbols = run(
        `# init
$code = { result = 1 }
---
# home
$code = { result = 2 }
pl '<a href="exec:dynamic $code">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('home');
      expect(dispatches).toBeDefined();
      expect(dispatches!.length).toBe(1);
      expect(dispatches![0]!.candidates.map(c => c.providerLoc).sort())
        .toEqual(['home', 'init']);
    });

    it('does NOT shadow exec-body dispatch with caller-propagated local of host', () => {
      // `caller` propagates `local $code = { ... }` to `host`.  The
      // host's exec body `dyneval($code)` runs at click time in a
      // future frame where `caller`'s frame has returned, so the
      // propagated local does NOT shadow the global namespace lookup.
      // The exec-body call must still resolve against the project-
      // wide global binding written in `init`.
      const symbols = run(
        `# caller
local $code = { result = 1 }
gs 'host'
---
# init
$code = { result = 2 }
---
# host
pl '<a href="exec:dynamic $code">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('host');
      expect(dispatches).toBeDefined();
      expect(dispatches!.length).toBe(1);
      // The propagated `local $code` from `caller` must NOT shadow;
      // the global from `init` is the (only) candidate.
      expect(dispatches![0]!.candidates.map(c => c.providerLoc).sort())
        .toEqual(['init']);
    });

    it('does NOT flow exec-body dispatch through propagated-locals channel', () => {
      // Even when host receives a propagated `local $code` whose value
      // is a code block, the exec body's `dyneval($code)` must not
      // attach the block's bodyWrites to the caller-local via
      // externalLocalBindings — those writes happen in a future frame
      // that has no connection to `caller`'s `$code`.
      const symbols = run(
        `# caller
local $code = { tmp = 99 }
gs 'host'
pl $tmp
---
# host
pl '<a href="exec:dynamic $code">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      // The caller's local `$code` QspSymbol must NOT have an
      // externalLocalBindings entry sourced from the exec-body
      // dispatch.  (It may have other entries from non-exec channels;
      // assert there are no entries pointing into the exec body's
      // bodyWrites.)
      const caller = symbols.getLocation('caller')!;
      const codeSym = [...caller.ownedVariables].find(
        s => s.isLocal && s.nameLower === 'code',
      )!;
      const ext = agg.externalLocalBindings.get(codeSym) ?? [];
      // No flowback target named `tmp` (would only appear if exec-body
      // dispatch was incorrectly routed through propagated-locals).
      expect(ext.find(e => e.varNameLower === 'tmp')).toBeUndefined();
    });

    it('resolves dynamic-call WITHIN the same exec body via the sub-walker (no fromExecBody needed)', () => {
      // The exec body defines `$code` locally to itself and dispatches
      // it — fully resolvable by the sub-walker against the exec
      // body's own bindings.  The merge then carries the resolved
      // block (not an unresolvedDynamicVarCalls entry).
      const symbols = run(
        `# home
pl '<a href="exec:$code = { result = 1 } & dynamic $code">click</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      // No unresolved call — the sub-walker resolved it.
      expect(home.unresolvedDynamicVarCalls.length).toBe(0);
      // The resolved dynamic block is merged into the host.
      expect(home.resolvedDynamicBlocks.length).toBeGreaterThan(0);
    });

    it('exec-body local code-block shadows host global at the inner dispatch', () => {
      // The exec body declares its OWN `local $code = { ... }` AND
      // dispatches it in the same body.  The sub-walker resolves
      // against the exec-body-internal local — the host's global
      // `$code` is NOT a candidate.  No deferredDynamicVarCalls
      // entry is emitted because the call is fully resolved
      // before merge.
      const symbols = run(
        `# home
$code = { x = 0 }
pl '<a href="exec:local $code = { x = 1 } & dynamic $code">click</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.deferredDynamicVarCalls.length).toBe(0);
      expect(home.unresolvedDynamicVarCalls.length).toBe(0);
      // The exec-body-internal dispatch was resolved by the sub-walker.
      expect(home.resolvedDynamicBlocks.length).toBeGreaterThan(0);
    });

    it('exec-body dispatch with NO matching global anywhere emits no cross-loc entry', () => {
      // `$missing` has no global binding in any location.  The merge
      // adds it to `deferredDynamicVarCalls`, but the aggregator's
      // exec-body pass finds no provider and emits no entry —
      // gracefully handled, no errors.
      const symbols = run(
        `# home
pl '<a href="exec:y = dyneval($missing)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      expect(symbols.getLocation('home')!.deferredDynamicVarCalls.length).toBe(1);
      expect(agg.crossLocationDispatches.get('home')).toBeUndefined();
    });

    it('exec-body dispatch with extra args records argCount correctly', () => {
      // `dyneval($code, 10, 20)` inside an exec body — the extra
      // positional args must be preserved through the merge and
      // surface on the resolved CrossLocationDispatch entry.
      const symbols = run(
        `# init
$code = { result = args[0] + args[1] }
---
# home
pl '<a href="exec:y = dyneval($code, 10, 20)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('home')!;
      expect(dispatches.length).toBe(1);
      expect(dispatches[0]!.argCount).toBe(2);
      expect(dispatches[0]!.candidates[0]!.argsUsage?.maxLiteralIdx).toBe(1);
    });

    it('exec-body dispatch ignores local code-block bindings in other locations', () => {
      // `local $code = {…}` in another location is purely local to
      // that location's frame — it does NOT establish a global the
      // exec body could resolve against.  Only true globals qualify.
      const symbols = run(
        `# elsewhere
local $code = { result = 1 }
---
# home
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      expect(agg.crossLocationDispatches.get('home')).toBeUndefined();
    });

    it('exec-body dispatch ignores non-code-block global values (e.g. string)', () => {
      // `$code = "foo"` is a global but not a code-block, so it cannot
      // be a dispatch target.  No cross-loc entry.
      const symbols = run(
        `# init
$code = 'foo'
---
# home
pl '<a href="exec:y = dyneval($code)">click</a>'
---
`,
      );
      const agg = buildFileAggregates(symbols, URI);
      expect(agg.crossLocationDispatches.get('home')).toBeUndefined();
    });

    it('multiple exec-body dispatches in one location all surface', () => {
      // Multiple exec links in the same host location, each with its
      // own dynamic/dyneval — every call must land in
      // deferredDynamicVarCalls and each resolves independently.
      const symbols = run(
        `# init
$a = { result = 1 }
$b = { result = 2 }
---
# home
pl '<a href="exec:y = dyneval($a)">A</a>'
pl '<a href="exec:y = dyneval($b)">B</a>'
---
`,
      );
      const home = symbols.getLocation('home')!;
      expect(home.deferredDynamicVarCalls.length).toBe(2);
      const agg = buildFileAggregates(symbols, URI);
      const dispatches = agg.crossLocationDispatches.get('home')!;
      expect(dispatches.length).toBe(2);
      const vars = dispatches.map(d => d.varBaseName).sort();
      expect(vars).toEqual(['a', 'b']);
    });
  });

  describe('end-to-end diagnostics from inside exec bodies', () => {
    // The merge pipeline lifts warnings, bindings, dynamic-call buckets
    // and syntax errors into the host LocationSymbols.  These tests run
    // the full `computeDiagnostics` surface and verify that each
    // diagnostic class actually fires for code that lives inside an
    // `<a href="exec:…">` body — and that the diagnostic range lies
    // strictly inside the host string, not at column 0.

    const ALL_OFF: DiagnosticSettings = {
      duplicateLocations: false,
      duplicateLabels: false,
      duplicateActions: false,
      unreachableLabels: false,
      unclosedLocations: false,
      uninitializedVariables: false,
      unresolvedLocationRefs: false,
      unresolvedLabelRefs: false,
      unresolvedActionRefs: false,
      unresolvedObjectRefs: false,
      unusedLocations: false,
      unusedLabels: false,
      unusedVariables: false,
      unusedObjects: false,
      invalidFunctionPrefix: false,
      invalidBuiltinArgCount: false,
      mixedVariablePrefixes: false,
      typeMismatch: false,
      mixedLocationCallTypes: false,
      inconsistentLocalPropagation: false,
      untrackedDynamicCalls: false,
      missingResultInFunctionCall: false,
      extraArgsToTargetWithoutArgs: false,
      shadowsCallFrameBuiltin: false,
      shadowsPropagatedLocal: false,
      maxErrorsPerLocation: 1000,
      maxLocationLines: 0,
    };

    function diagnose(code: string, overrides: Partial<DiagnosticSettings>, opts?: { parseExec?: boolean }) {
      const doc = TextDocument.create(URI, 'qsp', 1, code);
      const tree = parser.parse(URI, code)!;
      const parseExec = opts?.parseExec ?? true;
      const { symbols } = extractSymbols(
        tree, URI, undefined, undefined,
        parseExec ? (t) => parser.parseOnce(t) : undefined,
      );
      const locationIndex = buildLocationIndex(code);
      const settings = { ...ALL_OFF, ...overrides };
      return computeDiagnostics(doc, URI, locationIndex, settings, parser, new Map(), symbols);
    }

    /** Source span (substring on `loc.range.start.line`) covered by a diagnostic. */
    const sliceDiag = (code: string, d: { range: { start: { line: number; character: number }; end: { character: number } } }) =>
      code.split('\n')[d.range.start.line]!.substring(d.range.start.character, d.range.end.character);

    it('reports a syntax error inside an exec body as a diagnostic', () => {
      const code = `# home
pl '<a href="exec:if 1:">click</a>'
---
`;
      const diags = diagnose(code, {});  // syntax errors are always on
      // The host string line gets at least one error pointing inside the body.
      const lineText = code.split('\n')[1]!;
      const inExec = diags.filter(d =>
        d.range.start.line === 1
        && d.range.start.character > lineText.indexOf('exec:')
        && d.range.start.character < lineText.indexOf('">'),
      );
      expect(inExec.length).toBeGreaterThan(0);
    });

    it('uninitializedVariables fires for an unassigned read inside exec', () => {
      const code = `# home
pl '<a href="exec:pl q">click</a>'
---
`;
      const diags = diagnose(code, { uninitializedVariables: true });
      const hits = diags.filter(d => d.message === "Variable 'q' is used but never assigned");
      expect(hits.length).toBe(1);
      // Range must lie strictly inside the host string body.
      expect(hits[0]!.range.start.line).toBe(1);
      expect(sliceDiag(code, hits[0]!)).toBe('q');
    });

    it('typeMismatch fires for $string = numeric inside exec', () => {
      const code = `# home
pl '<a href="exec:$gold = 34">click</a>'
---
`;
      const diags = diagnose(code, { typeMismatch: true });
      const hits = diags.filter(d => d.message.startsWith('Type mismatch'));
      expect(hits.length).toBe(1);
      expect(hits[0]!.range.start.line).toBe(1);
      // Range underlines only the assignment statement, not the whole host.
      expect(sliceDiag(code, hits[0]!)).toBe('$gold = 34');
    });

    it('invalidBuiltinArgCount fires for too many args inside exec', () => {
      const code = `# home
pl '<a href="exec:$x = len(''a'', ''b'')">click</a>'
---
`;
      const diags = diagnose(code, { invalidBuiltinArgCount: true });
      const hits = diags.filter(d => /expects .* arguments, got/.test(d.message));
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.range.start.line).toBe(1);
      expect(sliceDiag(code, hits[0]!)).toBe('len');
    });

    it('invalidFunctionPrefix fires for an unsupported prefix inside exec', () => {
      const code = `# home
pl '<a href="exec:$x = $len(''abc'')">click</a>'
---
`;
      const diags = diagnose(code, { invalidFunctionPrefix: true });
      const hits = diags.filter(d => /does not support the .* prefix/.test(d.message));
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.range.start.line).toBe(1);
      expect(sliceDiag(code, hits[0]!)).toBe('$len');
    });

    it('deprecation warning fires for an outdated builtin inside exec', () => {
      const code = `# home
pl '<a href="exec:killqst">click</a>'
---
`;
      const diags = diagnose(code, {});
      const hits = diags.filter(d => /KILLQST.*outdated/.test(d.message));
      expect(hits.length).toBe(1);
      expect(hits[0]!.range.start.line).toBe(1);
      expect(sliceDiag(code, hits[0]!)).toBe('killqst');
    });

    it('unresolvedLocationRefs fires for a missing gs target inside exec', () => {
      const code = `# home
pl '<a href="exec:gs ''missing''">click</a>'
---
`;
      const diags = diagnose(code, { unresolvedLocationRefs: true });
      const hits = diags.filter(d => /Location 'missing' is not defined/i.test(d.message));
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.range.start.line).toBe(1);
    });

    it('reports NO embedded-exec diagnostics when parseFn is not supplied', () => {
      // Simulates `qsp.embeddedExec.enabled = false`: extractSymbols is
      // called without parseFn, so exec bodies stay opaque strings and
      // none of the sub-statement diagnostics fire.
      const code = `# home
pl '<a href="exec:$gold = 34 & pl q & killqst & $x = $len(''abc'')">click</a>'
---
`;
      const diags = diagnose(
        code,
        {
          typeMismatch: true,
          uninitializedVariables: true,
          invalidFunctionPrefix: true,
          invalidBuiltinArgCount: true,
        },
        { parseExec: false },
      );
      // No diagnostic should land inside the exec body.
      const lineText = code.split('\n')[1]!;
      const execStart = lineText.indexOf('exec:');
      const execEnd = lineText.indexOf('">');
      const inExec = diags.filter(d =>
        d.range.start.line === 1
        && d.range.start.character >= execStart
        && d.range.start.character < execEnd,
      );
      expect(inExec).toEqual([]);
    });

    it('emits each exec-body diagnostic exactly once (no double-merge)', () => {
      // Regression: a single exec link must not produce duplicate
      // diagnostics from the merge pipeline.
      const code = `# home
pl '<a href="exec:$gold = 34">click</a>'
---
`;
      const diags = diagnose(code, { typeMismatch: true });
      const tm = diags.filter(d => d.message.startsWith('Type mismatch'));
      expect(tm.length).toBe(1);
    });
  });
});
