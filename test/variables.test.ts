import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { LocationSymbols, type QspSymbol } from '../src/parser/symbolTable';
import { buildLocationIndex } from '../src/common/locations';
import {
  WASM_PATH,
  runDiagnostics,
  diagnosticsMatching,
  parseVariableDiagnostic,
} from './testHelpers';

describe('uninitialized variable detection', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /** Thin wrapper over the real `computeDiagnostics` uninitialized-variable
   *  check. Returns one entry per diagnostic (i.e. per reference),
   *  matching the emission shape of the real diagnostic. */
  function findUninitializedVars(code: string): { locName: string; varName: string; line: number }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { uninitializedVariables: true }),
      'used but never assigned',
    );
    return diags.map(d => {
      const p = parseVariableDiagnostic(locIdx, d);
      return { locName: p.locName, varName: p.varName, line: p.line };
    });
  }

  it('detects variable used without assignment', () => {
    const warns = findUninitializedVars(`# test
pl x
---
`);
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('x');
  });

  it('no warning when variable is assigned in same location', () => {
    const warns = findUninitializedVars(`# test
x = 1
pl x
---
`);
    expect(warns).toHaveLength(0);
  });

  it('no warning when variable is assigned in another location', () => {
    const warns = findUninitializedVars(`# loc1
x = 42
---
# loc2
pl x
---
`);
    expect(warns).toHaveLength(0);
  });

  it('no warning for built-in args (always set per call frame)', () => {
    // `args` is the only built-in variable the runtime guarantees to
    // have populated on every call frame (empty when no extras passed).
    // Reading it without a user-side assignment must not warn.
    const warns = findUninitializedVars(`# test
pl $args[0]
result = args[1]
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'args')).toBe(false);
  });

  it('detects typo: variable name differs from assignment', () => {
    const warns = findUninitializedVars(`# test
myVar = 10
pl myVra
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'myvra')).toBe(true);
  });

  it('no warning for local variable assigned and used', () => {
    const warns = findUninitializedVars(`# test
local temp = 5
pl temp
---
`);
    expect(warns).toHaveLength(0);
  });

  it('flags bare local declaration without initializer', () => {
    // `local x` pins a fresh local in scope but starts empty —
    // reads of x should warn even if no other location defines x.
    const warns = findUninitializedVars(`# test
local x
pl x
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x')).toBe(true);
  });

  it('flags bare local even when same-named global is initialised elsewhere', () => {
    // The local shadows the global with an empty value; the read in
    // # loc binds to the local, not the global x = 5 in # init.
    const warns = findUninitializedVars(`# init
x = 5
---
# loc
local x
pl x
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x' && w.locName === 'loc')).toBe(true);
  });

  it('flags second var in `local x, y = 1` (positional zip — y unbound)', () => {
    const warns = findUninitializedVars(`# test
local x, y = 1
pl x
pl y
---
`);
    // x got the value 1; y is declaration-only.
    expect(warns.some(w => w.varName.toLowerCase() === 'x')).toBe(false);
    expect(warns.some(w => w.varName.toLowerCase() === 'y')).toBe(true);
  });

  it('does NOT flag bare local that is assigned later in the same scope', () => {
    const warns = findUninitializedVars(`# test
local x
x = 7
pl x
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x')).toBe(false);
  });

  it('flags read in callee when caller propagates a bare `local x`', () => {
    // # caller declares `local x` (no value) and propagates via gs.
    // # callee reads x — under propagation the local is visible but
    // empty, so the read is on an uninitialised value and warns.
    const warns = findUninitializedVars(`# caller
local x
gs 'callee'
---
# callee
pl x
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x' && w.locName === 'callee')).toBe(true);
  });

  it('does NOT flag callee read when caller propagates `local x = 1`', () => {
    const warns = findUninitializedVars(`# caller
local x = 1
gs 'callee'
---
# callee
pl x
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x' && w.locName === 'callee')).toBe(false);
  });

  it('flags var-ref chain that dead-ends at an uninitialised variable', () => {
    // Resolver follows `b = a` to `a`, finds no value-bearing
    // binding for `a`, so reads of `b` warn too.
    const warns = findUninitializedVars(`# loc1
b = a
---
# loc2
pl b
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'b')).toBe(true);
  });

  it('does NOT flag var-ref chain when the source has a value', () => {
    const warns = findUninitializedVars(`# loc1
a = 5
b = a
---
# loc2
pl b
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'b')).toBe(false);
  });

  it('does NOT flag a read of a name written only by indexed assignment elsewhere', () => {
    const warns = findUninitializedVars(`# loc1
src[0] = 1
---
# loc2
pl src
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'src')).toBe(false);
  });

  it('flags read of a name only mentioned by sortarr', () => {
    // sortarr is non-value-bearing — it permutes, never initialises.
    const warns = findUninitializedVars(`# main
sortarr 'arr'
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'arr')).toBe(true);
  });

  it('no warning for loop variable', () => {
    const warns = findUninitializedVars(`# test
loop i = 0 while i < 10 step i += 1:
  pl i
end
---
`);
    expect(warns).toHaveLength(0);
  });

  it('detects multiple uninitialized variables', () => {
    const warns = findUninitializedVars(`# test
pl a
pl b
pl c
---
`);
    expect(warns).toHaveLength(3);
  });

  it('flags all occurrences of an uninitialized variable', () => {
    const warns = findUninitializedVars(`# test
pl x
pl x
pl x
---
`);
    expect(warns).toHaveLength(3); // all 3 references to x flagged
    expect(warns.every(w => w.varName.toLowerCase() === 'x')).toBe(true);
  });

  it('warns on read of built-in handler-slot variable counter when never assigned', () => {
    // `$counter` is a built-in handler slot, but the engine does not
    // pre-populate it: the user must set it (e.g. `$counter = 'tick'`)
    // before the engine reads it.  Reading it without an assignment is
    // a real bug — only `args` is exempt from this check.
    const warns = findUninitializedVars(`# test
pl $counter
---
`);
    expect(warns.some(w => w.varName.toLowerCase() === 'counter')).toBe(true);
  });

  it('no warning for built-in variable counter when assigned somewhere', () => {
    const warns = findUninitializedVars(`# test
$counter = 'my_timer'
---
# loc2
pl $counter
---
`);
    expect(warns).toHaveLength(0);
  });

  // ── Severity / disabled-flag checks ─────────────────────────────

  it('diagnostic severity is Warning', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\npl x\n---\n`, { uninitializedVariables: true }),
      'used but never assigned',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\npl x\n---\n`, { uninitializedVariables: true }),
      'used but never assigned',
    );
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('diagnostic range targets the reference, not the location header', () => {
    //        0123456789
    // line0: # main
    // line1: pl x
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\npl x\n---\n`, { uninitializedVariables: true }),
      'used but never assigned',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].range.start.line).toBe(1);
    expect(diags[0].range.start.character).toBe(3); // column of 'x'
  });

  it('disabled flag produces no diagnostics even with uninitialized variable', () => {
    const diags = runDiagnostics(parser, `# main\npl x\n---\n`, { uninitializedVariables: false });
    expect(diagnosticsMatching(diags, 'used but never assigned')).toHaveLength(0);
  });

  it('does not flag array index usage when variable is defined', () => {
    // Array element access counts as a reference; defining arr[0] defines arr
    const warns = findUninitializedVars(`# main\narr[0] = 1\npl arr[0]\n---\n`);
    expect(warns).toHaveLength(0);
  });

  it('flags uninitialized variable used as array index', () => {
    const warns = findUninitializedVars(`# main\narr[0] = 1\npl arr[idx]\n---\n`);
    // idx is uninitialized
    expect(warns.some(w => w.varName.toLowerCase() === 'idx')).toBe(true);
  });

  it('flags uninitialized variable used in expression', () => {
    const warns = findUninitializedVars(`# main\ny = x + 1\n---\n`);
    expect(warns.some(w => w.varName.toLowerCase() === 'x')).toBe(true);
  });
});

describe('unused variable detection', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /** Thin wrapper over the real `computeDiagnostics` unused-variable check. */
  function findUnusedVariables(code: string): { locName: string; varName: string }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { unusedVariables: true }),
      'assigned but never read',
    );
    return diags.map(d => {
      const p = parseVariableDiagnostic(locIdx, d);
      return { locName: p.locName, varName: p.varName };
    });
  }

  it('detects variable assigned but never read', () => {
    const unused = findUnusedVariables(`# main\nx = 42\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName.toLowerCase()).toBe('x');
  });

  it('no warning when variable is read', () => {
    const unused = findUnusedVariables(`# main\nx = 42\npl x\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('cross-location: variable read in another location is not unused', () => {
    const unused = findUnusedVariables(`# loc1\nx = 42\n---\n# loc2\npl x\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('no warning for built-in variables', () => {
    const unused = findUnusedVariables(`# main\nresult = 1\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('detects multiple unused variables', () => {
    const unused = findUnusedVariables(`# main\na = 1\nb = 2\npl c\nc = 3\n---\n`);
    // a and b are assigned but never read; c is assigned AND read
    expect(unused).toHaveLength(2);
  });

  it('no warning for variable only read (never assigned)', () => {
    // This case is handled by uninitializedVariables, not unusedVariables
    const unused = findUnusedVariables(`# main\npl x\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('global variable assigned twice without reads is unused', () => {
    const unused = findUnusedVariables(`# main\nx = 1\nx = 2\n---\n`);
    expect(unused).toHaveLength(1);
  });

  it('global variable assigned in two locations without reads is unused', () => {
    const unused = findUnusedVariables(`# loc1\nx = 1\n---\n# loc2\nx = 2\n---\n`);
    expect(unused).toHaveLength(2);
  });

  it('local variable declared twice without reads is unused', () => {
    const unused = findUnusedVariables(`# main\nlocal x = 1\nlocal x = 2\n---\n`);
    expect(unused).toHaveLength(1);
  });

  it('local variable declared twice with a read is not unused', () => {
    const unused = findUnusedVariables(`# main\nlocal x = 1\nlocal x = 2\npl x\n---\n`);
    expect(unused).toHaveLength(0);
  });

  // ── Severity / tag / disabled-flag checks ───────────────────────

  it('diagnostic severity is Information', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\n---\n`, { unusedVariables: true }),
      'assigned but never read',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.severity === DiagnosticSeverity.Information)).toBe(true);
  });

  it('diagnostic is tagged Unnecessary', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\n---\n`, { unusedVariables: true }),
      'assigned but never read',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.tags?.includes(DiagnosticTag.Unnecessary))).toBe(true);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\n---\n`, { unusedVariables: true }),
      'assigned but never read',
    );
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('diagnostic range targets the assignment, not the header', () => {
    //        0123456789
    // line0: # main
    // line1: x = 1
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\n---\n`, { unusedVariables: true }),
      'assigned but never read',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].range.start.line).toBe(1);
    expect(diags[0].range.start.character).toBe(0);
  });

  it('disabled flag produces no diagnostics even with unused variable', () => {
    const diags = runDiagnostics(parser, `# main\nx = 1\n---\n`, { unusedVariables: false });
    expect(diagnosticsMatching(diags, 'assigned but never read')).toHaveLength(0);
  });

  it('compound assignment (+=) counts as both read and write — not unused', () => {
    const unused = findUnusedVariables(`# main\nx = 1\nx += 2\npl x\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('variable written in one location and read in same — not unused', () => {
    const unused = findUnusedVariables(`# main\nx = 1\ny = x * 2\npl y\n---\n`);
    expect(unused.filter(u => u.varName.toLowerCase() === 'x')).toHaveLength(0);
  });

  it('local variable: write-only is unused, write-then-read is not', () => {
    const unused1 = findUnusedVariables(`# main\nlocal a = 1\n---\n`);
    expect(unused1.some(u => u.varName.toLowerCase() === 'a')).toBe(true);
    const unused2 = findUnusedVariables(`# main\nlocal a = 1\npl a\n---\n`);
    expect(unused2.some(u => u.varName.toLowerCase() === 'a')).toBe(false);
  });

  // ── Resolver-precision wins (chain-aware reach) ───────────────

  it('precision: global write whose only same-named reads are shadowed by a local is unused', () => {
    // loc1 writes global x.  loc2 only reads x AFTER declaring `local x`,
    // so the read sees the local — never the global.  The flat name-
    // existence check would suppress (because the name `x` is read
    // somewhere in the doc); the resolver correctly flags loc1's
    // global x as unused.
    const code =
      `# loc1\nx = 1\n---\n` +
      `# loc2\nlocal x = 5\npl x\n---\n`;
    const unused = findUnusedVariables(code);
    expect(unused.some(u => u.locName === 'loc1' && u.varName.toLowerCase() === 'x')).toBe(true);
  });

  it('precision: global is reached via a var-ref chain through a local', () => {
    // Even though the global $g is never read by name in loc2,
    // `local $b = $g` creates a chain — the read of $b in `pl $b`
    // resolves through to $g.  The global must NOT be flagged.
    const code =
      `# loc1\n$g = 'X'\n---\n` +
      `# loc2\nlocal $b = $g\npl $b\n---\n`;
    const unused = findUnusedVariables(code);
    expect(unused.some(u => u.locName === 'loc1' && u.varName.toLowerCase() === 'g')).toBe(false);
  });

  it('precision: `local $b = $g` — $b unused flags only $b, not $g (which is genuinely read)', () => {
    // $g = 'X' is a write; local $b = $g reads $g (the RHS is a reference
    // to the global $g sym).  Even if $b is never subsequently read, the
    // read of $g is real — $g IS consumed by the local initialiser.
    // Only $b (the unused local) should be flagged; $g must not be.
    const code =
      `# main\n$g = 'X'\nlocal $b = $g\n---\n`;
    const unused = findUnusedVariables(code);
    expect(unused.some(u => u.varName.toLowerCase() === 'b')).toBe(true);
    expect(unused.some(u => u.varName.toLowerCase() === 'g')).toBe(false);
  });

  it('no false positive: RHS variable in `local y = x` must not be flagged as unused', () => {
    // Regression: `x` on the RHS of `local y = x` was incorrectly
    // treated as a local definition (phantom `local x` in the inner scope),
    // producing a spurious "assigned but never read" warning for `x`.
    const code = `# main\nlocal x = 1\nif 1:\n  local y = x\n  pl y\nend\n---\n`;
    const unused = findUnusedVariables(code);
    // `x` is read by `local y = x`, so it must not appear in unused list.
    expect(unused.some(u => u.varName.toLowerCase() === 'x')).toBe(false);
  });

  it('multi-assign: RHS vars in `local p, q = a, b` are reads, not phantom locals', () => {
    // `local p, q = a, b` — `a` and `b` are RHS and must be counted as reads.
    // The grammar inlines _na_arg_list so `a` and `b` are direct children of
    // local_statement (not inside variable_list), same shape as the single-var case.
    const code = `# main\na = 1\nb = 2\nlocal p, q = a, b\npl p & pl q\n---\n`;
    const unused = findUnusedVariables(code);
    expect(unused.some(u => u.varName.toLowerCase() === 'a')).toBe(false);
    expect(unused.some(u => u.varName.toLowerCase() === 'b')).toBe(false);
  });
});

describe('integration: uninitialized vars with statement/function string args', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function findUninitializedVars(code: string): { locName: string; varName: string }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { uninitializedVariables: true }),
      'used but never assigned',
    );
    // Dedup by locName+varName — this describe block asserts on unique
    // (varName, locName) pairs rather than per-reference counts.
    const seen = new Set<string>();
    const out: { locName: string; varName: string }[] = [];
    for (const d of diags) {
      const p = parseVariableDiagnostic(locIdx, d);
      const key = `${p.locName}\0${p.varName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ locName: p.locName, varName: p.varName });
    }
    return out;
  }

  it('setvar defines variable — no uninitialized warning when read later', () => {
    const warns = findUninitializedVars(`# main\nsetvar '$x', 42\npl x\n---\n`);
    expect(warns).toHaveLength(0);
  });

  it('sortarr on undefined variable warns uninitialized', () => {
    const warns = findUninitializedVars(`# main\nsortarr '$arr'\n---\n`);
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('arr');
  });

  it('arrsize on undefined variable warns uninitialized', () => {
    const warns = findUninitializedVars(`# main\npl arrsize('$x')\n---\n`);
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('x');
  });

  it('copyarr defines dest, references source — warns only for undefined source', () => {
    const warns = findUninitializedVars(`# main\ncopyarr '$dest', '$src'\n---\n`);
    // dest is defined by copyarr, src is referenced but never defined
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('src');
  });

  it('no warning when copyarr source is defined elsewhere', () => {
    const warns = findUninitializedVars(`# loc1\nsrc[0] = 1\n---\n# loc2\ncopyarr '$dest', '$src'\n---\n`);
    expect(warns).toHaveLength(0);
  });

  it('killvar on undefined variable warns "used but never assigned"', () => {
    // killvar references the variable — if it was never assigned, warn.
    const warns = findUninitializedVars(`# main\nkillvar 'x'\n---\n`);
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('x');
  });

  it('killvar on undefined variable with dollar prefix warns', () => {
    const warns = findUninitializedVars(`# main\nkillvar '$x'\n---\n`);
    expect(warns).toHaveLength(1);
    expect(warns[0].varName.toLowerCase()).toBe('x');
  });

  it('killvar after assignment does NOT warn (variable was properly initialised)', () => {
    const warns = findUninitializedVars(`# main\nx = 42\nkillvar 'x'\n---\n`);
    expect(warns).toHaveLength(0);
  });
});

describe('integration: unused vars with statement/function string args', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function findUnusedVariables(code: string): { locName: string; varName: string }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { unusedVariables: true }),
      'assigned but never read',
    );
    return diags.map(d => {
      const p = parseVariableDiagnostic(locIdx, d);
      return { locName: p.locName, varName: p.varName };
    });
  }

  it('variable assigned and only referenced by killvar is unused (killvar is not a proper read)', () => {
    const unused = findUnusedVariables(`# main\nx = 42\nkillvar 'x'\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName).toBe('x');
  });

  it('variable assigned and only referenced by sortarr is unused (sortarr is not a proper read)', () => {
    const unused = findUnusedVariables(`# main\narr[0] = 3\nsortarr 'arr'\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName).toBe('arr');
  });

  it('variable assigned and referenced by arrsize is not unused', () => {
    const unused = findUnusedVariables(`# main\narr[0] = 1\npl arrsize('arr')\n---\n`);
    expect(unused).toHaveLength(0);
  });

  it('setvar-only variable with no reads is unused', () => {
    const unused = findUnusedVariables(`# main\nsetvar '$x', 5\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName.toLowerCase()).toBe('x');
  });

  it('copyarr dest with no reads is unused', () => {
    const unused = findUnusedVariables(`# main\nsrc[0] = 1\ncopyarr '$dest', '$src'\n---\n`);
    // src is read by copyarr, so not unused; dest is defined but never read
    expect(unused.some(u => u.varName.toLowerCase() === 'dest')).toBe(true);
    expect(unused.some(u => u.varName.toLowerCase() === 'src')).toBe(false);
  });

  it('scanstr-only variable with no reads is unused (scanstr write is not a proper read)', () => {
    const unused = findUnusedVariables(`# main\nscanstr '$x', 'hello', 1\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName.toLowerCase()).toBe('x');
  });

  it('unpackarr-only variable with no reads is unused (unpackarr write is not a proper read)', () => {
    const unused = findUnusedVariables(`# main\nunpackarr '$x', '%src'\n---\n`);
    // $x is written by unpackarr but never read
    expect(unused.some(u => u.varName.toLowerCase() === 'x')).toBe(true);
  });

  it('compound-assignment-only reads are unused (compound write is not a proper read)', () => {
    // `x = 1` is the definition; `x += 2` mutates but doesn't count as a read.
    const unused = findUnusedVariables(`# main\nx = 1\nx += 2\n---\n`);
    expect(unused).toHaveLength(1);
    expect(unused[0].varName.toLowerCase()).toBe('x');
  });

  it('menu first arg is a proper read — variable not flagged as unused', () => {
    const unused = findUnusedVariables(`# main\narr[0] = 'opt'\nmenu 'arr'\n---\n`);
    expect(unused.some(u => u.varName.toLowerCase() === 'arr')).toBe(false);
  });
});

describe('integration: invalid function type prefix warnings', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function getPrefixWarnings(code: string) {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { invalidFunctionPrefix: true }),
      'does not support the',
    );
    const warnings: { funcName: string; prefix: string; validPrefixes: string }[] = [];
    const re = /^Function '([^']+)' does not support the '([^']+)' prefix \(valid: ([^)]+)\)$/;
    for (const d of diags) {
      const m = re.exec(d.message);
      if (!m) continue;
      warnings.push({ funcName: m[1], prefix: m[2], validPrefixes: m[3].replace(/, /g, '') });
    }
    return warnings;
  }

  // ── No warnings for valid usage ──

  it('no warning when numeric function is called with # prefix', () => {
    const w = getPrefixWarnings(`# main\nx = #len('hello')\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning when string function is called with $ prefix', () => {
    const w = getPrefixWarnings(`# main\nx = $mid('hello', 1, 3)\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning when polymorphic function uses $ prefix', () => {
    const w = getPrefixWarnings(`# main\nx = $func('myLoc')\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning when polymorphic function uses # prefix', () => {
    const w = getPrefixWarnings(`# main\nx = #func('myLoc')\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning when polymorphic function uses % prefix', () => {
    const w = getPrefixWarnings(`# main\nx = %func('myLoc')\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning for function called without prefix', () => {
    const w = getPrefixWarnings(`# main\nx = len('hello')\n---\n`);
    expect(w).toHaveLength(0);
  });

  it('no warning for tuple function with % prefix', () => {
    const w = getPrefixWarnings(`# main\nx = %arrpack('arr', 0, 3)\n---\n`);
    expect(w).toHaveLength(0);
  });

  // ── Warnings for invalid prefixes ──

  it('warns when numeric-only function uses $ prefix', () => {
    const w = getPrefixWarnings(`# main\nx = $len('hello')\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('len');
    expect(w[0].prefix).toBe('$');
    expect(w[0].validPrefixes).toBe('#');
  });

  it('warns when string-only function uses # prefix', () => {
    const w = getPrefixWarnings(`# main\nx = #mid('hello', 1, 3)\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('mid');
    expect(w[0].prefix).toBe('#');
    expect(w[0].validPrefixes).toBe('$');
  });

  it('warns when numeric-only function uses % prefix', () => {
    const w = getPrefixWarnings(`# main\nx = %rand(1, 10)\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('rand');
    expect(w[0].prefix).toBe('%');
    expect(w[0].validPrefixes).toBe('#');
  });

  it('warns when string-only function uses % prefix', () => {
    const w = getPrefixWarnings(`# main\nx = %trim(' hello ')\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('trim');
    expect(w[0].prefix).toBe('%');
    expect(w[0].validPrefixes).toBe('$');
  });

  it('warns when tuple-only function uses $ prefix', () => {
    const w = getPrefixWarnings(`# main\nx = $arrpack('arr', 0, 3)\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('arrpack');
    expect(w[0].prefix).toBe('$');
    expect(w[0].validPrefixes).toBe('%');
  });

  it('warns when tuple-only function uses # prefix', () => {
    const w = getPrefixWarnings(`# main\nx = #arrpack('arr', 0, 3)\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('arrpack');
    expect(w[0].prefix).toBe('#');
    expect(w[0].validPrefixes).toBe('%');
  });

  // ── Multiple warnings in one location ──

  it('collects multiple prefix warnings', () => {
    const w = getPrefixWarnings(`# main\nx = $len('a') + $rand(1,10)\n---\n`);
    expect(w).toHaveLength(2);
    expect(w.map(x => x.funcName).sort()).toEqual(['len', 'rand']);
  });

  // ── Case insensitivity ──

  it('detects invalid prefix regardless of function name case', () => {
    const w = getPrefixWarnings(`# main\nx = $LEN('hello')\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('len');
  });

  it('detects invalid prefix on UCASE-style name', () => {
    const w = getPrefixWarnings(`# main\nx = #MID('hello', 1, 3)\n---\n`);
    expect(w).toHaveLength(1);
    expect(w[0].funcName).toBe('mid');
  });

  // ── No false positives for non-builtin functions ──

  it('no warning for unknown/user-defined function with any prefix', () => {
    const w = getPrefixWarnings(`# main\nx = $myfunc(1, 2)\n---\n`);
    expect(w).toHaveLength(0);
  });

  // ── Severity / disabled-flag checks ─────────────────────────────

  it('diagnostic severity is Warning', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = $len('a')\n---\n`, { invalidFunctionPrefix: true }),
      'does not support the',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = $len('a')\n---\n`, { invalidFunctionPrefix: true }),
      'does not support the',
    );
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('diagnostic range targets the function call, not the header', () => {
    //        0123456789012
    // line0: # main
    // line1: x = $len('a')
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = $len('a')\n---\n`, { invalidFunctionPrefix: true }),
      'does not support the',
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].range.start.line).toBe(1);
    // Points at the prefix or the function name — non-zero column
    expect(diags[0].range.start.character).toBeGreaterThan(0);
  });

  it('disabled flag produces no diagnostics even with invalid prefix', () => {
    const diags = runDiagnostics(parser, `# main\nx = $len('a')\n---\n`, { invalidFunctionPrefix: false });
    expect(diagnosticsMatching(diags, 'does not support the')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Variable reference detection — comprehensive
// ──────────────────────────────────────────────────────────────────────

describe('variable reference detection — comprehensive', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  // ── Prefix unification ($x, #x, %x, x → same variable) ──────────

  it('$x and x point to the same variable', () => {
    const tree = parser.parse('test://dollar', `# test\nx = 5\npl $x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://dollar');
    const locSyms = symbols.getLocation('test')!;
    // Both x = 5 and $x should merge into key 'x'
    expect(locSyms.variables.has('x')).toBe(true);
    const sym = locSyms.variables.get('x')!;
    expect(sym.references).toHaveLength(2);
    expect(sym.definition).toBeDefined();
    // Check that definition is the assignment
    expect(sym.definition!.line).toBe(1);
  });

  it('#x and x point to the same variable', () => {
    const tree = parser.parse('test://hash', `# test\nx = 5\npl #x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://hash');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.references).toHaveLength(2);
  });

  it('%x and x point to the same variable', () => {
    const tree = parser.parse('test://pct', `# test\nx = 5\npl %x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://pct');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.references).toHaveLength(2);
  });

  it('all prefixes ($, #, %) merge with unprefixed', () => {
    const tree = parser.parse('test://all-prefix', `# test\nmyvar = 1\npl $myvar\npl #myvar\npl %myvar\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://all-prefix');
    const sym = symbols.getLocation('test')!.variables.get('myvar')!;
    expect(sym.references).toHaveLength(4);
    expect(sym.definition).toBeDefined();
  });

  // ── Assignment detection ─────────────────────────────────────────

  it('simple assignment is a definition', () => {
    const tree = parser.parse('test://assign', `# test\nx = 10\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://assign');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeDefined();
    expect(sym.definition!.line).toBe(1);
  });

  it('compound assignment (+=) is NOT a definition', () => {
    const tree = parser.parse('test://compound', `# test\nx += 1\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://compound');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeUndefined();
  });

  it('reading a variable without assignment is NOT a definition', () => {
    const tree = parser.parse('test://read-only', `# test\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://read-only');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeUndefined();
    expect(sym.references).toHaveLength(1);
  });

  it('first assignment sets definition, later assignments are references', () => {
    const tree = parser.parse('test://multi-assign', `# test\nx = 1\nx = 2\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://multi-assign');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeDefined();
    expect(sym.definition!.line).toBe(1); // first assignment
    expect(sym.references).toHaveLength(3);
  });

  // ── LOCAL declarations ───────────────────────────────────────────

  it('LOCAL statement marks variable as local and defined', () => {
    const tree = parser.parse('test://local', `# test\nlocal x = 5\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://local');
    const sym = symbols.getLocation('test')!.findVariable('x')!;
    expect(sym.isLocal).toBe(true);
    expect(sym.definition).toBeDefined();
  });

  it('LOCAL without assignment still marks as definition', () => {
    const tree = parser.parse('test://local-noassign', `# test\nlocal x\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://local-noassign');
    const sym = symbols.getLocation('test')!.findVariable('x')!;
    expect(sym.isLocal).toBe(true);
    expect(sym.definition).toBeDefined();
    expect(sym.references).toHaveLength(2);
  });

  it('non-local use BEFORE a LOCAL declaration stays global (source-order)', () => {
    // Source-order semantics: at runtime `pl x` on line 2 reads the
    // global x — the `local x` on line 3 doesn't exist yet at that
    // point.  The two uses must produce two distinct symbols (a
    // pre-declaration global with the bare read, and a fresh local
    // owned by the declaration), not be conflated by an
    // upgrade-after-the-fact.
    const tree = parser.parse('test://local-late', `# test\npl x\nlocal x = 5\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://local-late');
    const loc = symbols.getLocation('test')!;
    const global = loc.variables.get('x')!;
    expect(global).toBeDefined();
    expect(global.isLocal).toBe(false);
    expect(global.references).toHaveLength(1);
    const local = loc.variables.get('local\0' + '0' + '\0' + 'x')!;
    expect(local).toBeDefined();
    expect(local.isLocal).toBe(true);
    expect(local.definition).toBeDefined();
    expect(local.references).toHaveLength(1);
  });

  it('local vars in different locations are independent symbols', () => {
    const tree = parser.parse('test://local-scope', `# loc1\nlocal x = 1\n---\n# loc2\nlocal x = 2\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://local-scope');
    const loc1 = symbols.getLocation('loc1')!;
    const loc2 = symbols.getLocation('loc2')!;
    const x1 = loc1.findVariable('x')!;
    const x2 = loc2.findVariable('x')!;
    expect(x1.isLocal).toBe(true);
    expect(x2.isLocal).toBe(true);
    expect(x1.definition!.line).toBe(1);
    expect(x2.definition!.line).toBe(4);
  });

  it('findVariableReferences scopes local vars to their location', () => {
    const tree = parser.parse('test://ref-scope', `# loc1\nlocal x = 1\npl x\n---\n# loc2\nlocal x = 2\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://ref-scope');
    // From loc1's perspective, only loc1's references should be returned
    const refs1 = symbols.findVariableReferences('x', 'loc1');
    expect(refs1.every(r => r.line < 3)).toBe(true);
    expect(refs1).toHaveLength(2);
    // From loc2's perspective, only loc2's references
    const refs2 = symbols.findVariableReferences('x', 'loc2');
    expect(refs2.every(r => r.line >= 4)).toBe(true);
    expect(refs2).toHaveLength(2);
  });

  it('findVariableReferences returns all refs for global vars', () => {
    const tree = parser.parse('test://global-ref', `# loc1\nx = 1\n---\n# loc2\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://global-ref');
    const refs = symbols.findVariableReferences('x', 'loc1');
    expect(refs).toHaveLength(2); // both locations
  });

  // ── Array variables ──────────────────────────────────────────────

  it('array variable with index is tracked', () => {
    const tree = parser.parse('test://arr', `# test\narr[0] = 1\npl arr[1]\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://arr');
    const sym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(sym.definition).toBeDefined();
    expect(sym.references).toHaveLength(2);
  });

  it('$arr[] and arr[] point to the same variable', () => {
    const tree = parser.parse('test://arr-prefix', `# test\narr[0] = 1\npl $arr[0]\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://arr-prefix');
    const sym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(sym.references).toHaveLength(2);
  });

  // ── Cross-location variable references ───────────────────────────

  it('variable defined in one location and read in another', () => {
    const tree = parser.parse('test://cross-loc', `# loc1\nglobal_var = 10\n---\n# loc2\npl global_var\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://cross-loc');
    const loc1 = symbols.getLocation('loc1')!;
    const loc2 = symbols.getLocation('loc2')!;
    expect(loc1.variables.get('global_var')!.definition).toBeDefined();
    expect(loc2.variables.get('global_var')!.definition).toBeUndefined();
    expect(loc2.variables.get('global_var')!.references).toHaveLength(1);
  });

  it('findVariableReferences finds refs across all locations', () => {
    const tree = parser.parse('test://find-var', `# loc1\nx = 1\n---\n# loc2\npl x\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://find-var');
    const refs = symbols.findVariableReferences('x');
    expect(refs).toHaveLength(2);
  });

  // ── Variable refs from string arguments ──────────────────────────

  it('setvar defines a variable from string arg', () => {
    const tree = parser.parse('test://setvar-def', `# test\nsetvar '$myvar', 5\npl myvar\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://setvar-def');
    const sym = symbols.getLocation('test')!.variables.get('myvar')!;
    expect(sym.definition).toBeDefined();
    expect(sym.references).toHaveLength(2); // setvar + pl
  });

  it('killvar references a variable from string arg', () => {
    const tree = parser.parse('test://killvar-ref', `# test\nx = 1\nkillvar '$x'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://killvar-ref');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeDefined(); // x = 1
    expect(sym.references).toHaveLength(2); // assignment + killvar
  });

  it('arrsize references a variable from string arg', () => {
    const tree = parser.parse('test://arrsize-ref', `# test\narr[0] = 1\npl arrsize('$arr')\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://arrsize-ref');
    const sym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(sym.definition).toBeDefined();
    expect(sym.references).toHaveLength(2);
  });

  it('copyarr: first arg is definition, second is reference', () => {
    const tree = parser.parse('test://copyarr', `# test\nsrc[0] = 1\ncopyarr '$dest', '$src'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://copyarr');
    const srcSym = symbols.getLocation('test')!.variables.get('src')!;
    const destSym = symbols.getLocation('test')!.variables.get('dest')!;
    expect(srcSym.references).toHaveLength(2); // assignment + copyarr ref
    expect(destSym.definition).toBeDefined(); // copyarr defines dest
  });

  it('string arg without prefix works for variable ref', () => {
    const tree = parser.parse('test://no-prefix-str', `# test\narr[0] = 1\npl arrsize('arr')\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://no-prefix-str');
    const sym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(sym.references).toHaveLength(2);
  });

  it('max with single arg references a variable', () => {
    const tree = parser.parse('test://max-1', `# test\narr[0] = 5\npl max('$arr')\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://max-1');
    const sym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(sym.references).toHaveLength(2);
  });

  it('max with two args does NOT reference a variable', () => {
    const tree = parser.parse('test://max-2', `# test\npl max(1, 2)\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://max-2');
    const locSyms = symbols.getLocation('test')!;
    // No variable should be created from max(1,2)
    expect(locSyms.variables.size).toBe(0);
  });

  // ── Interpolated strings should NOT create refs ──────────────────

  it('does NOT create location ref from interpolated string', () => {
    const tree = parser.parse('test://interp', `# test\ngosub '<<$name>>'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://interp');
    const locSyms = symbols.getLocation('test')!;
    expect(locSyms.locationRefs.size).toBe(0);
  });

  it('tracks variable ref inside interpolated string arg', () => {
    const tree = parser.parse('test://interp-var', `# test\nkillvar '<<$name>>'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://interp-var');
    const locSyms = symbols.getLocation('test')!;
    // $name inside <<>> is parsed as ml_variable_ref — correctly tracked
    expect(locSyms.variables.has('name')).toBe(true);
    expect(locSyms.variables.get('name')!.references).toHaveLength(1);
  });

  // ── Multiple variables in a single assignment ────────────────────

  it('handles multiple variable assignment (x, y = 1, 2)', () => {
    const tree = parser.parse('test://multi-var', `# test\nx, y = 1, 2\npl x\npl y\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://multi-var');
    const locSyms = symbols.getLocation('test')!;
    const xSym = locSyms.variables.get('x')!;
    const ySym = locSyms.variables.get('y')!;
    expect(xSym.definition).toBeDefined();
    expect(ySym.definition).toBeDefined();
    expect(xSym.references).toHaveLength(2);
    expect(ySym.references).toHaveLength(2);
  });

  // ── Variable in expression contexts ──────────────────────────────

  it('tracks variable in condition expression', () => {
    const tree = parser.parse('test://cond', `# test\nif x > 0: pl 'yes'\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://cond');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.references).toHaveLength(1);
    expect(sym.definition).toBeUndefined(); // read, not written
  });

  it('tracks variable in loop condition', () => {
    const tree = parser.parse('test://loop', `# test\ni = 0\nloop while i < 10:\ni += 1\nend\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://loop');
    const sym = symbols.getLocation('test')!.variables.get('i')!;
    expect(sym.definition).toBeDefined();
    expect(sym.references.length).toBeGreaterThanOrEqual(3); // i=0, while i<10, i+=1
  });

  it('tracks variable used as function argument', () => {
    const tree = parser.parse('test://funcarg', `# test\nx = 5\npl str(x)\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://funcarg');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.references).toHaveLength(2);
  });

  it('tracks variable used in array index', () => {
    const tree = parser.parse('test://idx', `# test\ni = 0\npl arr[i]\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://idx');
    const iSym = symbols.getLocation('test')!.variables.get('i')!;
    expect(iSym.references).toHaveLength(2);
    const arrSym = symbols.getLocation('test')!.variables.get('arr')!;
    expect(arrSym.references).toHaveLength(1);
  });

  // ── Built-in variables should still be tracked ───────────────────

  it('does not track built-in $curloc as variable (parsed as func call)', () => {
    const tree = parser.parse('test://builtin', `# test\npl $curloc\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://builtin');
    // $curloc is parsed by tree-sitter as na_func_call, not variable_ref
    expect(symbols.getLocation('test')!.variables.has('curloc')).toBe(false);
  });

  // ── Variable in nested scopes ────────────────────────────────────

  it('tracks variables inside act blocks', () => {
    const tree = parser.parse('test://act-var', `# test\nact 'Go':\n  local x = 1\n  pl x\nend\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://act-var');
    const sym = symbols.getLocation('test')!.findVariable('x')!;
    expect(sym.isLocal).toBe(true);
    expect(sym.definition).toBeDefined();
    expect(sym.references).toHaveLength(2);
  });

  it('tracks variables inside nested if/loop blocks', () => {
    const tree = parser.parse('test://nested-var', `# test\nif 1:\n  loop while 1:\n    x = 1\n  end\nend\n---\n`);
    const { symbols } = extractSymbols(tree!, 'test://nested-var');
    const sym = symbols.getLocation('test')!.variables.get('x')!;
    expect(sym.definition).toBeDefined();
  });

  // ── Local variable propagation ───────────────────────────────────

  it('local vars propagate into nested if/loop scopes', () => {
    const tree = parser.parse('test://prop', `# test
local x = 1
if 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://prop');
    const loc = symbols.getLocation('test')!;
    // x inside the if body should merge with the local x — single symbol
    const allX = loc.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2); // definition + use
  });

  it('local vars propagate through nested if/loop levels', () => {
    const tree = parser.parse('test://deep', `# test
local x = 1
if 1:
  loop while 1:
    pl x
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://deep');
    const allX = symbols.getLocation('test')!.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2);
  });

  it('local vars do NOT propagate into act blocks', () => {
    const tree = parser.parse('test://act-iso', `# test
local x = 1
act 'Go':
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-iso');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // Two separate symbols: local x at top scope, global x inside act
    expect(allX).toHaveLength(2);
    expect(allX.some(s => s.isLocal)).toBe(true);
    expect(allX.some(s => !s.isLocal)).toBe(true);
  });

  it('local vars do NOT propagate into act blocks (inline)', () => {
    const tree = parser.parse('test://act-sl-iso', `# test
local x = 1
act 'Go': pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-sl-iso');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    expect(allX).toHaveLength(2);
    expect(allX.some(s => s.isLocal)).toBe(true);
    expect(allX.some(s => !s.isLocal)).toBe(true);
  });

  it('loop header LOCAL scopes to the loop body', () => {
    const tree = parser.parse('test://loop-hdr', `# test
loop local x = 0 while x < 10 step x += 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-hdr');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // All x refs (init, cond, step, body) merge into one local symbol
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references.length).toBeGreaterThanOrEqual(4);
  });

  it('loop header LOCAL does not leak to parent scope', () => {
    const tree = parser.parse('test://loop-leak', `# test
loop local x = 0 while x < 10 step x += 1:
  pl x
end
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-leak');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // local x inside loop + global x outside loop
    expect(allX).toHaveLength(2);
  });

  it('single-line loop creates a scope', () => {
    const tree = parser.parse('test://loop-sl', `# test
loop local i = 0 while i < 3 step i += 1: pl i
pl i
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-sl');
    const loc = symbols.getLocation('test')!;
    const allI = loc.findAllVariables('i');
    expect(allI).toHaveLength(2); // local inside loop, global outside
  });

  it('single-line if creates a scope', () => {
    const tree = parser.parse('test://if-sl', `# test
local x = 1
if 1: pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://if-sl');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // x propagates into the if body — single symbol
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
  });

  it('elseif and else get their own scopes', () => {
    const tree = parser.parse('test://elif', `# test
if 1:
  local a = 1
elseif 1:
  local a = 2
else
  local a = 3
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://elif');
    const loc = symbols.getLocation('test')!;
    const allA = loc.findAllVariables('a');
    // Three separate local a symbols (one per branch)
    expect(allA).toHaveLength(3);
    expect(allA.every(s => s.isLocal)).toBe(true);
  });

  it('locals defined inside act propagate into nested if/loop', () => {
    const tree = parser.parse('test://act-inner', `# test
act 'Go':
  local y = 1
  if 1:
    pl y
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-inner');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    // y defined inside act propagates into the if — single local symbol
    expect(allY).toHaveLength(1);
    expect(allY[0].isLocal).toBe(true);
    expect(allY[0].references).toHaveLength(2);
  });

  it('act references globals but can shadow with own locals', () => {
    const tree = parser.parse('test://act-shadow', `# test
x = 1
act 'Go':
  pl x
  local y = 2
  if 1:
    pl y
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-shadow');
    const loc = symbols.getLocation('test')!;
    // x: global at top + global inside act (same symbol)
    const allX = loc.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(false);
    // y: local inside act, propagates into if
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(1);
    expect(allY[0].isLocal).toBe(true);
    expect(allY[0].references).toHaveLength(2);
  });

  it('local vars propagate into all if/elseif/else branches', () => {
    const tree = parser.parse('test://all-branches', `# test
local x = 1
if 1:
  pl x
elseif 1:
  pl x
else
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://all-branches');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // All four references (def + 3 branches) merge into one local symbol
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(4);
  });

  it('local vars propagate into single-line if body', () => {
    const tree = parser.parse('test://sl-if-prop', `# test
local x = 1
if 1: pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sl-if-prop');
    const allX = symbols.getLocation('test')!.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2);
  });

  it('local vars propagate into single-line loop body', () => {
    const tree = parser.parse('test://sl-loop-prop', `# test
local x = 1
loop while 1: pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sl-loop-prop');
    const allX = symbols.getLocation('test')!.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2);
  });

  it('local vars propagate into multiline if body', () => {
    const tree = parser.parse('test://ml-if-prop', `# test
local x = 1
if 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://ml-if-prop');
    const allX = symbols.getLocation('test')!.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2);
  });

  it('local vars propagate into multiline loop body', () => {
    const tree = parser.parse('test://ml-loop-prop', `# test
local x = 1
loop while 1:
  pl x
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://ml-loop-prop');
    const allX = symbols.getLocation('test')!.findAllVariables('x');
    expect(allX).toHaveLength(1);
    expect(allX[0].isLocal).toBe(true);
    expect(allX[0].references).toHaveLength(2);
  });

  it('re-declaring LOCAL in nested scope shadows the parent local', () => {
    const tree = parser.parse('test://shadow', `# test
local x = 1
if 1:
  local x = 2
  pl x
end
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://shadow');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    // Two separate local x symbols: parent scope + if-body scope
    expect(allX).toHaveLength(2);
    expect(allX.every(s => s.isLocal)).toBe(true);
    // Parent: definition + use after end
    expect(allX.find(s => s.references.length === 2)).toBeDefined();
    // Inner: definition + pl x
    expect(allX.find(s => s.references.length === 2 && s.definition!.line === 3)).toBeDefined();
  });

  it('re-declaring LOCAL in nested loop shadows the parent local', () => {
    const tree = parser.parse('test://shadow-loop', `# test
local x = 1
loop while 1:
  local x = 2
  pl x
end
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://shadow-loop');
    const loc = symbols.getLocation('test')!;
    const allX = loc.findAllVariables('x');
    expect(allX).toHaveLength(2);
    expect(allX.every(s => s.isLocal)).toBe(true);
  });

  // ── Branch scope isolation ──────────────────────────────────────

  it('local in if-body is not visible after end (block form)', () => {
    // `local y` is scoped to the if-body; the reference after `end`
    // should resolve to a separate global symbol.
    const tree = parser.parse('test://branch-after-end', `# test
if 1:
  local y = 1
end
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://branch-after-end');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    // Two separate symbols: the branch-local and the post-end global.
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });

  it('local in if-body is not visible in else-branch (block form)', () => {
    // `local y` in the if-branch is a separate symbol from the `y = 2`
    // in the else-branch (global write — no outer local to retag onto).
    const tree = parser.parse('test://branch-isolation-else', `# test
if 1:
  local y = 1
else
  y = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://branch-isolation-else');
    const loc = symbols.getLocation('test')!;
    const bs = loc.variableBindings.get('y')!;
    // Two bindings: one local (if-branch), one global (else-branch).
    expect(bs).toHaveLength(2);
    expect(bs.some(b => b.isLocal)).toBe(true);
    expect(bs.some(b => !b.isLocal)).toBe(true);
  });

  it('local in if-body is not visible in elseif-branch (block form)', () => {
    const tree = parser.parse('test://branch-isolation-elseif', `# test
if 1:
  local y = 1
elseif 1:
  y = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://branch-isolation-elseif');
    const loc = symbols.getLocation('test')!;
    const bs = loc.variableBindings.get('y')!;
    expect(bs).toHaveLength(2);
    expect(bs.some(b => b.isLocal)).toBe(true);
    expect(bs.some(b => !b.isLocal)).toBe(true);
  });

  it('locals in sibling elseif-branches are independent symbols', () => {
    // Each `local y` lives in its own elseif scope — two distinct syms.
    const tree = parser.parse('test://sibling-elseif', `# test
if 1:
  local y = 1
elseif 1:
  local y = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://sibling-elseif');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.every(s => s.isLocal)).toBe(true);
  });

  it('local in if-body is not visible after end (inline form)', () => {
    const tree = parser.parse('test://branch-inline-after-end', `# test
if 1: local y = 1
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://branch-inline-after-end');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });

  it('locals in inline if/else branches are independent symbols', () => {
    // Single-line form: `if 1: local y = 1 else local y = 2`
    const tree = parser.parse('test://branch-inline-sibling', `# test
if 1: local y = 1 else local y = 2
---
`);
    const { symbols } = extractSymbols(tree!, 'test://branch-inline-sibling');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.every(s => s.isLocal)).toBe(true);
  });

  it('enclosing loop-body local IS visible inside else-branch of nested if', () => {
    // `local y` is in the loop body (scopeNodeId = loop_block.id).
    // The else-branch is at a SIBLING level to the if-body, not to the
    // loop body — so loop-body locals must still propagate into it.
    // This was broken when passedBranch was a flat boolean that blocked
    // ANY enclosing scope once an else/elseif was crossed.
    const tree = parser.parse('test://loop-else-visibility', `# test
loop while 1:
  local y = 1
  if 1:
    pl y
  else
    pl y
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-else-visibility');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    // All three refs (definition + 2 reads) merge into one local symbol.
    expect(allY).toHaveLength(1);
    expect(allY[0].isLocal).toBe(true);
    expect(allY[0].references).toHaveLength(3);
  });

  it('enclosing outer-if-body local IS visible inside else-branch of nested if', () => {
    // `local y` in outer if-body (scopeNodeId = outer_if_block.id).
    // Consumer is in the else-branch of a NESTED inner if — the inner
    // else should not block the outer if-body binding.
    const tree = parser.parse('test://outer-if-nested-else', `# test
if 1:
  local y = 1
  if 2:
    pl y
  else
    pl y
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://outer-if-nested-else');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(1);
    expect(allY[0].isLocal).toBe(true);
    expect(allY[0].references).toHaveLength(3);
  });

  // ── Act scope isolation ─────────────────────────────────────────

  it('local in act-body is not visible after end (block form)', () => {
    // act_block is isolating — `local y` cannot escape it.
    const tree = parser.parse('test://act-after-end', `# test
act 'A':
  local y = 1
end
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-after-end');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });

  it('local in act-body is not visible after (inline form)', () => {
    const tree = parser.parse('test://act-inline-after', `# test
act 'A': local y = 1
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-inline-after');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });

  it('outer local is not visible inside act-body (isolation boundary)', () => {
    // act is isolating: the bare `y = 2` inside cannot see the outer
    // `local y`, so it stays global (two separate symbols).
    const tree = parser.parse('test://act-isolation-outer', `# test
local y = 1
act 'A':
  y = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-isolation-outer');
    const loc = symbols.getLocation('test')!;
    const bs = loc.variableBindings.get('y')!;
    // Outer local and act-body write are separate symbols.
    expect(bs).toHaveLength(2);
    expect(bs.some(b => b.isLocal)).toBe(true);
    expect(bs.some(b => !b.isLocal)).toBe(true);
  });

  it('locals in sibling act-bodies are independent (both isolated)', () => {
    const tree = parser.parse('test://act-sibling', `# test
act 'A':
  local y = 1
end
act 'B':
  local y = 2
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://act-sibling');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.every(s => s.isLocal)).toBe(true);
  });

  // ── Loop body scope isolation ───────────────────────────────────

  it('local in loop-body (not header) is not visible after end', () => {
    // loop_block is non-isolating but still scope-forming; a `local`
    // declared in the body is confined to the loop scope.
    const tree = parser.parse('test://loop-body-leak', `# test
loop while 1:
  local y = 1
end
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-body-leak');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });

  it('local in loop-body (not header) is not visible after end (inline form)', () => {
    const tree = parser.parse('test://loop-body-inline-leak', `# test
loop while 1: local y = 1
pl y
---
`);
    const { symbols } = extractSymbols(tree!, 'test://loop-body-inline-leak');
    const loc = symbols.getLocation('test')!;
    const allY = loc.findAllVariables('y');
    expect(allY).toHaveLength(2);
    expect(allY.some(s => s.isLocal)).toBe(true);
    expect(allY.some(s => !s.isLocal)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// localsInScope — cross-location local variable tracking
// ──────────────────────────────────────────────────────────────────────

describe('localsInScope on locationRef call sites', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('gs with locals records localsInScope', () => {
    const tree = parser.parse('test://locals-gs', `# test
local x = 1
local y = 2
gs 'helper'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-gs');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref).toBeDefined();
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.has('x')).toBe(true);
    expect(callSite.localsInScope!.has('y')).toBe(true);
  });

  it('func with locals records localsInScope', () => {
    const tree = parser.parse('test://locals-func', `# test
local x = 5
$r = func('helper')
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-func');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.has('x')).toBe(true);
  });

  it('@@ user call records localsInScope', () => {
    const tree = parser.parse('test://locals-at', `# test
local z = 10
@@helper
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.has('z')).toBe(true);
  });

  it('@ user func call records localsInScope', () => {
    const tree = parser.parse('test://locals-at2', `# test
local a = 1
$r = @helper()
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at2');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.has('a')).toBe(true);
  });

  it('gs with parens and extra params records localsInScope', () => {
    const tree = parser.parse('test://locals-gs-paren', `# test
local x = 1
gs('helper', x, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-gs-paren');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref).toBeDefined();
    expect(ref.references[0].localsInScope!.has('x')).toBe(true);
  });

  it('gs with extra bare params records localsInScope', () => {
    const tree = parser.parse('test://locals-gs-args', `# test
local x = 1
gs 'helper', x, 42
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-gs-args');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('x')).toBe(true);
  });

  it('func with extra params records localsInScope', () => {
    const tree = parser.parse('test://locals-func-args', `# test
local x = 1
$r = func('helper', x, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-func-args');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('x')).toBe(true);
  });

  it('@@ with extra params records localsInScope', () => {
    const tree = parser.parse('test://locals-at-args', `# test
local z = 10
@@helper z, 42
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at-args');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('z')).toBe(true);
  });

  it('@@ with parens records localsInScope', () => {
    const tree = parser.parse('test://locals-at-paren', `# test
local z = 10
@@helper(z, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at-paren');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('z')).toBe(true);
  });

  it('@ with bare args records localsInScope', () => {
    const tree = parser.parse('test://locals-at2-bare', `# test
local a = 1
$r = @helper a, 42
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at2-bare');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('a')).toBe(true);
  });

  it('@ with extra params records localsInScope', () => {
    const tree = parser.parse('test://locals-at2-args', `# test
local a = 1
$r = @helper(a, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-at2-args');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    expect(ref.references[0].localsInScope!.has('a')).toBe(true);
  });

  it('localsInScope reflects scope at call site, not outer scope', () => {
    const tree = parser.parse('test://locals-scope', `# test
local x = 1
act 'a':
  local y = 2
  gs 'helper'
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-scope');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    // y is in scope (declared in the act), x is NOT (act is isolated)
    expect(callSite.localsInScope!.has('y')).toBe(true);
    expect(callSite.localsInScope!.has('x')).toBe(false);
  });

  it('no locals → empty localsInScope', () => {
    const tree = parser.parse('test://locals-none', `# test
gs 'helper'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-none');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.size).toBe(0);
  });

  it('goto does NOT propagate locals', () => {
    const tree = parser.parse('test://locals-goto', `# test
local x = 1
goto 'other'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-goto');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('other')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeUndefined();
  });

  it('xgt does NOT propagate locals', () => {
    const tree = parser.parse('test://locals-xgt', `# test
local x = 1
xgt 'other'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-xgt');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('other')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeUndefined();
  });

  it('locals from if scope propagate to gs call inside', () => {
    const tree = parser.parse('test://locals-if', `# test
local x = 1
if 1:
  local y = 2
  gs 'helper'
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-if');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope!.has('x')).toBe(true);
    expect(callSite.localsInScope!.has('y')).toBe(true);
  });

  it('loc operator records localsInScope', () => {
    const tree = parser.parse('test://locals-loc', `# test
local x = 1
if loc 'helper':
  pl 'exists'
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://locals-loc');
    const loc = symbols.getLocation('test')!;
    const ref = loc.locationRefs.get('helper')!;
    const callSite = ref.references[0];
    expect(callSite.localsInScope).toBeDefined();
    expect(callSite.localsInScope!.has('x')).toBe(true);
  });
});

describe('dynamic/dyneval code blocks inherit locals', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('dynamic code block is walked (variables are tracked)', () => {
    const tree = parser.parse('test://dyn1', `# test
local x = 1
dynamic {
  pl x
}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn1');
    const loc = symbols.getLocation('test')!;
    // x should be found as a local with a reference inside the code block
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    // Should have definition + usage in code block
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dyneval code block is walked (variables are tracked)', () => {
    const tree = parser.parse('test://dyn2', `# test
local x = 1
$r = dyneval({
  $result = x
})
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn2');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dynamic with parens code block is walked', () => {
    const tree = parser.parse('test://dyn-paren', `# test
local x = 1
dynamic({
  pl x
})
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn-paren');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dyneval without parens code block is walked', () => {
    const tree = parser.parse('test://dyn-bare', `# test
local x = 1
dyneval {
  $result = x
}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn-bare');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dynamic code block with extra params is walked', () => {
    const tree = parser.parse('test://dyn-extra1', `# test
local x = 1
dynamic { pl x }, x, 42
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn-extra1');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dyneval code block with extra params is walked', () => {
    const tree = parser.parse('test://dyn-extra2', `# test
local x = 1
$r = dyneval({ $result = x }, x, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn-extra2');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('dynamic code block does NOT inherit locals across act boundary', () => {
    const tree = parser.parse('test://dyn3', `# test
local x = 1
act 'a':
  dynamic {
    pl x
  }
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://dyn3');
    const loc = symbols.getLocation('test')!;
    // x inside the dynamic block in act should NOT resolve to the outer local
    const allX = loc.findAllVariables('x');
    // The outer local x and the inner non-local x reference
    const localX = allX.filter(s => s.isLocal);
    const globalX = allX.filter(s => !s.isLocal);
    expect(localX).toHaveLength(1); // outer local x
    expect(globalX).toHaveLength(1); // x inside act>dynamic is not local
  });

  it('gs code block argument is consumed, not walked', () => {
    const tree = parser.parse('test://gs-cb', `# test
gs {helper}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gs-cb');
    const loc = symbols.getLocation('test')!;
    // The code block content 'helper' should be treated as a location ref,
    // not as executable code
    const ref = loc.locationRefs.get('helper');
    expect(ref).toBeDefined();
  });
});

describe('dynamic/dyneval via variable holding code block', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('propagates caller locals into block assigned to variable', () => {
    const tree = parser.parse('test://vd1', `# test
local x = 1
$code = {
  pl x
}
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd1');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    // Definition + reference inside the deferred block → ≥ 2 refs
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
    // Registers the call-site hint metadata
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.dynamicVarCalls[0].varBaseName).toBe('code');
    expect(loc.dynamicVarCalls[0].localNames).toContain('x');
  });

  it('works with let/set/local assignment forms', () => {
    for (const form of ['$code = ', 'set $code = ', 'let $code = ', 'local $code = ']) {
      const src = `# test
local x = 1
${form}{
  pl x
}
dynamic $code
---
`;
      const tree = parser.parse(`test://form`, src);
      const { symbols } = extractSymbols(tree!, 'test://form');
      const loc = symbols.getLocation('test')!;
      const xSym = loc.findVariable('x');
      expect(xSym, `form=${form}`).toBeDefined();
      expect(xSym!.references.length, `form=${form}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('works with parallel multi-assignment', () => {
    const tree = parser.parse('test://vd-multi', `# test
local x = 1
local y = 2
$a, $b = { pl x }, { pl y }
dynamic $a
dynamic $b
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-multi');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    const ySym = loc.findVariable('y');
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
    expect(ySym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('works with dyneval(var, ...) and extra params', () => {
    const tree = parser.parse('test://vd-dyneval', `# test
local x = 1
$code = {
  $result = x
}
$r = dyneval($code, 42)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-dyneval');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('propagates across multiple call sites — merges all caller locals', () => {
    const tree = parser.parse('test://vd-multi-call', `# test
$code = {
  pl x
  pl y
}
if 1:
  local x = 1
  dynamic $code
else
  local y = 2
  dynamic $code
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-multi-call');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    const ySym = loc.findVariable('y');
    // Each block-internal ref picks up the correct caller's local.
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
    expect(ySym!.references.length).toBeGreaterThanOrEqual(2);
    // Two separate call-site hints.
    expect(loc.dynamicVarCalls).toHaveLength(2);
  });

  it('propagates gs call inside var-mediated block', () => {
    const tree = parser.parse('test://vd-gs', `# main
local x = 5
$code = {
  gs 'helper'
}
dynamic $code
---
# helper
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-gs');
    const mainLoc = symbols.getLocation('main')!;
    const ref = mainLoc.locationRefs.get('helper')!;
    expect(ref).toBeDefined();
    // The gs call should carry caller's locals onward.
    expect(ref.references[0].localsInScope).toBeDefined();
    expect(ref.references[0].localsInScope!.has('x')).toBe(true);
  });

  it('does not propagate when variable has no static code-block binding', () => {
    const tree = parser.parse('test://vd-none', `# test
local x = 1
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-none');
    const loc = symbols.getLocation('test')!;
    // $code is used but never assigned — no deferred block exists.
    expect(loc.dynamicVarCalls).toHaveLength(0);
  });

  it('skips indexed-variable assignments (conservative)', () => {
    const tree = parser.parse('test://vd-idx', `# test
local x = 1
$code[0] = {
  pl x
}
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-idx');
    const loc = symbols.getLocation('test')!;
    // Indexed LHS is not tracked.
    expect(loc.dynamicVarCalls).toHaveLength(0);
  });

  it('tracks global vars with multiple code-block assignments (universal-AND target set)', () => {
    const tree = parser.parse('test://vd-ambig', `# test
local x = 1
$code = { pl 'a' }
$code = { pl x }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ambig');
    const loc = symbols.getLocation('test')!;
    // Multi-assignment is now routed through callSiteTargets so all
    // candidates are tracked for per-target diagnostics.  An info
    // `multiple-assignments` diag still fires.
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-assignments');
    // Inner `x` resolves to the caller's local via deferred-walk
    // caller-locals injection (no longer falls back to the isolated
    // walk that produced a separate non-local ref).
    const allX = loc.findAllVariables('x');
    expect(allX.some(s => s.isLocal)).toBe(true);
  });

  it('global write in else-branch is visible at top-level dynamic even when if-branch uses local', () => {
    // `local $code` in the if-branch has bindScopeId=if_block.id — not
    // visible at the top-level `dynamic $code` after `end`.  The bare
    // `$code = …` in the else-branch is a global write (the retag pass
    // no longer promotes it to a local now that else_clause is a
    // separate scope-forming node — the if-branch local is NOT visible
    // from the sibling else-branch).  Global writes are always visible,
    // so the top-level `dynamic $code` tracks 1 code-block binding.
    const tree = parser.parse('test://vd-mix', `# test
local x = 1
if 1:
  local $code = { pl x }
else
  $code = { pl x }
end
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mix');
    const loc = symbols.getLocation('test')!;
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });

  it('does NOT track when scoped-out locals reach a top-level dynamic', () => {
    // Each `local $code` lives inside its own if-branch scope; neither
    // is visible at the top-level `dynamic $code` after `end`.
    // Result: zero visible code-block bindings → no tracking.
    const tree = parser.parse('test://vd-local-multi', `# test
local x = 1
if 1:
  local $code = { pl x }
else
  local $code = { pl x }
end
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-local-multi');
    const loc = symbols.getLocation('test')!;
    expect(loc.dynamicVarCalls).toHaveLength(0);
  });

  it('tracks per-scope when local binding is visible at call site', () => {
    // With the `dynamic $code` INSIDE the same if-branch, the local
    // binding IS visible → tracked.
    const tree = parser.parse('test://vd-local-inner', `# test
local x = 1
if 1:
  local $code = { pl x }
  dynamic $code
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-local-inner');
    const loc = symbols.getLocation('test')!;
    expect(loc.dynamicVarCalls).toHaveLength(1);
    const xSym = loc.findVariable('x');
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('still walks unused code-block assignments for diagnostics', () => {
    const tree = parser.parse('test://vd-unused', `# test
$code = {
  pl y
}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-unused');
    const loc = symbols.getLocation('test')!;
    // No dynamic/dyneval call → no registration.
    expect(loc.dynamicVarCalls).toHaveLength(0);
    // But the inner `y` must still be tracked (so diagnostics can fire).
    const ySym = loc.findVariable('y');
    expect(ySym).toBeDefined();
    expect(ySym!.references.length).toBeGreaterThanOrEqual(1);
  });

  it('still walks multi-assigned blocks (diagnostics preserved, all targets tracked)', () => {
    const tree = parser.parse('test://vd-ambig-walk', `# test
$code = { pl aaa }
$code = { pl bbb }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ambig-walk');
    const loc = symbols.getLocation('test')!;
    // Multi-assignment is now tracked: both candidate blocks are
    // recorded (deferred walk runs over each).
    expect(loc.dynamicVarCalls).toHaveLength(1);
    // Both inner vars are still registered.
    expect(loc.findVariable('aaa')).toBeDefined();
    expect(loc.findVariable('bbb')).toBeDefined();
  });

  it('registers untracked call with reason multiple-assignments', () => {
    const tree = parser.parse('test://vd-ut-multi', `# test
$code = { pl 1 }
$code = { pl 2 }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ut-multi');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-assignments');
    expect(loc.untrackedDynamicVarCalls[0].varName).toBe('$code');
  });

  it('registers untracked call with reason complex-expression for arrays', () => {
    const tree = parser.parse('test://vd-ut-arr', `# test
dynamic $code[0]
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ut-arr');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('complex-expression');
  });

  it('registers untracked call for binary expression first-arg', () => {
    const tree = parser.parse('test://vd-ut-expr', `# test
dynamic $a + $b
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ut-expr');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('complex-expression');
  });

  it('no untracked diagnostic for plain code-block literal', () => {
    const tree = parser.parse('test://vd-ut-lit', `# test
dynamic {
  pl 1
}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ut-lit');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
  });

  it('no untracked diagnostic for successfully resolved variable', () => {
    const tree = parser.parse('test://vd-ut-ok', `# test
local x = 1
$code = { pl x }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-ut-ok');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });

  // ── Multi-target tracking (resolvedDynamicBlocks.blockLocs[]) ──
  it('resolvedDynamicBlocks records all targets for multiple-assignments', () => {
    const tree = parser.parse('test://vd-mt-multi-assign', `# test
$code = { x = 1 }
$code = { x = 2 }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-multi-assign');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    const entry = loc.resolvedDynamicBlocks[0];
    expect(entry.kind).toBe('dynamic');
    // Both candidate blocks are tracked so per-target diagnostics
    // can apply universal-quantification logic.
    expect(entry.blockLocs).toHaveLength(2);
    // Each target's range must be distinct.
    expect(entry.blockLocs[0]).not.toEqual(entry.blockLocs[1]);
  });

  it('resolvedDynamicBlocks records all targets for cross-branch local bindings', () => {
    const tree = parser.parse('test://vd-mt-multi-local', `# test
local $code
if 1:
  $code = { x = 1 }
else
  $code = { x = 2 }
end
y = dyneval($code)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-multi-local');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    const entry = loc.resolvedDynamicBlocks[0];
    expect(entry.kind).toBe('dyneval');
    expect(entry.blockLocs).toHaveLength(2);
    // The multiple-local-bindings info diag co-fires.
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-local-bindings');
  });

  it('resolvedDynamicBlocks records all targets for same-scope sequential overwrites (no info diag)', () => {
    // `local $code = { … }` then `$code = { … }` in the same scope:
    // last-write-wins, no `multiple-local-bindings` info — but BOTH
    // blocks must still be tracked so each body is analysed and
    // universal-AND can apply.
    const tree = parser.parse('test://vd-mt-seq', `# test
local $code = { x = 1 }
$code = { x = 2 }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-seq');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(2);
    // No info diag for sequential same-scope writes.
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    // dynamicVarCalls is still populated (call site is tracked).
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });

  it('mixed local + global: local shadows global, single-target dispatch', () => {
    // QSP frame semantics: once `local $code` is declared, every
    // read of `$code` in this frame refers to the local — the
    // earlier global write is shadowed.  The resolver must drop the
    // global candidate and treat the call as a clean single-target
    // dispatch (no `multiple-assignments` info).
    const tree = parser.parse('test://vd-mt-mixed', `# test
$code = { x = 1 }
local $code = { x = 2 }
y = dyneval($code)
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-mixed');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
  });

  it('shadowing: cross-branch locals + global → only locals are candidates (multiple-local-bindings)', () => {
    // A global write precedes two cross-branch local declarations.
    // The global is shadowed by whichever local is in scope at the
    // call site; the call still has TWO local candidates from
    // distinct branches → `multiple-local-bindings`, not
    // `multiple-assignments`, and global is dropped.
    const tree = parser.parse('test://vd-shadow-cross', `# test
$code = { x = 0 }
if y > 0:
  local $code = { x = 1 }
else:
  local $code = { x = 2 }
end
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-shadow-cross');
    const loc = symbols.getLocation('test')!;
    // The call site sits OUTSIDE both branches' scopes — neither
    // local is visible, so the global IS the only candidate.  This
    // pins the visibility semantics: shadowing applies only where
    // the local is in scope.
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(1);
  });

  it('shadowing inside a branch: local shadows enclosing-loc global at the inner call', () => {
    // The call site is INSIDE the branch where `local $code` is
    // declared, so the local is visible AND shadows the global.
    const tree = parser.parse('test://vd-shadow-inner', `# test
$code = { x = 0 }
if y > 0:
  local $code = { x = 1 }
  dynamic $code
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-shadow-inner');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
  });

  it('mixed-prefix dispatch: `$code = {…}` then `dynamic code` (no prefix) resolves', () => {
    // Writer uses `$` prefix; dispatcher uses bare name.  Both map to
    // the same `code` bucket in `variableBindings`, so resolution
    // works regardless of which prefix is on the call site.
    const tree = parser.parse('test://vd-mixprefix', `# test
$code = { x = 1 }
dynamic code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mixprefix');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(1);
  });

  it('resolvedDynamicBlocks single-target dispatch uses 1-element blockLocs', () => {
    const tree = parser.parse('test://vd-mt-single', `# test
$code = { x = 1 }
dynamic $code
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-single');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(1);
  });

  it('resolvedDynamicBlocks captures argCount on multi-target dispatches', () => {
    const tree = parser.parse('test://vd-mt-args', `# test
$code = { x = 1 }
$code = { x = 2 }
dynamic $code, 99, 100
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-mt-args');
    const loc = symbols.getLocation('test')!;
    expect(loc.resolvedDynamicBlocks).toHaveLength(1);
    expect(loc.resolvedDynamicBlocks[0].argCount).toBe(2);
    expect(loc.resolvedDynamicBlocks[0].blockLocs).toHaveLength(2);
  });

  it('propagates transitively through chained var-mediated dynamic', () => {
    const tree = parser.parse('test://vd-chain', `# test
local x = 1
$inner = {
  pl x
}
$outer = {
  dynamic $inner
}
dynamic $outer
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-chain');
    const loc = symbols.getLocation('test')!;
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    // Definition + reference inside $inner (reached transitively via $outer).
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
    // Two dynamic-var calls recorded: outer → $outer, inner → $inner.
    expect(loc.dynamicVarCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('transitive chain reaches gs inside nested var-mediated block', () => {
    const tree = parser.parse('test://vd-chain-gs', `# main
local x = 5
$inner = {
  gs 'helper'
}
$outer = {
  dynamic $inner
}
dynamic $outer
---
# helper
pl x
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vd-chain-gs');
    const mainLoc = symbols.getLocation('main')!;
    const ref = mainLoc.locationRefs.get('helper')!;
    expect(ref).toBeDefined();
    expect(ref.references[0].localsInScope?.has('x')).toBe(true);
  });

  // ── variableBindings persistent store ──

  it('records code-block binding in variableBindings store', () => {
    const tree = parser.parse('test://vb-cb', `# test
$fn = {
  pl 1
}
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-cb');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('fn');
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0].value.kind).toBe('code-block');
    expect(entries![0].isLocal).toBe(false);
    if (entries![0].value.kind === 'code-block') {
      expect(entries![0].value.blockRange.line).toBeGreaterThanOrEqual(1);
    }
  });

  it('records string literal binding in variableBindings store', () => {
    const tree = parser.parse('test://vb-str', `# test
$name = 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-str');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('name');
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0].value.kind).toBe('string');
    if (entries![0].value.kind === 'string') {
      expect(entries![0].value.value).toBe('hello');
    }
  });

  it('records number literal binding in variableBindings store', () => {
    const tree = parser.parse('test://vb-num', `# test
#count = 42
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-num');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('count');
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(1);
    expect(entries![0].value.kind).toBe('number');
    if (entries![0].value.kind === 'number') {
      expect(entries![0].value.value).toBe(42);
    }
  });

  it('classifies interpolated strings as other, not string', () => {
    const tree = parser.parse('test://vb-interp', `# test
local x = 1
$greeting = 'hi <<x>>'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-interp');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('greeting');
    expect(entries).toBeDefined();
    expect(entries![0].value.kind).toBe('other');
  });

  it('marks local assignments in variableBindings', () => {
    const tree = parser.parse('test://vb-local', `# test
local $fn = { pl 1 }
$fn2 = { pl 2 }
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-local');
    const loc = symbols.getLocation('test')!;
    expect(loc.variableBindings.get('fn')![0].isLocal).toBe(true);
    expect(loc.variableBindings.get('fn2')![0].isLocal).toBe(false);
  });

  it('compound operators (+=, -=, *=, /=) record as other, not literal', () => {
    // `$x += 'y'` does NOT mean $x == 'y' afterwards — it means
    // $x == <prev $x> & 'y'.  We cannot statically know the post-state
    // from the RHS alone, so these must be classified as opaque.
    const tree = parser.parse('test://vb-compound', `# test
$s = 'start'
$s += 'more'
#n = 1
#n -= 2
#n *= 3
#n /= 4
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-compound');
    const loc = symbols.getLocation('test')!;
    const strEntries = loc.variableBindings.get('s')!;
    expect(strEntries).toHaveLength(2);
    expect(strEntries[0].value.kind).toBe('string');   // plain `=`
    expect(strEntries[1].value.kind).toBe('other');    // `+=`
    const numEntries = loc.variableBindings.get('n')!;
    expect(numEntries).toHaveLength(4);
    expect(numEntries[0].value.kind).toBe('number');   // plain `=`
    expect(numEntries[1].value.kind).toBe('other');    // `-=`
    expect(numEntries[2].value.kind).toBe('other');    // `*=`
    expect(numEntries[3].value.kind).toBe('other');    // `/=`
  });

  it('captures RHS source snippet on opaque (other) bindings', () => {
    // Tuple literals, arithmetic, function calls and interpolated
    // strings all fall into the `other` kind; the extractor must
    // capture the source snippet so hover can surface the expression
    // instead of an opaque placeholder.
    const tree = parser.parse('test://vb-other-text', `# test
x = [1, 2, 3]
$y = ['hi', 'there']
z = (10, 20)
w = ()
#sum = a + b
$greet = 'hi <<name>>'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-other-text');
    const loc = symbols.getLocation('test')!;
    const assertOtherText = (key: string, expected: string) => {
      const entries = loc.variableBindings.get(key);
      expect(entries, `missing binding for ${key}`).toBeDefined();
      expect(entries![0].value.kind).toBe('other');
      if (entries![0].value.kind === 'other') {
        expect(entries![0].value.text).toBe(expected);
      }
    };
    assertOtherText('x', '[1, 2, 3]');
    assertOtherText('y', "['hi', 'there']");
    assertOtherText('z', '(10, 20)');
    assertOtherText('w', '()');
    assertOtherText('sum', 'a + b');
    assertOtherText('greet', "'hi <<name>>'");
  });

  it('captures RHS snippet on compound-operator bindings', () => {
    const tree = parser.parse('test://vb-compound-text', `# test
$s = 'start'
$s += 'more'
#n = 1
#n *= 3
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-compound-text');
    const loc = symbols.getLocation('test')!;
    const sEntries = loc.variableBindings.get('s')!;
    expect(sEntries[1].value.kind).toBe('other');
    if (sEntries[1].value.kind === 'other') {
      expect(sEntries[1].value.text).toBe("'more'");
    }
    const nEntries = loc.variableBindings.get('n')!;
    expect(nEntries[1].value.kind).toBe('other');
    if (nEntries[1].value.kind === 'other') {
      expect(nEntries[1].value.text).toBe('3');
    }
  });

  it('collapses line breaks and caps overlong snippets', () => {
    // Tuple spread across multiple lines + an intentionally huge
    // literal: line breaks become single spaces (interior spaces /
    // indentation preserved verbatim) and the result must be
    // length-capped with an ellipsis.
    const big = Array.from({ length: 60 }, (_, i) => i).join(', ');
    const tree = parser.parse('test://vb-snippet-cap', `# test
multi = [
  1,
  2,
  3
]
huge = [${big}]
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-snippet-cap');
    const loc = symbols.getLocation('test')!;
    const multi = loc.variableBindings.get('multi')![0].value;
    expect(multi.kind).toBe('other');
    if (multi.kind === 'other') {
      // Each `\n` becomes one space; the original two-space indent on
      // each line is preserved verbatim.
      expect(multi.text).toBe('[   1,   2,   3 ]');
    }
    const huge = loc.variableBindings.get('huge')![0].value;
    expect(huge.kind).toBe('other');
    if (huge.kind === 'other') {
      expect(huge.text!.length).toBeLessThanOrEqual(80);
      expect(huge.text!.endsWith('…')).toBe(true);
    }
  });

  it('compound operator on code-block var does not create a var-ref edge', () => {
    // `$a += $b` is not a var-ref alias (post-state of $a includes the
    // previous $a concatenated with $b's value), so `dynamic $a` must
    // NOT resolve to any code-block reachable via $b.
    const tree = parser.parse('test://vb-compound-ref', `# test
$helper = { pl 'hi' }
$other += $helper
dynamic $other
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-compound-ref');
    const loc = symbols.getLocation('test')!;
    // $other has no tracked code-block chain (no alias edge was created).
    const otherCall = loc.dynamicVarCalls.find(d => d.varBaseName === '$other');
    expect(otherCall).toBeUndefined();
    // $other's binding is opaque.
    const otherEntries = loc.variableBindings.get('other')!;
    expect(otherEntries).toHaveLength(1);
    expect(otherEntries[0].value.kind).toBe('other');
  });

  it('scope-aware: local in act block is not visible from sibling act block', () => {
    // Two acts each declare their own `local $fn = {…}`.  A
    // `dynamic $fn` at the top level (outside both acts) has neither
    // binding visible — result: no dynamic tracking, and no cross-act
    // pollution of locals.
    const tree = parser.parse('test://vb-scope-act', `# test
act 'A':
  local $fn = { pl 'inside A' }
end
act 'B':
  local $fn = { pl 'inside B' }
end
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-act');
    const loc = symbols.getLocation('test')!;
    // Top-level dynamic sees NEITHER local.
    expect(loc.dynamicVarCalls).toHaveLength(0);
    // Both local bindings are recorded in the store with different scopeNodeIds.
    const entries = loc.variableBindings.get('fn')!;
    expect(entries).toHaveLength(2);
    expect(entries[0].scopeNodeId).not.toBe(0);
    expect(entries[1].scopeNodeId).not.toBe(0);
    expect(entries[0].scopeNodeId).not.toBe(entries[1].scopeNodeId);
    // Both isolation ancestors are the act blocks themselves.
    expect(entries[0].isolationAncestorId).toBe(entries[0].scopeNodeId);
    expect(entries[1].isolationAncestorId).toBe(entries[1].scopeNodeId);
  });

  it('scope-aware: local inside act only resolves dynamic at same act', () => {
    const tree = parser.parse('test://vb-scope-act-in', `# test
act 'A':
  local x = 1
  local $fn = { pl x }
  dynamic $fn
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-act-in');
    const loc = symbols.getLocation('test')!;
    // Dynamic inside the act resolves to the act-local binding.
    expect(loc.dynamicVarCalls).toHaveLength(1);
    const xSym = loc.findVariable('x');
    // x is referenced in the block, through the deferred walk with
    // caller-locals injection.
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('scope-aware: global binding is visible everywhere across isolation', () => {
    // Plain `$fn = {…}` at top level is GLOBAL; visible from inside
    // any nested act block despite the isolation boundary.
    const tree = parser.parse('test://vb-scope-glob', `# test
$fn = { pl 'top' }
act 'A':
  dynamic $fn
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-glob');
    const loc = symbols.getLocation('test')!;
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });

  it('scope-aware: local binding shadowed by outer scope does not leak', () => {
    // `local $fn = {…}` inside act A is not visible to a top-level
    // dynamic after the act ends.  If there's ALSO a global binding,
    // only the global resolves at the top-level call site.
    const tree = parser.parse('test://vb-scope-shadow', `# test
$fn = { pl 'global' }
act 'A':
  local $fn = { pl 'act-local' }
end
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-shadow');
    const loc = symbols.getLocation('test')!;
    // Only the GLOBAL binding is visible at top-level dynamic → single
    // tracked target → unambiguous.
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
  });

  it('scope-aware: local-inside-act does not trigger ambiguity with global', () => {
    // With old flat resolution, local-in-act + global would be "mixed
    // local + global" → ambiguous.  With scope-awareness the local is
    // not visible at the top-level call site; only the global is seen.
    const tree = parser.parse('test://vb-scope-no-ambig', `# test
$fn = { pl 'global1' }
act 'A':
  local $fn = { pl 'act-local' }
end
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-no-ambig');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });

  it('scope-aware: two global code-block bindings remain ambiguous', () => {
    // Scope-awareness does not change the rule that two GLOBAL defs
    // in the same location are ambiguous.
    const tree = parser.parse('test://vb-scope-two-globals', `# test
$fn = { pl 'one' }
$fn = { pl 'two' }
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-two-globals');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-assignments');
  });

  it('scope-aware: bindings record scopeNodeId and isolationAncestorId', () => {
    const tree = parser.parse('test://vb-scope-meta', `# test
$top = { pl 'top' }
act 'A':
  local $inner = { pl 'inner' }
  if 1:
    local $if = { pl 'if' }
  end
end
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-scope-meta');
    const loc = symbols.getLocation('test')!;
    const top = loc.variableBindings.get('top')![0];
    const inner = loc.variableBindings.get('inner')![0];
    const ifB = loc.variableBindings.get('if')![0];
    // Top-level binding: scope/isolation both 0.
    expect(top.scopeNodeId).toBe(0);
    expect(top.isolationAncestorId).toBe(0);
    // Act-local binding: scopeNodeId === act, isolation === act.
    expect(inner.scopeNodeId).not.toBe(0);
    expect(inner.isolationAncestorId).toBe(inner.scopeNodeId);
    // Inside-if binding: scopeNodeId === if_block (non-isolating),
    // isolationAncestorId === enclosing act.
    expect(ifB.scopeNodeId).not.toBe(0);
    expect(ifB.isolationAncestorId).not.toBe(0);
    expect(ifB.isolationAncestorId).not.toBe(ifB.scopeNodeId);
    expect(ifB.isolationAncestorId).toBe(inner.isolationAncestorId);
  });

  // ── document-wide globalBindings index ──

  it('globalBindings: collects non-local bindings across all locations', () => {
    const tree = parser.parse('test://gb-doc', `# loc_a
$fn = { pl 'a' }
#count = 1
---
# loc_b
$fn = { pl 'b' }
$name = 'bob'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gb-doc');
    // $fn has two global bindings, one per location.
    const fnEntries = symbols.globalBindings.get('fn')!;
    expect(fnEntries).toHaveLength(2);
    const locNames = new Set(fnEntries.map(e => e.locationName));
    expect(locNames.has('loc_a')).toBe(true);
    expect(locNames.has('loc_b')).toBe(true);
    // #count exists only in loc_a.
    const countEntries = symbols.globalBindings.get('count')!;
    expect(countEntries).toHaveLength(1);
    expect(countEntries[0].locationName).toBe('loc_a');
    expect(countEntries[0].binding.value.kind).toBe('number');
    // $name exists only in loc_b.
    const nameEntries = symbols.globalBindings.get('name')!;
    expect(nameEntries).toHaveLength(1);
    expect(nameEntries[0].locationName).toBe('loc_b');
    expect(nameEntries[0].binding.value.kind).toBe('string');
  });

  it('globalBindings: excludes local bindings', () => {
    const tree = parser.parse('test://gb-local', `# test
local $fn = { pl 'local' }
$other = 'global'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://gb-local');
    // $fn local → excluded from globalBindings.
    expect(symbols.globalBindings.has('$fn')).toBe(false);
    // $other global → present.
    expect(symbols.globalBindings.get('other')).toHaveLength(1);
  });

  it('globalBindings: rebuilt on re-run, no duplicate accumulation', () => {
    const source = `# test
$fn = 'value'
---
`;
    const tree = parser.parse('test://gb-reb', source);
    const { symbols: s1 } = extractSymbols(tree!, 'test://gb-reb');
    expect(s1.globalBindings.get('fn')).toHaveLength(1);
    // Re-run on a FRESH symbols table — should still be 1 (not 2).
    const { symbols: s2 } = extractSymbols(tree!, 'test://gb-reb');
    expect(s2.globalBindings.get('fn')).toHaveLength(1);
  });

  // ── side-effect writes (setvar / scanstr / unpackarr / copyarr / sortarr / killvar) ──

  it('side-effect: setvar records an other-kind binding', () => {
    const tree = parser.parse('test://se-setvar', `# test
setvar '$fn', 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-setvar');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('fn')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
    expect(entries[0].isLocal).toBe(false);
  });

  it('side-effect: scanstr records an other-kind binding (base-keyed storage)', () => {
    const tree = parser.parse('test://se-scan', `# test
scanstr '$fn', 'foo'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-scan');
    const loc = symbols.getLocation('test')!;
    // Storage is uniformly base-keyed in modern QSP \u2014 the leading `$`
    // in the source string is dropped from the storage key (since
    // `$fn`, `#fn`, `fn` all share one slot).  The literal prefix is
    // still tracked on `sym.prefixes` for diagnostic purposes.
    const entries = loc.variableBindings.get('fn')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
    // Nothing should land in the typed-prefixed bucket.
    expect(loc.variableBindings.get('$fn')).toBeUndefined();
  });

  it('side-effect: string-arg ops record the literal prefix on sym.prefixes (uniform tracking)', () => {
    // Modern QSP: `$x`, `#x`, `%x`, `x` all denote the SAME slot — the
    // prefix is just a runtime coercion lens, not a slot selector.
    // Storage is therefore base-keyed for every op (typed or not),
    // BUT the literal prefix the user typed in the string is still
    // surfaced on `sym.prefixes` so the `mixedVariablePrefixes`
    // diagnostic can flag inconsistent prefix usage uniformly.
    const tree = parser.parse('test://prefix-uniform', `# t
killvar '$a'
killvar '#b'
killvar '%c'
copyarr '$dst', '#src'
scanstr '$s', 'foo'
x = arrsize('$arr')
---
`);
    const { symbols } = extractSymbols(tree!, 'test://prefix-uniform');
    const loc = symbols.getLocation('t')!;
    // Every binding lands under the bare base-name key — nothing in
    // typed-prefix buckets, regardless of what the literal said.
    for (const base of ['a', 'b', 'c', 'dst', 's']) {
      expect(loc.variableBindings.get(base), `bare base '${base}'`).toBeDefined();
      for (const p of ['$', '#', '%']) {
        expect(
          loc.variableBindings.get(p + base),
          `typed bucket '${p + base}' must be empty (storage is base-keyed)`,
        ).toBeUndefined();
      }
    }
    // copyarr 'src' (`#src`) and arrsize 'arr' (`$arr`) are recorded
    // as variable refs.  The literal prefix in the string IS tracked
    // on `sym.prefixes` because the user typed it as a real use of
    // that prefix on the variable.
    const srcSym = loc.findVariable('src');
    expect(srcSym).toBeDefined();
    expect(srcSym!.references.length).toBeGreaterThanOrEqual(1);
    expect([...(srcSym!.prefixes ?? [])].sort()).toEqual(['#']);
    const arrSym = loc.findVariable('arr');
    expect(arrSym).toBeDefined();
    expect(arrSym!.references.length).toBeGreaterThanOrEqual(1);
    expect([...(arrSym!.prefixes ?? [])].sort()).toEqual(['$']);
  });

  it('side-effect: unpackarr records an other-kind binding', () => {
    const tree = parser.parse('test://se-unp', `# test
unpackarr 'arr', 1, 2, 3
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-unp');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('arr')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
  });

  it('side-effect: copyarr destination records an other-kind binding', () => {
    const tree = parser.parse('test://se-cp', `# test
copyarr 'dst', 'src'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-cp');
    const loc = symbols.getLocation('test')!;
    const dst = loc.variableBindings.get('dst')!;
    expect(dst).toHaveLength(1);
    expect(dst[0].value.kind).toBe('other');
    // Source is also recorded (it's read-not-written, but `copyarr`
    // counts both sides as side-effect writes only on dest).  Source
    // should NOT appear in variableBindings.
    expect(loc.variableBindings.has('src')).toBe(false);
  });

  it('side-effect: sortarr records an other-kind binding (permutation)', () => {
    const tree = parser.parse('test://se-sort', `# test
sortarr 'arr'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-sort');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('arr')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
  });

  it('side-effect: killvar records an other-kind binding with isValueBearing=false', () => {
    const tree = parser.parse('test://se-kv', `# test
killvar 'arr'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-kv');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('arr')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
    // killvar does not produce a value — hover must not show it.
    expect(entries[0].isValueBearing).toBe(false);
  });

  it('side-effect: sortarr binding also has isValueBearing=false (no produced value)', () => {
    const tree = parser.parse('test://se-sort-nodelete', `# test
sortarr 'arr'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-sort-nodelete');
    const loc = symbols.getLocation('test')!;
    const sortEntries = loc.variableBindings.get('arr')!;
    expect(sortEntries[0].isValueBearing).toBe(false);
  });

  it('side-effect: killvar without arg records no bindings', () => {
    const tree = parser.parse('test://se-kv-all', `# test
killvar
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-kv-all');
    const loc = symbols.getLocation('test')!;
    expect(loc.variableBindings.size).toBe(0);
  });

  it('side-effect: indexed name strips [index] for binding key', () => {
    const tree = parser.parse('test://se-idx', `# test
setvar 'arr[0]', 'value'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-idx');
    const loc = symbols.getLocation('test')!;
    // The binding is recorded against the base name (no [0]).
    const entries = loc.variableBindings.get('arr')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].value.kind).toBe('other');
  });

  it('side-effect: side-effect writes co-exist with direct assignments', () => {
    const tree = parser.parse('test://se-mix', `# test
$fn = 'literal'
setvar '$fn', 'runtime'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-mix');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('fn')!;
    expect(entries).toHaveLength(2);
    // Order = source order.
    expect(entries[0].value.kind).toBe('string');
    expect(entries[1].value.kind).toBe('other');
  });

  it('side-effect: surfaces in document-wide globalBindings index', () => {
    const tree = parser.parse('test://se-glob', `# test
setvar '$fn', 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://se-glob');
    const entries = symbols.globalBindings.get('fn')!;
    expect(entries).toHaveLength(1);
    expect(entries[0].binding.value.kind).toBe('other');
    expect(entries[0].locationName).toBe('test');
  });

  it('non-code-block assignments do not make a single code-block binding ambiguous', () => {
    // User rule: "only variable for code block is local — other
    // variables don't matter".  A string assignment to the same var
    // must NOT disqualify the code-block binding.
    const tree = parser.parse('test://vb-mixed', `# test
local x = 1
$fn = {
  pl x
}
$fn = 'some text'
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-mixed');
    const loc = symbols.getLocation('test')!;
    // No ambiguity diagnostic — only one code-block assignment exists.
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    // The dynamic call resolved and propagated x into the block.
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.dynamicVarCalls[0].localNames).toContain('x');
    // Store has both assignments.
    const entries = loc.variableBindings.get('fn');
    expect(entries).toHaveLength(2);
    const kinds = entries!.map(e => e.value.kind).sort();
    expect(kinds).toEqual(['code-block', 'string']);
  });

  it('two globally-assigned code-blocks ARE still ambiguous even if mixed with literals', () => {
    const tree = parser.parse('test://vb-two-cb', `# test
$fn = { pl 1 }
$fn = 'text'
$fn = { pl 2 }
dynamic $fn
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-two-cb');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-assignments');
  });

  it('records multi-assignment parallel bindings separately', () => {
    const tree = parser.parse('test://vb-par', `# test
$a, $b = { pl 1 }, 'hello'
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-par');
    const loc = symbols.getLocation('test')!;
    expect(loc.variableBindings.get('a')![0].value.kind).toBe('code-block');
    expect(loc.variableBindings.get('b')![0].value.kind).toBe('string');
  });

  // ── var-ref bindings (reassignments between variables) ──

  it('records var-ref binding when RHS is a bare variable reference', () => {
    const tree = parser.parse('test://vb-ref', `# test
$src = { pl 1 }
local $alias = $src
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-ref');
    const loc = symbols.getLocation('test')!;
    const entries = loc.variableBindings.get('alias');
    expect(entries).toHaveLength(1);
    expect(entries![0].value.kind).toBe('var-ref');
    if (entries![0].value.kind === 'var-ref') {
      expect(entries![0].value.varBaseName).toBe('src');
    }
    expect(entries![0].isLocal).toBe(true);
  });

  it('dynamic <var-ref> resolves transitively to the source code-block', () => {
    const tree = parser.parse('test://vb-chain', `# test
local x = 1
$src = {
  pl x
}
local $alias = $src
dynamic $alias
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-chain');
    const loc = symbols.getLocation('test')!;
    // The dynamic $alias call should resolve through the var-ref chain
    // and propagate caller locals into $src's body.
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    expect(loc.dynamicVarCalls).toHaveLength(1);
    expect(loc.dynamicVarCalls[0].varBaseName).toBe('alias');
    expect(loc.dynamicVarCalls[0].localNames).toContain('x');
    // x is referenced inside $src (reached via $alias).
    const xSym = loc.findVariable('x');
    expect(xSym).toBeDefined();
    expect(xSym!.isLocal).toBe(true);
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('var-ref chains of length ≥ 2 still resolve', () => {
    const tree = parser.parse('test://vb-chain2', `# test
local x = 1
$src = { pl x }
set $mid = $src
set $alias = $mid
dynamic $alias
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-chain2');
    const loc = symbols.getLocation('test')!;
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    expect(loc.dynamicVarCalls).toHaveLength(1);
    const xSym = loc.findVariable('x');
    expect(xSym!.references.length).toBeGreaterThanOrEqual(2);
  });

  it('cyclic var-refs are handled without infinite recursion', () => {
    // $a = $b, $b = $a — pathological but must not hang/crash.
    // Neither has a code-block, so nothing should be tracked.
    const tree = parser.parse('test://vb-cycle', `# test
set $a = $b
set $b = $a
dynamic $a
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-cycle');
    const loc = symbols.getLocation('test')!;
    // No code-block in the cycle → nothing tracked, no ambiguity.
    expect(loc.dynamicVarCalls).toHaveLength(0);
    expect(loc.variableBindings.get('a')![0].value.kind).toBe('var-ref');
    expect(loc.variableBindings.get('b')![0].value.kind).toBe('var-ref');
  });

  it('var-ref to a source with 2 global code-blocks inherits ambiguity', () => {
    const tree = parser.parse('test://vb-amb', `# test
$src = { pl 1 }
$src = { pl 2 }
set $alias = $src
dynamic $alias
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-amb');
    const loc = symbols.getLocation('test')!;
    // $src is ambiguous (2 globals), so $alias should be too.
    expect(loc.untrackedDynamicVarCalls).toHaveLength(1);
    expect(loc.untrackedDynamicVarCalls[0].reason).toBe('multiple-assignments');
    expect(loc.untrackedDynamicVarCalls[0].varName).toBe('$alias');
  });

  it('self-reference (set $a = $a) is tolerated', () => {
    const tree = parser.parse('test://vb-self', `# test
$a = { pl 1 }
set $a = $a
dynamic $a
---
`);
    const { symbols } = extractSymbols(tree!, 'test://vb-self');
    const loc = symbols.getLocation('test')!;
    // Only one code-block exists; the self-referential `set $a = $a` is
    // a var-ref whose edge points back to $a — ignored (same name).
    expect(loc.untrackedDynamicVarCalls).toHaveLength(0);
    expect(loc.dynamicVarCalls).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cross-location local propagation diagnostics
// ──────────────────────────────────────────────────────────────────────

describe('cross-location local propagation diagnostics', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Simulate the diagnostic logic for uninitialized variables,
   * including incomingLocals suppression/downgrade.
   * Returns: { varName, locName, severity: 'warning' | 'info' }
   */
  function findUninitDiags(code: string): { varName: string; locName: string; severity: string }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { uninitializedVariables: true }),
      'used but never assigned',
    );
    return diags.map(d => {
      const p = parseVariableDiagnostic(locIdx, d);
      return {
        varName: p.varName,
        locName: p.locName,
        severity: p.severity === 2 ? 'warning' : p.severity === 3 ? 'info' : 'other',
      };
    });
  }

  /**
   * Simulate the diagnostic logic for unused variables,
   * including readWithoutDef suppression for propagated locals.
   */
  function findUnusedDiags(code: string): { varName: string; locName: string }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { unusedVariables: true }),
      'assigned but never read',
    );
    // Dedupe to unique (locName, varName) pairs — the engine may emit one diag per reference
    const seen = new Set<string>();
    const result: { varName: string; locName: string }[] = [];
    for (const d of diags) {
      const p = parseVariableDiagnostic(locIdx, d);
      const key = `${p.locName.toLowerCase()}\0${p.varName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ varName: p.varName, locName: p.locName });
    }
    return result;
  }

  // ── Uninitialized variable suppression ───────────────────────────

  it('suppresses uninitialized warning when all callers provide the local', () => {
    const diags = findUninitDiags(`# main
local x = 5
gs 'helper'
---
# helper
pl x
---
`);
    // x in helper should be fully suppressed (main provides it)
    expect(diags.filter(d => d.varName === 'x')).toHaveLength(0);
  });

  it('suppresses when some callers provide (any provider suffices)', () => {
    const diags = findUninitDiags(`# caller1
local x = 5
gs 'helper'
---
# caller2
gs 'helper'
---
# helper
pl x
---
`);
    // x in helper should be suppressed — at least one caller provides it
    const xDiags = diags.filter(d => d.varName === 'x' && d.locName === 'helper');
    expect(xDiags).toHaveLength(0);
  });

  it('keeps warning when no callers provide the local', () => {
    const diags = findUninitDiags(`# main
gs 'helper'
---
# helper
pl x
---
`);
    const xDiags = diags.filter(d => d.varName === 'x' && d.locName === 'helper');
    expect(xDiags).toHaveLength(1);
    expect(xDiags[0].severity).toBe('warning');
  });

  it('keeps warning when location is never called', () => {
    const diags = findUninitDiags(`# helper
pl x
---
`);
    const xDiags = diags.filter(d => d.varName === 'x');
    expect(xDiags).toHaveLength(1);
    expect(xDiags[0].severity).toBe('warning');
  });

  it('goto does not count as providing locals', () => {
    const diags = findUninitDiags(`# main
local x = 5
goto 'helper'
---
# helper
pl x
---
`);
    const xDiags = diags.filter(d => d.varName === 'x' && d.locName === 'helper');
    expect(xDiags).toHaveLength(1);
    expect(xDiags[0].severity).toBe('warning');
  });

  // ── Unused local suppression ─────────────────────────────────────

  it('suppresses unused local when callee reads it', () => {
    const diags = findUnusedDiags(`# main
local x = 5
gs 'helper'
---
# helper
pl x
---
`);
    // x in main should NOT be flagged as unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(0);
  });

  it('flags unused local when callee does NOT read it', () => {
    const diags = findUnusedDiags(`# main
local x = 5
gs 'helper'
---
# helper
pl 'hello'
---
`);
    // x in main IS unused — helper doesn't read x
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(1);
  });

  it('flags unused local when call is goto (no propagation)', () => {
    const diags = findUnusedDiags(`# main
local x = 5
goto 'helper'
---
# helper
pl x
---
`);
    // goto doesn't propagate — x in main is unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(1);
  });

  // ── Transitive propagation (A→B→C) ──────────────────────────────

  it('transitive: A→B→C suppresses uninitialized in C', () => {
    const diags = findUninitDiags(`# A
local x = 10
gs 'B'
---
# B
gs 'C'
---
# C
pl x
---
`);
    // x propagates A→B→C transitively (B doesn't define x)
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('transitive: A→B→C — unused suppressed when C reads it', () => {
    const diags = findUnusedDiags(`# A
local x = 10
gs 'B'
---
# B
gs 'C'
---
# C
pl x
---
`);
    // x in A is not unused — C reads it transitively
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'A')).toHaveLength(0);
  });

  it('transitive: stops when intermediate defines the var', () => {
    const diags = findUninitDiags(`# A
local x = 10
gs 'B'
---
# B
local x = 99
gs 'C'
---
# C
pl x
---
`);
    // B redefines x, so C gets x from B, not A — but either way suppressed
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('transitive: unused flagged when nobody reads it', () => {
    const diags = findUnusedDiags(`# A
local x = 10
gs 'B'
---
# B
gs 'C'
---
# C
pl 'no x here'
---
`);
    // Nobody reads x — A's x is unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'A')).toHaveLength(1);
  });

  // ── Dynamic/dyneval calling gs/func ──────────────────────────────

  it('dynamic calling gs propagates locals transitively', () => {
    const diags = findUninitDiags(`# main
local x = 5
dynamic {
  gs 'helper'
}
---
# helper
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'helper')).toHaveLength(0);
  });

  it('dynamic calling gs — unused suppressed when callee reads', () => {
    const diags = findUnusedDiags(`# main
local x = 5
dynamic {
  gs 'helper'
}
---
# helper
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(0);
  });

  it('dyneval calling func propagates locals transitively', () => {
    const diags = findUninitDiags(`# main
local x = 5
y = dyneval({func('helper')})
---
# helper
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'helper')).toHaveLength(0);
  });

  // ── Nested dynamic/dyneval ───────────────────────────────────────

  it('nested dynamic inherits locals and propagates via gs', () => {
    const diags = findUninitDiags(`# main
local x = 5
dynamic {
  dynamic {
    gs 'helper'
  }
}
---
# helper
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'helper')).toHaveLength(0);
  });

  // ── func/@/@@ transitive chains ─────────────────────────────────

  it('transitive via func: A→B→C suppresses uninitialized', () => {
    const diags = findUninitDiags(`# A
local x = 10
y = func('B')
---
# B
y = func('C')
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('transitive via @: A→B→C suppresses uninitialized', () => {
    const diags = findUninitDiags(`# A
local x = 10
@B
---
# B
@C
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('transitive via @@: A→B→C suppresses uninitialized', () => {
    const diags = findUninitDiags(`# A
local x = 10
@@B
---
# B
@@C
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  // ── Cycle detection ──────────────────────────────────────────────

  it('cycle A→B→A does not infinite loop, still propagates', () => {
    const diags = findUninitDiags(`# A
local x = 5
gs 'B'
---
# B
gs 'A'
pl x
---
`);
    // B reads x, provided by A — suppressed despite cycle
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'B')).toHaveLength(0);
  });

  it('cycle A→B→A — unused suppressed when B reads it', () => {
    const diags = findUnusedDiags(`# A
local x = 5
gs 'B'
---
# B
gs 'A'
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'A')).toHaveLength(0);
  });

  it('self-recursive location does not infinite loop', () => {
    const diags = findUninitDiags(`# A
local x = 5
gs 'A'
pl x
---
`);
    // x is defined and read in same location — no warning
    expect(diags.filter(d => d.varName === 'x')).toHaveLength(0);
  });

  // ── Multiple providers ───────────────────────────────────────────

  it('multiple providers: C receives x from both A and B', () => {
    const diags = findUninitDiags(`# A
local x = 1
gs 'C'
---
# B
local x = 2
gs 'C'
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('multiple providers: unused suppressed when any callee reads', () => {
    const diags = findUnusedDiags(`# A
local x = 1
gs 'C'
---
# B
local x = 2
gs 'C'
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'A')).toHaveLength(0);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'B')).toHaveLength(0);
  });

  // ── Mixed call types in transitive chain ─────────────────────────

  it('mixed: gs then func in chain', () => {
    const diags = findUninitDiags(`# A
local x = 10
gs 'B'
---
# B
y = func('C')
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  it('mixed: @ then gs in chain', () => {
    const diags = findUninitDiags(`# A
local x = 10
@B
---
# B
gs 'C'
---
# C
pl x
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'C')).toHaveLength(0);
  });

  // ── Shadowed (nested-scope) local variables ──────────────────────

  it('shadowed local: inner scope x propagated, outer x unused', () => {
    const diags = findUnusedDiags(`# main
local x = 1
if 1:
  local x = 2
  gs 'helper'
end
---
# helper
pl x
---
`);
    // inner x (=2) is propagated and read by helper → not unused
    // outer x (=1) is never read → flagged as unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(1);
  });

  it('shadowed local: outer scope x propagated when call is outside inner scope', () => {
    const diags = findUnusedDiags(`# main
local x = 1
if 1:
  local x = 2
end
gs 'helper'
---
# helper
pl x
---
`);
    // call is after the if block, so outer x (=1) is in scope → propagated → not unused
    // inner x (=2) is never read → flagged as unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(1);
  });

  it('shadowed local: uninit suppressed with correct scoped provider', () => {
    const diags = findUninitDiags(`# main
local x = 1
if 1:
  local x = 2
  gs 'helper'
end
---
# helper
pl x
---
`);
    // helper receives x from inner scope — suppressed
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'helper')).toHaveLength(0);
  });

  it('shadowed local: both scoped locals used locally are not unused', () => {
    const diags = findUnusedDiags(`# main
local x = 1
pl x
if 1:
  local x = 2
  pl x
end
---
`);
    // both x's are read locally → neither is unused
    expect(diags.filter(d => d.varName === 'x' && d.locName === 'main')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// findVariableAtPosition — scope-aware lookup
// ──────────────────────────────────────────────────────────────────────

describe('integration: mixed variable prefix tracking', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function getPrefixes(code: string): Map<string, Set<string>> {
    const tree = parser.parse('test://prefix-mix', code)!;
    const { symbols } = extractSymbols(tree, 'test://prefix-mix');
    const result = new Map<string, Set<string>>();
    for (const [, locSyms] of symbols.locations) {
      for (const [key, sym] of locSyms.variables) {
        if (sym.prefixes && sym.prefixes.size > 0) {
          result.set(key, new Set(sym.prefixes));
        }
      }
    }
    return result;
  }

  // ── Single prefix (no mixing) ──

  it('tracks no-prefix for plain variable', () => {
    const p = getPrefixes(`# main\nx = 4\ny = x + 1\n---\n`);
    expect(p.get('x')).toEqual(new Set(['#']));
  });

  it('tracks $ prefix for string variable', () => {
    const p = getPrefixes(`# main\n$name = 'hello'\npl $name\n---\n`);
    expect(p.get('name')).toEqual(new Set(['$']));
  });

  it('tracks # prefix for array count', () => {
    const p = getPrefixes(`# main\nx = #arr\n---\n`);
    expect(p.get('arr')).toEqual(new Set(['#']));
  });

  it('tracks % prefix for tuple access', () => {
    const p = getPrefixes(`# main\n%t = 1\n---\n`);
    expect(p.get('t')).toEqual(new Set(['%']));
  });

  // ── Mixed prefixes ──

  it('detects numeric + string prefix mix (a and $a)', () => {
    const p = getPrefixes(`# main\na = 4\npl $a\n---\n`);
    expect(p.get('a')).toEqual(new Set(['#', '$']));
  });

  it('detects string + numeric prefix mix ($x and x)', () => {
    const p = getPrefixes(`# main\n$x = 'hi'\ny = x + 1\n---\n`);
    expect(p.get('x')).toEqual(new Set(['$', '#']));
  });

  it('detects % + $ prefix mix', () => {
    const p = getPrefixes(`# main\n%x = 1\npl $x\n---\n`);
    expect(p.get('x')).toEqual(new Set(['%', '$']));
  });

  it('detects % + none prefix mix', () => {
    const p = getPrefixes(`# main\n%x = 1\ny = x + 1\n---\n`);
    expect(p.get('x')).toEqual(new Set(['%', '#']));
  });

  it('detects # + $ prefix mix', () => {
    const p = getPrefixes(`# main\nx = #arr\npl $arr\n---\n`);
    expect(p.get('arr')).toEqual(new Set(['#', '$']));
  });

  it('detects three prefix mix (none, $, #)', () => {
    const p = getPrefixes(`# main\na = 1\npl $a\nx = #a\n---\n`);
    expect(p.get('a')).toEqual(new Set(['#', '$']));
  });

  it('detects all four prefix mix', () => {
    const p = getPrefixes(`# main\na = 1\npl $a\nx = #a\n%a = 2\n---\n`);
    expect(p.get('a')).toEqual(new Set(['#', '$', '%']));
  });

  // ── No false positives for different variables ──

  it('does not mix prefixes of different variables', () => {
    const p = getPrefixes(`# main\na = 1\n$b = 'hi'\n---\n`);
    expect(p.get('a')).toEqual(new Set(['#']));
    expect(p.get('b')).toEqual(new Set(['$']));
  });

  // ── String-based variable references (arrsize, killvar, etc.) ──

  it('arrsize tracks the literal prefix from its string argument', () => {
    // In modern QSP `$arr`, `#arr`, `arr` all share one slot, so the
    // prefix in `arrsize('$arr')` is naming-only at the runtime level.
    // But the user DID type `$`, so for diagnostic purposes we record
    // it as a real use of `$` on `arr` — mixing prefixes is still
    // worth flagging even when the runtime ignores them.
    const p = getPrefixes(`# main\narr[0] = 1\nx = arrsize('$arr')\n---\n`);
    expect(p.get('arr')).toEqual(new Set(['#', '$']));
  });

  it('tracks prefix from killvar string argument', () => {
    const p = getPrefixes(`# main\n$name = 'hi'\nkillvar 'name'\n---\n`);
    expect(p.get('name')).toEqual(new Set(['$', '#']));
  });

  it('tracks prefix from setvar string argument', () => {
    const p = getPrefixes(`# main\nsetvar '$score', 100\npl score\n---\n`);
    expect(p.get('score')).toEqual(new Set(['$', '#']));
  });

  // ── Multiple locations: per-location tracking + cross-location aggregation ──

  it('tracks prefixes per location in symbol table', () => {
    const tree = parser.parse('test://prefix-multi', `# loc1\na = 1\n---\n# loc2\npl $a\n---\n`)!;
    const { symbols } = extractSymbols(tree, 'test://prefix-multi');
    const loc1 = symbols.getLocation('loc1')!;
    const loc2 = symbols.getLocation('loc2')!;
    expect(loc1.variables.get('a')!.prefixes).toEqual(new Set(['#']));
    expect(loc2.variables.get('a')!.prefixes).toEqual(new Set(['$']));
  });

  it('cross-location aggregation detects mixed prefixes', () => {
    const tree = parser.parse('test://prefix-cross', `# loc1\na = 1\n---\n# loc2\npl $a\n---\n`)!;
    const { symbols } = extractSymbols(tree, 'test://prefix-cross');
    // Aggregate prefixes across all locations (like the server does)
    const global = new Map<string, Set<string>>();
    for (const [, locSyms] of symbols.locations) {
      for (const [key, sym] of locSyms.variables) {
        if (!sym.prefixes) continue;
        let entry = global.get(key);
        if (!entry) { entry = new Set(); global.set(key, entry); }
        for (const p of sym.prefixes) entry.add(p);
      }
    }
    expect(global.get('a')).toEqual(new Set(['#', '$']));
  });

  it('cross-location: no mix when same prefix in all locations', () => {
    const tree = parser.parse('test://prefix-same', `# loc1\n$a = 'x'\n---\n# loc2\npl $a\n---\n`)!;
    const { symbols } = extractSymbols(tree, 'test://prefix-same');
    const global = new Map<string, Set<string>>();
    for (const [, locSyms] of symbols.locations) {
      for (const [key, sym] of locSyms.variables) {
        if (!sym.prefixes) continue;
        let entry = global.get(key);
        if (!entry) { entry = new Set(); global.set(key, entry); }
        for (const p of sym.prefixes) entry.add(p);
      }
    }
    expect(global.get('a')).toEqual(new Set(['$']));
  });

  it('cross-location: detects three-way mix across locations', () => {
    const tree = parser.parse('test://prefix-3way', `# loc1\na = 1\n---\n# loc2\npl $a\n---\n# loc3\nx = #a\n---\n`)!;
    const { symbols } = extractSymbols(tree, 'test://prefix-3way');
    const global = new Map<string, Set<string>>();
    for (const [, locSyms] of symbols.locations) {
      for (const [key, sym] of locSyms.variables) {
        if (!sym.prefixes) continue;
        let entry = global.get(key);
        if (!entry) { entry = new Set(); global.set(key, entry); }
        for (const p of sym.prefixes) entry.add(p);
      }
    }
    expect(global.get('a')).toEqual(new Set(['#', '$']));
  });
});

// ──────────────────────────────────────────────────────────────────────
// Mixed variable prefix detection with local propagation
// ──────────────────────────────────────────────────────────────────────

describe('mixed prefix detection with propagated locals', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Mirrors the mixed-prefix diagnostic logic from computeDiagnostics,
   * including cross-location propagated locals.
   * Returns: array of { varName, locName, prefixes } for each location
   * where a mixed-prefix diagnostic would be emitted.
   */
  function findMixedPrefixDiags(code: string): { varName: string; locName: string; prefixes: string[] }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { mixedVariablePrefixes: true }),
      'mixed type prefixes',
    );
    const seen = new Set<string>();
    const result: { varName: string; locName: string; prefixes: string[] }[] = [];
    for (const d of diags) {
      const p = parseVariableDiagnostic(locIdx, d);
      const key = `${p.locName.toLowerCase()}\0${p.varName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ varName: p.varName, locName: p.locName, prefixes: p.prefixes });
    }
    return result;
  }

  // ── Same-location local: mixed prefix within one location ──

  it('detects mixed prefix for local variable in same location', () => {
    const diags = findMixedPrefixDiags(`# main
local z = 34
$z = 'hello'
---
`);
    const zDiags = diags.filter(d => d.varName.toLowerCase() === 'z');
    expect(zDiags.length).toBeGreaterThan(0);
    expect(zDiags[0].prefixes).toEqual(['#', '$']);
  });

  // ── Direct propagation: A defines local, B uses with different prefix ──

  it('detects mixed prefix when callee uses propagated local with different prefix', () => {
    const diags = findMixedPrefixDiags(`# main
local x = 5
gs 'helper'
---
# helper
pl $x
---
`);
    // helper uses $x but main defines x (no prefix) — mixed
    const helperDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'helper');
    expect(helperDiags.length).toBeGreaterThan(0);
    expect(helperDiags[0].prefixes).toContain('#');
    expect(helperDiags[0].prefixes).toContain('$');
  });

  // ── Transitive propagation: A→B→C, C uses with different prefix ──

  it('detects mixed prefix through transitive propagation (A→B→C)', () => {
    const diags = findMixedPrefixDiags(`# A
local x = 10
gs 'B'
---
# B
gs 'C'
---
# C
pl $x
---
`);
    // x propagates A→B→C; C uses $x, A defines x (no prefix) — mixed
    const cDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'C');
    expect(cDiags.length).toBeGreaterThan(0);
    expect(cDiags[0].prefixes).toContain('#');
    expect(cDiags[0].prefixes).toContain('$');
  });

  // ── No false positive when prefixes match ──

  it('no mixed prefix when callee uses same prefix as caller', () => {
    const diags = findMixedPrefixDiags(`# main
local x = 5
gs 'helper'
---
# helper
pl x
---
`);
    const helperDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'helper');
    expect(helperDiags).toHaveLength(0);
  });

  it('no mixed prefix in transitive chain when all use same prefix', () => {
    const diags = findMixedPrefixDiags(`# A
local $x = 'hi'
gs 'B'
---
# B
gs 'C'
---
# C
pl $x
---
`);
    const cDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'C');
    expect(cDiags).toHaveLength(0);
  });

  it('does NOT cross-flag two unrelated local-x chains using different prefixes', () => {
    // Two distinct `local x` chains in unrelated locations:
    //   loc1 uses x as a number (no prefix), loc2 uses $x.
    // The locations do not call each other, so the chains are
    // disjoint — neither location should warn about mixed prefixes.
    const diags = findMixedPrefixDiags(`# loc1
local x = 5
pl x
---
# loc2
local $x = 'hi'
pl $x
---
`);
    expect(diags.filter(d => d.varName.toLowerCase() === 'x')).toHaveLength(0);
  });

  it('flags a single local-x chain when reads and the binding disagree', () => {
    const diags = findMixedPrefixDiags(`# loc1
local x = 5
pl $x
---
`);
    const d = diags.filter(d => d.varName.toLowerCase() === 'x');
    expect(d.length).toBeGreaterThan(0);
    expect(d[0].prefixes).toContain('#');
    expect(d[0].prefixes).toContain('$');
  });

  // ── Transitive via func/@ ──

  it('detects mixed prefix through transitive func calls (A→B→C)', () => {
    const diags = findMixedPrefixDiags(`# A
local x = 10
y = func('B')
---
# B
y = func('C')
---
# C
pl $x
---
`);
    const cDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'C');
    expect(cDiags.length).toBeGreaterThan(0);
    expect(cDiags[0].prefixes).toContain('#');
    expect(cDiags[0].prefixes).toContain('$');
  });

  it('detects mixed prefix through transitive @ calls (A→B→C)', () => {
    const diags = findMixedPrefixDiags(`# A
local x = 10
@B
---
# B
@C
---
# C
pl $x
---
`);
    const cDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'C');
    expect(cDiags.length).toBeGreaterThan(0);
    expect(cDiags[0].prefixes).toContain('#');
    expect(cDiags[0].prefixes).toContain('$');
  });

  // ── Intermediate does NOT redefine — propagation continues ──

  it('intermediate location without redefinition passes through', () => {
    const diags = findMixedPrefixDiags(`# A
local x = 10
gs 'B'
---
# B
pl x
gs 'C'
---
# C
pl $x
---
`);
    // B uses x (no prefix), C uses $x — both get mixed prefix from A's definition
    const cDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'C');
    expect(cDiags.length).toBeGreaterThan(0);
  });

  // ── goto does NOT propagate locals ──

  it('no mixed prefix via goto (locals not propagated)', () => {
    const diags = findMixedPrefixDiags(`# main
local x = 5
goto 'helper'
---
# helper
pl $x
---
`);
    // goto doesn't propagate locals, so no cross-location prefix mixing
    const helperDiags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'helper');
    expect(helperDiags).toHaveLength(0);
  });

  // ── Provider adds prefix not in global set ──

  it('detects mixed prefix when provider local adds a third prefix beyond globals', () => {
    // loc2 reads both x and $x (global mixed: (none), $)
    // caller provides local #x — provider adds # which isn't in the global set
    // The diagnostic at loc2 should show all three prefixes
    const diags = findMixedPrefixDiags(`# caller
local x = 5
x = #x
gs 'loc2'
---
# loc2
pl x
pl $x
---
`);
    const loc2Diags = diags.filter(d => d.varName.toLowerCase() === 'x' && d.locName === 'loc2');
    expect(loc2Diags.length).toBeGreaterThan(0);
    // Should include the provider's # prefix along with the global (none) and $
    expect(loc2Diags[0].prefixes).toContain('#');
    expect(loc2Diags[0].prefixes).toContain('#');
    expect(loc2Diags[0].prefixes).toContain('$');
  });

  // ── Same-location local inside dyneval inherits scope ──

  it('detects mixed prefix for local used with different prefix inside dyneval', () => {
    const diags = findMixedPrefixDiags(`# main
local z = 34
dyneval({
  $z = 'hello'
})
---
`);
    const zDiags = diags.filter(d => d.varName.toLowerCase() === 'z');
    expect(zDiags.length).toBeGreaterThan(0);
    expect(zDiags[0].prefixes).toEqual(['#', '$']);
  });

  // ── Severity / disabled-flag checks ─────────────────────────────

  it('diagnostic severity is Information', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\npl $x\n---\n`, { mixedVariablePrefixes: true }),
      'mixed type prefixes',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.severity === DiagnosticSeverity.Information)).toBe(true);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\npl $x\n---\n`, { mixedVariablePrefixes: true }),
      'mixed type prefixes',
    );
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('disabled flag produces no diagnostics even with mixed prefixes', () => {
    const diags = runDiagnostics(parser, `# main\nx = 1\npl $x\n---\n`, { mixedVariablePrefixes: false });
    expect(diagnosticsMatching(diags, 'mixed type prefixes')).toHaveLength(0);
  });

  it('no warning when only one prefix is used (negative)', () => {
    const diags = findMixedPrefixDiags(`# main\n$x = 'hi'\npl $x\n---\n`);
    expect(diags.filter(d => d.varName.toLowerCase() === 'x')).toHaveLength(0);
  });

  it('emits one diagnostic per reference (not per variable)', () => {
    // Two references to `x` with two prefixes → 2 diags (one per ref)
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# main\nx = 1\npl $x\n---\n`, { mixedVariablePrefixes: true }),
      'mixed type prefixes',
    );
    expect(diags.length).toBeGreaterThanOrEqual(2);
  });

  it('no warning for built-in variable with mixed usage', () => {
    // args is a built-in — should be exempt from mixed-prefix warnings
    const diags = findMixedPrefixDiags(`# main\n$args[0] = 'a'\npl args[0]\n---\n`);
    expect(diags.filter(d => d.varName.toLowerCase() === 'args')).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Multi-file "go to location" — project-wide symbol aggregation
// ──────────────────────────────────────────────────────────────────────

describe('variable rename scoping', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Simulates the rename handler logic:
   * Given code, a location name, and a variable name at a specific line/col,
   * returns the set of { locName, line } refs that would be renamed.
   *
   * `cursorLocName` is the location the cursor is in.
   * `cursorVarName` is the base name (no prefix).
   * `cursorLine` / `cursorCol` identify which reference to resolve from.
   */
  function collectRenameRefs(
    code: string,
    cursorLocName: string,
    cursorVarName: string,
    cursorLine: number,
    cursorCol: number,
  ): { locName: string; line: number }[] {
    const tree = parser.parse('test://rename', code)!;
    const { symbols } = extractSymbols(tree, 'test://rename');

    // Find the exact variable symbol at cursor
    const locSyms = symbols.getLocation(cursorLocName);
    if (!locSyms) return [];
    const exactSym = locSyms.findVariableAtPosition(cursorVarName.toLowerCase(), cursorLine, cursorCol);
    if (!exactSym) return [];

    // Build propagation data (same as in mixed prefix tests)
    const locIndex = new Map<string, LocationSymbols>();
    const propagationEdges = new Map<string, Set<string>>();
    const initialLocals = new Map<string, { target: string; locals: ReadonlyMap<string, number> }[]>();
    for (const [, ls] of symbols.locations) {
      const key = ls.locationName.toLowerCase();
      locIndex.set(key, ls);
      for (const [, ref] of ls.locationRefs) {
        for (const r of ref.references) {
          if (r.localsInScope) {
            let targets = propagationEdges.get(key);
            if (!targets) { targets = new Set(); propagationEdges.set(key, targets); }
            targets.add(ref.nameLower);
            if (r.localsInScope.size > 0) {
              let edges = initialLocals.get(key);
              if (!edges) { edges = []; initialLocals.set(key, edges); }
              edges.push({ target: ref.nameLower, locals: r.localsInScope });
            }
          }
        }
      }
    }

    const propagatedLocals = new Map<string, Map<string, QspSymbol[]>>();
    const visited = new Set<string>();
    function propagate(targetLoc: string, varName: string, providerSym: QspSymbol, inProgress: Set<string>): void {
      const pairKey = `${targetLoc}\0${varName}`;
      if (inProgress.has(pairKey)) return;
      const targetInfo = locIndex.get(targetLoc);
      if (!targetInfo) { visited.add(pairKey); return; }
      const targetSym = targetInfo.findVariable(varName);
      const targetReadsIt = targetSym && !targetSym.definition && targetSym.references.length > 0;
      if (targetReadsIt) {
        let targetMap = propagatedLocals.get(targetLoc);
        if (!targetMap) { targetMap = new Map(); propagatedLocals.set(targetLoc, targetMap); }
        let providers = targetMap.get(varName);
        if (!providers) { providers = []; targetMap.set(varName, providers); }
        if (!providers.includes(providerSym)) providers.push(providerSym);
      }
      if (visited.has(pairKey)) return;
      inProgress.add(pairKey);
      if (targetSym?.definition) { visited.add(pairKey); inProgress.delete(pairKey); return; }
      const targetEdges = propagationEdges.get(targetLoc);
      if (targetEdges) {
        for (const t of targetEdges) propagate(t, varName, providerSym, inProgress);
      }
      visited.add(pairKey);
      inProgress.delete(pairKey);
    }
    for (const [callerLoc, edges] of initialLocals) {
      const callerInfo = locIndex.get(callerLoc);
      if (!callerInfo) continue;
      for (const edge of edges) {
        for (const [varName, scopeId] of edge.locals) {
          const localKey = `local\0${scopeId}\0${varName}`;
          const localSym = callerInfo.variables.get(localKey);
          if (localSym?.definition) propagate(edge.target, varName, localSym, new Set());
        }
      }
    }

    // Now simulate the rename handler logic
    const refs: { locName: string; line: number }[] = [];
    const addRefs = (sym: QspSymbol, locName: string) => {
      for (const r of sym.references) refs.push({ locName, line: r.line });
    };

    if (exactSym.isLocal) {
      // LOCAL: include declaring location refs + propagated callee refs
      addRefs(exactSym, cursorLocName);
      if (exactSym.definition) {
        for (const [targetLoc, targetVars] of propagatedLocals) {
          const providers = targetVars.get(exactSym.nameLower);
          if (!providers?.some(p => p === exactSym)) continue;
          for (const [, ls] of symbols.locations) {
            if (ls.locationName.toLowerCase() !== targetLoc) continue;
            const tSym = ls.findVariable(exactSym.nameLower);
            if (tSym) addRefs(tSym, ls.locationName);
          }
        }
      }
    } else if (!exactSym.definition) {
      // Non-local, no definition — check if propagated
      const locKey = cursorLocName.toLowerCase();
      const providers = propagatedLocals.get(locKey)?.get(exactSym.nameLower);
      if (providers && providers.length > 0) {
        // Propagated: rename source local + all propagated refs
        for (const p of providers) {
          addRefs(p, p.locationName ?? cursorLocName);
          for (const [tLoc, tVars] of propagatedLocals) {
            const tProviders = tVars.get(p.nameLower);
            if (!tProviders?.some(tp => tp === p)) continue;
            for (const [, ls] of symbols.locations) {
              if (ls.locationName.toLowerCase() !== tLoc) continue;
              const tSym = ls.findVariable(p.nameLower);
              if (tSym) addRefs(tSym, ls.locationName);
            }
          }
        }
      } else {
        // Global: rename all non-local refs
        for (const [, ls] of symbols.locations) {
          for (const sym of ls.findAllVariables(cursorVarName.toLowerCase())) {
            if (sym.isLocal) continue;
            addRefs(sym, ls.locationName);
          }
        }
      }
    } else {
      // Global with definition: rename all non-local refs
      for (const [, ls] of symbols.locations) {
        for (const sym of ls.findAllVariables(cursorVarName.toLowerCase())) {
          if (sym.isLocal) continue;
          addRefs(sym, ls.locationName);
        }
      }
    }

    return refs;
  }

  it('renaming a local variable includes all refs in declaring location', () => {
    //        0123456789
    // line0: # main
    // line1: local x = 5
    // line2: pl x
    const refs = collectRenameRefs(`# main\nlocal x = 5\npl x\n---\n`, 'main', 'x', 1, 6);
    expect(refs).toHaveLength(2);
    expect(refs.every(r => r.locName === 'main')).toBe(true);
  });

  it('renaming a local variable includes propagated refs in callee', () => {
    // line0: # caller
    // line1: local x = 5
    // line2: gs 'helper'
    // line3: ---
    // line4: # helper
    // line5: pl x
    const refs = collectRenameRefs(
      `# caller\nlocal x = 5\ngs 'helper'\n---\n# helper\npl x\n---\n`,
      'caller', 'x', 1, 6,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'caller')).toBeDefined();
    expect(refs.find(r => r.locName === 'helper')).toBeDefined();
  });

  it('renaming from a propagated callee renames source local + all propagated', () => {
    // Cursor on propagated `x` in helper (line 5, col 3)
    const refs = collectRenameRefs(
      `# caller\nlocal x = 5\ngs 'helper'\n---\n# helper\npl x\n---\n`,
      'helper', 'x', 5, 3,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'caller')).toBeDefined();
    expect(refs.find(r => r.locName === 'helper')).toBeDefined();
  });

  it('renaming a global variable does NOT include local variables', () => {
    // line0: # loc1
    // line1: local x = 10
    // line2: ---
    // line3: # loc2
    // line4: x = 99
    // Cursor on global x in loc2 (line 4, col 0)
    const refs = collectRenameRefs(
      `# loc1\nlocal x = 10\n---\n# loc2\nx = 99\n---\n`,
      'loc2', 'x', 4, 0,
    );
    // Should only include loc2's global x, NOT loc1's local x
    expect(refs).toHaveLength(1);
    expect(refs[0].locName).toBe('loc2');
  });

  it('renaming global variable includes all non-local refs across locations', () => {
    const refs = collectRenameRefs(
      `# loc1\nx = 1\n---\n# loc2\npl x\n---\n`,
      'loc1', 'x', 1, 0,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'loc1')).toBeDefined();
    expect(refs.find(r => r.locName === 'loc2')).toBeDefined();
  });

  it('transitive propagation: renaming local renames through A→B→C', () => {
    const refs = collectRenameRefs(
      `# A\nlocal x = 1\ngs 'B'\n---\n# B\npl x\ngs 'C'\n---\n# C\npl x\n---\n`,
      'A', 'x', 1, 6,
    );
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.locName === 'A')).toBeDefined();
    expect(refs.find(r => r.locName === 'B')).toBeDefined();
    expect(refs.find(r => r.locName === 'C')).toBeDefined();
  });

  it('goto does NOT propagate for rename purposes', () => {
    const refs = collectRenameRefs(
      `# main\nlocal x = 5\ngoto 'helper'\n---\n# helper\npl x\n---\n`,
      'main', 'x', 1, 6,
    );
    // Only the declaring location — goto doesn't propagate locals
    expect(refs).toHaveLength(1);
    expect(refs[0].locName).toBe('main');
  });
});

// =====================================================
// Find All References Scoping Tests
// =====================================================

describe('find all references scoping', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Simulates the onReferences handler logic for variables.
   * Uses the same local/global/propagated resolution as the server.
   * Returns { locName, line } for each reference found.
   */
  function collectFindAllRefs(
    code: string,
    cursorLocName: string,
    cursorVarName: string,
    cursorLine: number,
    cursorCol: number,
  ): { locName: string; line: number }[] {
    const tree = parser.parse('test://refs', code)!;
    const { symbols } = extractSymbols(tree, 'test://refs');

    const locSyms = symbols.getLocation(cursorLocName);
    if (!locSyms) return [];
    const exactSym = locSyms.findVariableAtPosition(cursorVarName.toLowerCase(), cursorLine, cursorCol);
    if (!exactSym) return [];

    // Build propagation data
    const locIndex = new Map<string, LocationSymbols>();
    const propagationEdges = new Map<string, Set<string>>();
    const initialLocals = new Map<string, { target: string; locals: ReadonlyMap<string, number> }[]>();
    for (const [, ls] of symbols.locations) {
      const key = ls.locationName.toLowerCase();
      locIndex.set(key, ls);
      for (const [, ref] of ls.locationRefs) {
        for (const r of ref.references) {
          if (r.localsInScope) {
            let targets = propagationEdges.get(key);
            if (!targets) { targets = new Set(); propagationEdges.set(key, targets); }
            targets.add(ref.nameLower);
            if (r.localsInScope.size > 0) {
              let edges = initialLocals.get(key);
              if (!edges) { edges = []; initialLocals.set(key, edges); }
              edges.push({ target: ref.nameLower, locals: r.localsInScope });
            }
          }
        }
      }
    }

    const propagatedLocals = new Map<string, Map<string, QspSymbol[]>>();
    const visited = new Set<string>();
    function propagate(targetLoc: string, varName: string, providerSym: QspSymbol, inProgress: Set<string>): void {
      const pairKey = `${targetLoc}\0${varName}`;
      if (inProgress.has(pairKey)) return;
      const targetInfo = locIndex.get(targetLoc);
      if (!targetInfo) { visited.add(pairKey); return; }
      const targetSym = targetInfo.findVariable(varName);
      const targetReadsIt = targetSym && !targetSym.definition && targetSym.references.length > 0;
      if (targetReadsIt) {
        let targetMap = propagatedLocals.get(targetLoc);
        if (!targetMap) { targetMap = new Map(); propagatedLocals.set(targetLoc, targetMap); }
        let providers = targetMap.get(varName);
        if (!providers) { providers = []; targetMap.set(varName, providers); }
        if (!providers.includes(providerSym)) providers.push(providerSym);
      }
      if (visited.has(pairKey)) return;
      inProgress.add(pairKey);
      if (targetSym?.definition) { visited.add(pairKey); inProgress.delete(pairKey); return; }
      const targetEdges = propagationEdges.get(targetLoc);
      if (targetEdges) {
        for (const t of targetEdges) propagate(t, varName, providerSym, inProgress);
      }
      visited.add(pairKey);
      inProgress.delete(pairKey);
    }
    for (const [callerLoc, edges] of initialLocals) {
      const callerInfo = locIndex.get(callerLoc);
      if (!callerInfo) continue;
      for (const edge of edges) {
        for (const [varName, scopeId] of edge.locals) {
          const localKey = `local\0${scopeId}\0${varName}`;
          const localSym = callerInfo.variables.get(localKey);
          if (localSym?.definition) propagate(edge.target, varName, localSym, new Set());
        }
      }
    }

    // Simulate the onReferences handler logic (mirrors server code)
    const refs: { locName: string; line: number }[] = [];
    const addRefs = (sym: QspSymbol, locName: string) => {
      for (const r of sym.references) refs.push({ locName, line: r.line });
    };

    if (exactSym.isLocal) {
      addRefs(exactSym, cursorLocName);
      if (exactSym.definition) {
        for (const [targetLoc, targetVars] of propagatedLocals) {
          const providers = targetVars.get(exactSym.nameLower);
          if (!providers?.some(p => p === exactSym)) continue;
          for (const [, ls] of symbols.locations) {
            if (ls.locationName.toLowerCase() !== targetLoc) continue;
            const tSym = ls.findVariable(exactSym.nameLower);
            if (tSym) addRefs(tSym, ls.locationName);
          }
        }
      }
    } else if (!exactSym.definition) {
      const locKey = cursorLocName.toLowerCase();
      const providers = propagatedLocals.get(locKey)?.get(exactSym.nameLower);
      if (providers && providers.length > 0) {
        for (const p of providers) {
          addRefs(p, p.locationName ?? cursorLocName);
          for (const [tLoc, tVars] of propagatedLocals) {
            const tProviders = tVars.get(p.nameLower);
            if (!tProviders?.some(tp => tp === p)) continue;
            for (const [, ls] of symbols.locations) {
              if (ls.locationName.toLowerCase() !== tLoc) continue;
              const tSym = ls.findVariable(p.nameLower);
              if (tSym) addRefs(tSym, ls.locationName);
            }
          }
        }
      } else {
        for (const [, ls] of symbols.locations) {
          for (const sym of ls.findAllVariables(cursorVarName.toLowerCase())) {
            if (sym.isLocal) continue;
            addRefs(sym, ls.locationName);
          }
        }
      }
    } else {
      for (const [, ls] of symbols.locations) {
        for (const sym of ls.findAllVariables(cursorVarName.toLowerCase())) {
          if (sym.isLocal) continue;
          addRefs(sym, ls.locationName);
        }
      }
    }

    return refs;
  }

  it('find refs on local variable includes all refs in declaring location', () => {
    const refs = collectFindAllRefs(`# main\nlocal x = 5\npl x\n---\n`, 'main', 'x', 1, 6);
    expect(refs).toHaveLength(2);
    expect(refs.every(r => r.locName === 'main')).toBe(true);
  });

  it('find refs on local variable includes propagated refs in callee', () => {
    const refs = collectFindAllRefs(
      `# caller\nlocal x = 5\ngs 'helper'\n---\n# helper\npl x\n---\n`,
      'caller', 'x', 1, 6,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'caller')).toBeDefined();
    expect(refs.find(r => r.locName === 'helper')).toBeDefined();
  });

  it('find refs from propagated callee includes source local + all propagated', () => {
    // Cursor on propagated `x` in helper (line 5, col 3)
    const refs = collectFindAllRefs(
      `# caller\nlocal x = 5\ngs 'helper'\n---\n# helper\npl x\n---\n`,
      'helper', 'x', 5, 3,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'caller')).toBeDefined();
    expect(refs.find(r => r.locName === 'helper')).toBeDefined();
  });

  it('find refs on global variable does NOT include local variables', () => {
    const refs = collectFindAllRefs(
      `# loc1\nlocal x = 10\n---\n# loc2\nx = 99\n---\n`,
      'loc2', 'x', 4, 0,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].locName).toBe('loc2');
  });

  it('find refs on global variable includes all non-local refs across locations', () => {
    const refs = collectFindAllRefs(
      `# loc1\nx = 1\n---\n# loc2\npl x\n---\n`,
      'loc1', 'x', 1, 0,
    );
    expect(refs).toHaveLength(2);
    expect(refs.find(r => r.locName === 'loc1')).toBeDefined();
    expect(refs.find(r => r.locName === 'loc2')).toBeDefined();
  });

  it('transitive propagation: find refs on local includes A→B→C', () => {
    const refs = collectFindAllRefs(
      `# A\nlocal x = 1\ngs 'B'\n---\n# B\npl x\ngs 'C'\n---\n# C\npl x\n---\n`,
      'A', 'x', 1, 6,
    );
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.locName === 'A')).toBeDefined();
    expect(refs.find(r => r.locName === 'B')).toBeDefined();
    expect(refs.find(r => r.locName === 'C')).toBeDefined();
  });

  it('find refs from middle of chain (B) traces back to source', () => {
    // Cursor on propagated `x` in B (line 5, col 3)
    const refs = collectFindAllRefs(
      `# A\nlocal x = 1\ngs 'B'\n---\n# B\npl x\ngs 'C'\n---\n# C\npl x\n---\n`,
      'B', 'x', 5, 3,
    );
    expect(refs).toHaveLength(3);
    expect(refs.find(r => r.locName === 'A')).toBeDefined();
    expect(refs.find(r => r.locName === 'B')).toBeDefined();
    expect(refs.find(r => r.locName === 'C')).toBeDefined();
  });

  it('goto does NOT propagate for find refs', () => {
    const refs = collectFindAllRefs(
      `# main\nlocal x = 5\ngoto 'helper'\n---\n# helper\npl x\n---\n`,
      'main', 'x', 1, 6,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].locName).toBe('main');
  });
});

// =====================================================
// Inconsistent Local Propagation Diagnostic Tests
// =====================================================

describe('inconsistent local propagation diagnostic', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Simulates the inconsistentLocalPropagation diagnostic.
   * Returns { varName, targetLoc, propagatingCallers, nonPropagatingCallers }
   * for each variable that has inconsistent propagation.
   */
  function findInconsistentPropagation(code: string): {
    varName: string;
    targetLoc: string;
    nonPropagatingCallers: string[];
  }[] {
    const locIdx = buildLocationIndex(code);
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    const seen = new Set<string>();
    const results: { varName: string; targetLoc: string; nonPropagatingCallers: string[] }[] = [];
    const re = /^Variable '([^']+)' is propagated as local from [^—]+ but not from (.+?) —/;
    for (const d of diags) {
      const p = parseVariableDiagnostic(locIdx, d);
      const m = re.exec(d.message);
      if (!m) continue;
      const key = `${p.locName.toLowerCase()}\0${m[1].toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Extract caller names from groups like "caller2 line 6" or
      // "caller2 lines 6, 8".  We match `<name> line(s)` and dedupe.
      const withoutList = [...new Set(
        [...m[2].matchAll(/([^,\s][^,]*?)\s+lines?\s+\d/g)].map(g => g[1].trim()),
      )];
      results.push({ varName: m[1], targetLoc: p.locName.toLowerCase(), nonPropagatingCallers: withoutList });
    }
    return results;
  }

  it('warns when some callers propagate local and others do not', () => {
    const diags = findInconsistentPropagation(`# caller1
local x = 5
gs 'helper'
---
# caller2
gs 'helper'
---
# helper
pl x
---
`);
    expect(diags).toHaveLength(1);
    expect(diags[0].varName).toBe('x');
    expect(diags[0].targetLoc).toBe('helper');
    expect(diags[0].nonPropagatingCallers).toContain('caller2');
  });

  it('no warning when ALL callers propagate the local', () => {
    const diags = findInconsistentPropagation(`# caller1
local x = 5
gs 'helper'
---
# caller2
local x = 10
gs 'helper'
---
# helper
pl x
---
`);
    expect(diags).toHaveLength(0);
  });

  it('no warning when NO callers propagate the variable (pure global)', () => {
    const diags = findInconsistentPropagation(`# caller1
gs 'helper'
---
# caller2
gs 'helper'
---
# helper
pl x
---
`);
    expect(diags).toHaveLength(0);
  });

  it('transitive: warns when indirect caller does not propagate', () => {
    // A has local x and calls B. B calls C. D calls C without local x.
    // C gets x propagated from A (via B) but not from D.
    const diags = findInconsistentPropagation(`# A
local x = 1
gs 'B'
---
# B
pl x
gs 'C'
---
# C
pl x
---
# D
gs 'C'
---
`);
    const cDiags = diags.filter(d => d.targetLoc === 'c');
    expect(cDiags).toHaveLength(1);
    expect(cDiags[0].varName).toBe('x');
    expect(cDiags[0].nonPropagatingCallers).toContain('D');
  });

  it('transitive: no warning when transitive caller passes through', () => {
    // A has local x, calls B. B passes through (reads x, calls C). C reads x.
    // No other caller of C exists.
    const diags = findInconsistentPropagation(`# A
local x = 1
gs 'B'
---
# B
pl x
gs 'C'
---
# C
pl x
---
`);
    const cDiags = diags.filter(d => d.targetLoc === 'c');
    expect(cDiags).toHaveLength(0);
  });

  it('still warns when callee writes (not shadows) variable: write is a mutation of caller local', () => {
    // helper writes `x = 99` — under gs semantics this is a mutation of
    // caller1's local, not a new global. So propagation still applies
    // and caller2's missing propagation is inconsistent.
    const diags = findInconsistentPropagation(`# caller1
local x = 5
gs 'helper'
---
# caller2
gs 'helper'
---
# helper
x = 99
---
`);
    const xDiags = diags.filter(d => d.varName === 'x' && d.targetLoc === 'helper');
    expect(xDiags).toHaveLength(1);
    expect(xDiags[0].nonPropagatingCallers).toContain('caller2');
  });

  it('no warning when callee shadows with LOCAL declaration', () => {
    // helper explicitly declares `local x` — this shadows propagation.
    const diags = findInconsistentPropagation(`# caller1
local x = 5
gs 'helper'
---
# caller2
gs 'helper'
---
# helper
local x = 99
---
`);
    expect(diags.filter(d => d.varName === 'x' && d.targetLoc === 'helper')).toHaveLength(0);
  });

  it('warns for multiple variables independently', () => {
    const diags = findInconsistentPropagation(`# caller1
local x = 1
local y = 2
gs 'helper'
---
# caller2
local x = 3
gs 'helper'
---
# helper
pl x
pl y
---
`);
    // x is propagated by both → no warning
    // y is propagated only by caller1 → warning
    const yDiags = diags.filter(d => d.varName === 'y');
    expect(yDiags).toHaveLength(1);
    expect(yDiags[0].nonPropagatingCallers).toContain('caller2');
    const xDiags = diags.filter(d => d.varName === 'x');
    expect(xDiags).toHaveLength(0);
  });

  // ── Severity / disabled-flag / edge-case checks ─────────────────

  it('diagnostic severity is Warning', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# a\nlocal x = 1\ngs 'h'\n---\n# b\ngs 'h'\n---\n# h\npl x\n---\n`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every(d => d.severity === DiagnosticSeverity.Warning)).toBe(true);
  });

  it('diagnostic source is "qsp"', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# a\nlocal x = 1\ngs 'h'\n---\n# b\ngs 'h'\n---\n# h\npl x\n---\n`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.every(d => d.source === 'qsp')).toBe(true);
  });

  it('disabled flag produces no diagnostics', () => {
    const diags = runDiagnostics(parser,
      `# a\nlocal x = 1\ngs 'h'\n---\n# b\ngs 'h'\n---\n# h\npl x\n---\n`,
      { inconsistentLocalPropagation: false });
    expect(diagnosticsMatching(diags, 'propagated as local')).toHaveLength(0);
  });

  it('message lists all non-propagating callers in single diagnostic', () => {
    // Three callers, only one propagates → two listed as non-propagating
    const code = `# a
local x = 1
gs 'h'
---
# b
gs 'h'
---
# c
gs 'h'
---
# h
pl x
---
`;
    const diags = diagnosticsMatching(
      runDiagnostics(parser, code, { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    // Each diagnostic message should list both b and c
    const msg = diags[0].message;
    expect(msg).toContain('b');
    expect(msg).toContain('c');
  });

  it('emits one diagnostic per reference to the propagated variable', () => {
    // helper reads x twice → two diagnostics (one per ref)
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# a\nlocal x = 1\ngs 'h'\n---\n# b\ngs 'h'\n---\n# h\npl x\npl x\n---\n`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBe(2);
  });

  it('no warning when helper is never called (no callers at all)', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser, `# h\npl x\n---\n`, { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags).toHaveLength(0);
  });

  it('goto caller does NOT count as a propagating caller', () => {
    // caller1 uses `gs` with local x; caller2 uses `goto` — goto doesn't propagate.
    // But goto doesn't propagate locals at all, so caller2 isn't in the "propagating callers" set.
    // Only `gs` callers are considered. So caller2's goto → shouldn't create inconsistency warning.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# a\nlocal x = 1\ngs 'h'\n---\n# b\ngoto 'h'\n---\n# h\npl x\n---\n`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    // Only gs callers in the set → a is the only caller, propagates → no inconsistency
    expect(diags).toHaveLength(0);
  });

  // ── Per-call (intra-caller) inconsistency ───────────────────────

  it('warns when one caller has both propagating and non-propagating call sites', () => {
    // alpha calls `helper` from two different lexical scopes:
    // inside an `act` body (where `local x` is declared and visible)
    // and at top-level (where x is NOT in scope, since `act` bodies
    // are isolated stored scopes).  Per-call classification must
    // detect this even though it's a single caller.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
act 'go':
    local x = 1
    gs 'helper'
end
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    const msg = diags[0].message;
    // Both groups should mention `alpha` with specific line numbers
    expect(msg).toMatch(/from alpha line 4/);
    expect(msg).toMatch(/but not from alpha line 6/);
  });

  it('does NOT warn when both call sites in the same caller propagate', () => {
    // Two calls at top-level — both share scope 0 with `local x`.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'helper'
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags).toHaveLength(0);
  });

  // ── Caller-side `local` no longer blocks propagation ────────────

  it("caller's own `local` declaration does NOT classify the call as non-propagating", () => {
    // beta receives x from alpha and declares its own `local x` (a
    // shadow of the propagated value).  Under per-call semantics the
    // shadow is irrelevant: x is still propagated to gamma — just with
    // a different value.  So beta's call to gamma is propagating.
    // Inconsistency arises only because of delta, which doesn't pass
    // x at all.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'beta'
---
# beta
local x = 99
gs 'gamma'
---
# delta
gs 'gamma'
---
# gamma
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    const msg = diags[0].message;
    // beta must be on the propagating side (because of `local x = 99`
    // visible at the call site), and only delta on the non-propagating side.
    expect(msg).toMatch(/from beta line \d+/);
    expect(msg).toMatch(/but not from delta line \d+/);
    expect(msg).not.toMatch(/but not from beta/);
  });

  // ── Message formatting: line numbers ────────────────────────────

  it('message lists each caller with line numbers (single line)', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'helper'
---
# beta
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toMatch(/from alpha line 3/);
    expect(diags[0].message).toMatch(/but not from beta line 6/);
  });

  it('message groups multiple call sites per caller as `lines A, B`', () => {
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'helper'
gs 'helper'
---
# beta
gs 'helper'
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toMatch(/from alpha lines 3, 4/);
    expect(diags[0].message).toMatch(/but not from beta lines 7, 8/);
  });

  it('lines in message are sorted numerically even if calls appear out of order', () => {
    // Three call sites in alpha at lines 4, 6, 9 — message must list
    // them as "lines 4, 6, 9", not in source-traversal order if that
    // happened to differ.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'helper'

gs 'helper'

x = x + 1

gs 'helper'
---
# beta
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toMatch(/from alpha lines 3, 5, 9/);
  });

  // ── xgt/xgoto with reads ────────────────────────────────────────

  it('xgt caller is filtered out and does not create inconsistency', () => {
    // alpha gs's helper (propagating x).  beta xgt's helper.
    // xgt is not in PROPAGATING_CALL_TYPES, so beta's call is not
    // considered at all — only alpha is in the site set, and it
    // propagates.  No warning.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
gs 'helper'
---
# beta
xgt 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags).toHaveLength(0);
  });

  // ── @@ user-call form ───────────────────────────────────────────

  it('@@ user-call participates as a propagating call (gosub-like)', () => {
    // alpha invokes helper via @@ (gosub-style user call) with x in
    // scope; beta calls helper without x.  @@ must be classified as
    // propagating, producing an inconsistency.
    const diags = diagnosticsMatching(
      runDiagnostics(parser,
        `# alpha
local x = 1
@@helper
---
# beta
gs 'helper'
---
# helper
pl x
---
`,
        { inconsistentLocalPropagation: true }),
      'propagated as local',
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].message).toMatch(/from alpha line 3/);
    expect(diags[0].message).toMatch(/but not from beta line 6/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Go-to-definition for variables
// ────────────────────────────────────────────────────────────────────

describe('variable go-to-definition', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  /**
   * Simulates the go-to-definition handler logic for variables.
   * Returns definition locations as { locName, line } or null.
   */
  function collectGoToDef(
    code: string,
    cursorLocName: string,
    cursorVarName: string,
    cursorLine: number,
    cursorCol: number,
  ): { locName: string; line: number }[] {
    const tree = parser.parse('test://gotoDef', code)!;
    const { symbols } = extractSymbols(tree, 'test://gotoDef');

    const locSyms = symbols.getLocation(cursorLocName);
    if (!locSyms) return [];
    const varSym = locSyms.findVariableAtPosition(cursorVarName.toLowerCase(), cursorLine, cursorCol);
    if (!varSym) return [];

    // If variable has a definition in this location, return it
    if (varSym.definition) {
      return [{ locName: cursorLocName, line: varSym.definition.line }];
    }

    // No local definition — check propagated locals (same logic as server)
    const locIndex = new Map<string, LocationSymbols>();
    const propagationEdges = new Map<string, Set<string>>();
    const initialLocals = new Map<string, { target: string; locals: ReadonlyMap<string, number> }[]>();
    for (const [, ls] of symbols.locations) {
      const key = ls.locationName.toLowerCase();
      locIndex.set(key, ls);
      for (const [, ref] of ls.locationRefs) {
        for (const r of ref.references) {
          if (r.localsInScope) {
            let targets = propagationEdges.get(key);
            if (!targets) { targets = new Set(); propagationEdges.set(key, targets); }
            targets.add(ref.nameLower);
            if (r.localsInScope.size > 0) {
              let edges = initialLocals.get(key);
              if (!edges) { edges = []; initialLocals.set(key, edges); }
              edges.push({ target: ref.nameLower, locals: r.localsInScope });
            }
          }
        }
      }
    }

    const propagatedLocals = new Map<string, Map<string, { sym: QspSymbol; locName: string }[]>>();
    const visited = new Set<string>();
    function propagate(targetLoc: string, varName: string, providerSym: QspSymbol, providerLocName: string, inProgress: Set<string>): void {
      const pairKey = `${targetLoc}\0${varName}`;
      if (inProgress.has(pairKey)) return;
      const targetInfo = locIndex.get(targetLoc);
      if (!targetInfo) { visited.add(pairKey); return; }
      const targetSym = targetInfo.findVariable(varName);
      const targetReadsIt = targetSym && !targetSym.definition && targetSym.references.length > 0;
      if (targetReadsIt) {
        let targetMap = propagatedLocals.get(targetLoc);
        if (!targetMap) { targetMap = new Map(); propagatedLocals.set(targetLoc, targetMap); }
        let providers = targetMap.get(varName);
        if (!providers) { providers = []; targetMap.set(varName, providers); }
        if (!providers.some(p => p.sym === providerSym)) providers.push({ sym: providerSym, locName: providerLocName });
      }
      if (visited.has(pairKey)) return;
      inProgress.add(pairKey);
      if (targetSym?.definition) { visited.add(pairKey); inProgress.delete(pairKey); return; }
      const targetEdges = propagationEdges.get(targetLoc);
      if (targetEdges) {
        for (const t of targetEdges) propagate(t, varName, providerSym, providerLocName, inProgress);
      }
      visited.add(pairKey);
      inProgress.delete(pairKey);
    }
    for (const [callerLoc, edges] of initialLocals) {
      const callerInfo = locIndex.get(callerLoc);
      if (!callerInfo) continue;
      for (const edge of edges) {
        for (const [varName, scopeId] of edge.locals) {
          const localKey = `local\0${scopeId}\0${varName}`;
          const localSym = callerInfo.variables.get(localKey);
          if (localSym?.definition) propagate(edge.target, varName, localSym, callerInfo.locationName, new Set());
        }
      }
    }

    // Check propagated locals
    const locKey = cursorLocName.toLowerCase();
    const providers = propagatedLocals.get(locKey)?.get(varSym.nameLower);
    if (providers && providers.length > 0) {
      return providers
        .filter(p => p.sym.definition)
        .map(p => ({ locName: p.locName, line: p.sym.definition!.line }));
    }

    // Global variable — search all locations for definitions (THE BUG FIX)
    if (!varSym.isLocal) {
      const defs: { locName: string; line: number }[] = [];
      for (const [, ls] of symbols.locations) {
        const otherVar = ls.variables.get(varSym.nameLower);
        if (otherVar?.definition) {
          defs.push({ locName: ls.locationName, line: otherVar.definition.line });
        }
      }
      return defs;
    }

    return [];
  }

  it('go-to-def for local variable finds definition in same location', () => {
    const defs = collectGoToDef(`# main\nlocal x = 5\npl x\n---\n`, 'main', 'x', 2, 3);
    expect(defs).toEqual([{ locName: 'main', line: 1 }]);
  });

  it('go-to-def for global variable finds definition in same location', () => {
    const defs = collectGoToDef(`# main\nx = 5\npl x\n---\n`, 'main', 'x', 2, 3);
    expect(defs).toEqual([{ locName: 'main', line: 1 }]);
  });

  it('go-to-def for global variable finds definition in another location', () => {
    const defs = collectGoToDef(`# init\nx = 42\n---\n# main\npl x\n---\n`, 'main', 'x', 4, 3);
    expect(defs).toEqual([{ locName: 'init', line: 1 }]);
  });

  it('go-to-def for global variable finds multiple definitions across locations', () => {
    const defs = collectGoToDef(`# init\nx = 1\n---\n# setup\nx = 2\n---\n# main\npl x\n---\n`, 'main', 'x', 7, 3);
    expect(defs).toHaveLength(2);
    expect(defs).toContainEqual({ locName: 'init', line: 1 });
    expect(defs).toContainEqual({ locName: 'setup', line: 4 });
  });

  it('go-to-def for propagated local jumps to provider definition', () => {
    const defs = collectGoToDef(`# caller\nlocal x = 10\ngs 'helper'\n---\n# helper\npl x\n---\n`, 'helper', 'x', 5, 3);
    expect(defs).toEqual([{ locName: 'caller', line: 1 }]);
  });

  it('go-to-def for propagated local with multiple providers returns all', () => {
    const defs = collectGoToDef(`# a\nlocal x = 1\ngs 'target'\n---\n# b\nlocal x = 2\ngs 'target'\n---\n# target\npl x\n---\n`, 'target', 'x', 9, 3);
    expect(defs).toHaveLength(2);
    expect(defs).toContainEqual({ locName: 'a', line: 1 });
    expect(defs).toContainEqual({ locName: 'b', line: 5 });
  });
});

// ────────────────────────────────────────────────────────────────────
// Duplicate LOCAL declarations in the same scope
// ────────────────────────────────────────────────────────────────────

describe('duplicate local declarations in same scope', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  it('second LOCAL declaration does not create a new symbol — same QspSymbol is reused', () => {
    const tree = parser.parse('test://dup', `# main
local x = 1
pl x
local x = 2
pl x
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://dup');
    const locSyms = symbols.getLocation('main')!;

    // All refs for 'x' should be on the same symbol
    const allVars = locSyms.findAllVariables('x');
    expect(allVars).toHaveLength(1);

    const sym = allVars[0];
    expect(sym.isLocal).toBe(true);
    // First definition wins (line 1)
    expect(sym.definition!.line).toBe(1);
    // 4 references: definition, read, second declaration, second read
    expect(sym.references).toHaveLength(4);
  });

  it('go-to-def on a read after the second LOCAL goes to the first definition', () => {
    //        0123456789
    // line0: # main
    // line1: local x = 1
    // line2: pl x
    // line3: local x = 2
    // line4: pl x
    const tree = parser.parse('test://dup', `# main
local x = 1
pl x
local x = 2
pl x
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://dup');
    const locSyms = symbols.getLocation('main')!;
    const sym = locSyms.findVariableAtPosition('x', 4, 3);
    expect(sym).toBeDefined();
    expect(sym!.definition!.line).toBe(1); // first definition
  });

  it('rename captures all references including both LOCAL declarations', () => {
    // Use the collectRenameRefs helper from the rename tests
    const tree = parser.parse('test://dup', `# main
local x = 1
pl x
local x = 2
pl x
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://dup');
    const locSyms = symbols.getLocation('main')!;
    const sym = locSyms.findVariableAtPosition('x', 4, 3);
    expect(sym).toBeDefined();
    expect(sym!.references).toHaveLength(4);
    // All refs should have the same symbol, so rename would catch all 4
    const lines = sym!.references.map(r => r.line);
    expect(lines).toEqual([1, 2, 3, 4]);
  });

  it('duplicate LOCAL declarations with no reads expose no proper-usage references', () => {
    // Structural sanity: when both `local x = N` lines are the only
    // refs, none of them is a proper-usage read.  The unused-variable
    // diagnostic relies on this property to flag the symbol.
    const tree = parser.parse('test://dup', `# main
local x = 1
local x = 2
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://dup');
    const locSyms = symbols.getLocation('main')!;
    const sym = locSyms.findAllVariables('x')[0];
    expect(sym.isLocal).toBe(true);
    expect(sym.definition!.line).toBe(1);
    // Both references are definitions — no actual read exists
    const hasRead = sym.references.some(ref => !ref.isDefinition);
    expect(hasRead).toBe(false);
  });

  it('propagation works correctly with duplicate LOCAL declarations', () => {
    const tree = parser.parse('test://dup', `# caller
local x = 1
local x = 2
gs 'helper'
---
# helper
pl x
---
`)!;
    const { symbols } = extractSymbols(tree, 'test://dup');
    const callerSyms = symbols.getLocation('caller')!;
    const helperSyms = symbols.getLocation('helper')!;

    // caller should have exactly one local x
    const callerVars = callerSyms.findAllVariables('x');
    expect(callerVars).toHaveLength(1);
    expect(callerVars[0].isLocal).toBe(true);
    expect(callerVars[0].definition!.line).toBe(1);

    // helper reads x — should see it (no local definition there)
    const helperVar = helperSyms.findVariable('x');
    expect(helperVar).toBeDefined();
    expect(helperVar!.definition).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Jump / label document highlight
// ──────────────────────────────────────────────────────────────────────

