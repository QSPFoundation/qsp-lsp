/**
 * Diagnostic tests for labels, actions, and objects.
 *
 * All tests drive the real `computeDiagnostics` through the shared
 * `runDiagnostics` fixture (see testHelpers.ts).  Each describe block
 * exercises exactly one `DiagnosticSettings` branch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { QspTreeSitterParser } from '../src/parser/treeSitter';
import { WASM_PATH, runDiagnostics, diagnosticsMatching } from './testHelpers';

// ──────────────────────────────────────────────────────────────────────
// Unresolved label refs
// ──────────────────────────────────────────────────────────────────────

describe('unresolved label reference detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unresolvedLabelRefs: true }),
      'is not defined in location',
    );

  it('detects jump to non-existent label', () => {
    const diags = run(`# main\njump 'missing'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing'");
    expect(diags[0].message).toContain("'main'");
  });

  it('no warning when label exists', () => {
    expect(run(`# main\n:loop\npl 'tick'\njump 'loop'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive matching', () => {
    expect(run(`# main\n:MyLabel\njump 'MYLABEL'\n---\n`)).toHaveLength(0);
  });

  it('labels are location-scoped (label in other location does not resolve)', () => {
    const diags = run(`# loc1\njump 'target'\n---\n# loc2\n:target\npl 'ok'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'loc1'");
  });

  it('no warning when label is in same location', () => {
    expect(run(`# loc1\n:start\njump 'start'\n---\n# loc2\n:other\npl 'ok'\n---\n`)).toHaveLength(0);
  });

  it('detects multiple unresolved label refs', () => {
    expect(run(`# main\njump 'a'\njump 'b'\n---\n`)).toHaveLength(2);
  });

  it('diagnostic severity is Warning', () => {
    expect(run(`# main\njump 'x'\n---\n`)[0].severity).toBe(2);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\njump 'x'\n---\n`),
      'is not defined in location',
    )).toHaveLength(0);
  });

  it('jump from inside an act cannot reach a label outside', () => {
    const diags = run(
      `# main\n:outside\nact 'go':\n  jump 'outside'\nend\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'outside'");
  });

  it('jump from outside an act cannot reach a label inside', () => {
    const diags = run(
      `# main\nact 'go':\n  :inside\nend\njump 'inside'\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'inside'");
  });

  it('jump and label inside the same act resolve cleanly', () => {
    expect(run(
      `# main\nact 'loop':\n  :tick\n  jump 'tick'\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('jump from inside a code block cannot reach a label outside', () => {
    const diags = run(
      `# main\n:outside\n$code = {\n  jump 'outside'\n}\ndynamic $code\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'outside'");
  });

  it('label in one act cannot be reached from another act', () => {
    const diags = run(
      `# main\nact 'a':\n  :foo\nend\nact 'b':\n  jump 'foo'\nend\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'foo'");
  });

  // ── Inline act ──────────────────────────────────────────────────

  it('inline act isolates labels from outer scope (label outside, jump inside)', () => {
    const diags = run(
      `# main\n:foo\nact 'go': jump 'foo' & end\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'foo'");
  });

  it('label inside an inline act is not registered — jump cannot find it', () => {
    // In real QSP a label is only recognized when it begins a line.
    // `:foo` inside the inline act is therefore never a real label.
    const diags = run(
      `# main\nact 'go': :foo & end\njump 'foo'\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'foo'");
  });

  // ── Outer → block (entering an isolated namespace) ──────────────

  it('jump from outside a stored code block cannot reach a label inside', () => {
    const diags = run(
      `# main\n$code = {\n  :inside\n}\ndynamic $code\njump 'inside'\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'inside'");
  });

  it('jump from outside a dynamic code block cannot reach a label inside', () => {
    const diags = run(
      `# main\ndynamic {\n  :inside\n}\njump 'inside'\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'inside'");
  });

  // ── Positive resolution inside isolated namespaces ──────────────

  it('jump and label inside the same stored code block resolve cleanly', () => {
    expect(run(
      `# main\n$code = {\n  :loop\n  jump 'loop'\n}\ndynamic $code\n---\n`,
    )).toHaveLength(0);
  });

  it('jump and label inside the same dynamic code block resolve cleanly', () => {
    expect(run(
      `# main\ndynamic {\n  :loop\n  jump 'loop'\n}\n---\n`,
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Duplicate labels
// ──────────────────────────────────────────────────────────────────────

describe('duplicate label detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { duplicateLabels: true }),
      'Duplicate label',
    );

  it('flags all occurrences of a duplicate label in the same location', () => {
    const diags = run(`# main\n:loop\npl 'a'\n:loop\npl 'b'\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes("'loop'"))).toBe(true);
    expect(diags.map(d => d.range.start.line).sort()).toEqual([1, 3]);
  });

  it('no warning for unique labels', () => {
    expect(run(`# main\n:first\npl 'a'\n:second\npl 'b'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive detection — flags all occurrences', () => {
    expect(run(`# main\n:MyLabel\npl 'a'\n:MYLABEL\npl 'b'\n---\n`)).toHaveLength(2);
  });

  it('same label name in different locations is not a duplicate', () => {
    expect(run(`# loc1\n:start\npl 'a'\n---\n# loc2\n:start\npl 'b'\n---\n`)).toHaveLength(0);
  });

  it('three duplicates → three diagnostics', () => {
    // Need a reference so :loop is entered into labels (definitions created
    // from references); label duplicate requires multiple definitions of same name.
    expect(run(`# main\n:a\n:b\n:a\n:b\n:a\n---\n`)).toHaveLength(5);
  });

  it('same label in different acts is NOT a duplicate (scope-aware)', () => {
    expect(run(
      `# main\nact 'one':\n:loop\npl 'a'\nend\nact 'two':\n:loop\npl 'b'\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in same act IS a duplicate — flags all occurrences', () => {
    expect(run(
      `# main\nact 'one':\n:loop\npl 'a'\n:loop\npl 'b'\nend\n---\n`,
    )).toHaveLength(2);
  });

  it('top-level and inside-act same name is NOT a duplicate', () => {
    expect(run(
      `# main\n:start\npl 'top'\nact 'go':\n:start\npl 'inside'\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in different code blocks is NOT a duplicate', () => {
    expect(run(
      `# main\nif 1:\n{\n:loop\npl 'a'\n}\nend\nif 2:\n{\n:loop\npl 'b'\n}\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in same code block IS a duplicate — flags all occurrences', () => {
    expect(run(
      `# main\nif 1:\n{\n:loop\npl 'a'\n:loop\npl 'b'\n}\nend\n---\n`,
    )).toHaveLength(2);
  });

  it('top-level and inside code-block same name is NOT a duplicate', () => {
    expect(run(
      `# main\n:start\nif 1:\n{\n:start\npl 'x'\n}\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('diagnostic severity is Warning', () => {
    expect(run(`# main\n:loop\n:loop\n---\n`)[0].severity).toBe(2);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\n:loop\n:loop\n---\n`),
      'Duplicate label',
    )).toHaveLength(0);
  });

  // ── Same-namespace duplicates across nested non-isolated scopes ──

  it('top-level label collides with one in a nested if-branch (same root)', () => {
    // Both `:foo`s share the location root: a `jump 'foo'` at top level
    // would have an ambiguous target.
    const diags = run(
      `# main\n:foo\nif 1:\n  :foo\nend\n---\n`,
    );
    expect(diags).toHaveLength(2);
  });

  it('label in nested loop collides with top-level label (same root)', () => {
    const diags = run(
      `# main\n:tick\nloop i = 1 while i < 2 step i = i + 1:\n  :tick\nend\n---\n`,
    );
    expect(diags).toHaveLength(2);
  });

  // ── Distinct namespaces remain non-colliding ────────────────────

  it('label inside nested code blocks (each its own root) does not collide', () => {
    // Two separate stored code-blocks bound to distinct vars: each
    // block opens its own isolated label namespace.
    expect(run(
      `# main\n$a = {\n:foo\n}\n$b = {\n:foo\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('act-internal sub-scopes share the act\'s root (collide)', () => {
    const diags = run(
      `# main\nact 'go':\n  :foo\n  if 1:\n    :foo\n  end\nend\n---\n`,
    );
    expect(diags).toHaveLength(2);
  });

  it('code-block-internal sub-scopes share the block\'s root (collide)', () => {
    const diags = run(
      `# main\n$code = {\n  :foo\n  if 1:\n    :foo\n  end\n}\n---\n`,
    );
    expect(diags).toHaveLength(2);
  });

  // ── Nested isolated scopes ──────────────────────────────────────

  it('nested act-in-act: inner act opens its own namespace', () => {
    // Outer act has `:foo`; inner act inside it also has `:foo`.
    // Each act is its own isolated scope, so they don't collide.
    expect(run(
      `# main\nact 'outer':\n  :foo\n  act 'inner':\n    :foo\n  end\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('code-block inside an act opens a separate label namespace', () => {
    expect(run(
      `# main\nact 'go':\n  :foo\n  $cb = {\n    :foo\n  }\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('act inside a stored code-block opens a separate label namespace', () => {
    expect(run(
      `# main\n$cb = {\n  :foo\n  act 'inner':\n    :foo\n  end\n}\n---\n`,
    )).toHaveLength(0);
  });

  // ── Dynamic block label namespace ───────────────────────────────

  it('same label in same dynamic block IS a duplicate — flags all occurrences', () => {
    expect(run(
      `# main\ndynamic {\n  :loop\n  pl 'a'\n  :loop\n  pl 'b'\n}\n---\n`,
    )).toHaveLength(2);
  });

  it('same label in two distinct dynamic blocks is NOT a duplicate', () => {
    expect(run(
      `# main\ndynamic {\n  :loop\n}\ndynamic {\n  :loop\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in a stored block and a sibling dynamic block is NOT a duplicate', () => {
    expect(run(
      `# main\n$cb = {\n  :foo\n}\ndynamic {\n  :foo\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('same label at location root and inside a dynamic block is NOT a duplicate', () => {
    expect(run(
      `# main\n:start\ndynamic {\n  :start\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('label inside an inline act is dropped — does not collide with same-named outer label', () => {
    // Inline-act `:foo` is never extracted (not at line start), so it
    // cannot collide with the outer `:foo` either way.
    expect(run(
      `# main\n:foo\nact 'go': :foo & end\n---\n`,
    )).toHaveLength(0);
  });

  // ── Cross-kind nested namespace non-collisions ──────────────────

  it('same label in stored block and a dynamic block nested inside it is NOT a duplicate', () => {
    expect(run(
      `# main\n$cb = {\n  :foo\n  dynamic {\n    :foo\n  }\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in dynamic block and a stored block nested inside it is NOT a duplicate', () => {
    expect(run(
      `# main\ndynamic {\n  :foo\n  $cb = {\n    :foo\n  }\n}\n---\n`,
    )).toHaveLength(0);
  });

  it('label in act_block does not collide with a same-named (dropped) inline-act label nested inside it', () => {
    // Inline-act `:foo` is dropped (not at line start), so it can never
    // collide with the surrounding act_block label.
    expect(run(
      `# main\nact 'outer':\n  :foo\n  act 'inner': :foo & end\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('same label inside deferred block and at location root is NOT a duplicate', () => {
    expect(run(
      `# main\n:foo\n$code = {\n  :foo\n}\ndynamic $code\n---\n`,
    )).toHaveLength(0);
  });

  it('same label in two distinct deferred blocks is NOT a duplicate', () => {
    expect(run(
      `# main\n$a = {\n  :foo\n}\ndynamic $a\n$b = {\n  :foo\n}\ndynamic $b\n---\n`,
    )).toHaveLength(0);
  });

  it('duplicate label inside the same deferred block IS still flagged', () => {
    expect(run(
      `# main\n$code = {\n  :foo\n  :foo\n}\ndynamic $code\n---\n`,
    )).toHaveLength(2);
  });

  it('duplicate label inside an act nested in a deferred block IS still flagged', () => {
    expect(run(
      `# main\n$code = {\n  act 'inner':\n    :foo\n    :foo\n  end\n}\ndynamic $code\n---\n`,
    )).toHaveLength(2);
  });

  it('three-level nesting (act > stored > act) keeps each level isolated', () => {
    expect(run(
      `# main\nact 'a':\n  :foo\n  $cb = {\n    :foo\n    act 'c':\n      :foo\n    end\n  }\nend\n---\n`,
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Cross-namespace jump resolution
// ──────────────────────────────────────────────────────────────────────

describe('unresolved label refs across nested isolated scopes', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unresolvedLabelRefs: true }),
      'is not defined in location',
    );

  it('jump in inner act cannot reach outer-act label', () => {
    expect(run(
      `# main\nact 'outer':\n  :foo\n  act 'inner':\n    jump 'foo'\n  end\nend\n---\n`,
    )).toHaveLength(1);
  });

  it('jump in outer act cannot reach inner-act label', () => {
    expect(run(
      `# main\nact 'outer':\n  act 'inner':\n    :foo\n  end\n  jump 'foo'\nend\n---\n`,
    )).toHaveLength(1);
  });

  it('jump in code-block inside act cannot reach act-level label', () => {
    expect(run(
      `# main\nact 'go':\n  :foo\n  $cb = {\n    jump 'foo'\n  }\nend\n---\n`,
    )).toHaveLength(1);
  });

  it('jump in dynamic code-block cannot reach outer label', () => {
    // `dynamic { … }` is label-isolated just like a stored code block:
    // labels and jumps inside it cannot cross the block boundary.
    expect(run(
      `# main\n:foo\ndynamic {\n  jump 'foo'\n}\n---\n`,
    )).toHaveLength(1);
  });

  // ── Deeper / cross-kind nesting ─────────────────────────────────

  it('jump inside dynamic-block-in-stored-block cannot reach stored-block label', () => {
    expect(run(
      `# main\n$cb = {\n  :foo\n  dynamic {\n    jump 'foo'\n  }\n}\n---\n`,
    )).toHaveLength(1);
  });

  it('jump inside stored-block-in-dynamic-block cannot reach dynamic-block label', () => {
    expect(run(
      `# main\ndynamic {\n  :foo\n  $cb = {\n    jump 'foo'\n  }\n}\n---\n`,
    )).toHaveLength(1);
  });

  it('jump inside inline act inside act_block cannot reach outer act label', () => {
    expect(run(
      `# main\nact 'outer':\n  :foo\n  act 'inner': jump 'foo' & end\nend\n---\n`,
    )).toHaveLength(1);
  });

  it('jump inside deferred (var-mediated) block cannot reach caller-side label', () => {
    // Deferred walker (var-mediated `dynamic $code`) opens its own
    // outer namespace; a jump inside it cannot reach a label outside.
    expect(run(
      `# main\n:outer\n$code = {\n  jump 'outer'\n}\ndynamic $code\n---\n`,
    )).toHaveLength(1);
  });

  it('jump inside act nested in deferred block cannot reach deferred-block label', () => {
    expect(run(
      `# main\n$code = {\n  :foo\n  act 'inner':\n    jump 'foo'\n  end\n}\ndynamic $code\n---\n`,
    )).toHaveLength(1);
  });

  // ── Three-level nesting still resolves correctly ────────────────

  it('jump and label inside the same innermost scope (3 levels deep) resolve cleanly', () => {
    expect(run(
      `# main\nact 'outer':\n  $cb = {\n    act 'inner':\n      :foo\n      jump 'foo'\n    end\n  }\nend\n---\n`,
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Duplicate actions
// ──────────────────────────────────────────────────────────────────────

describe('duplicate action detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { duplicateActions: true }),
      'Duplicate action',
    );

  it('flags all occurrences of duplicate act in same location', () => {
    const diags = run(`# main\nact 'Go north': pl 'north' & end\nact 'Go north': pl 'again' & end\n---\n`);
    expect(diags).toHaveLength(2);
    expect(diags.every(d => d.message.includes("'Go north'"))).toBe(true);
  });

  it('no warning for unique actions', () => {
    expect(run(`# main\nact 'Go north': pl 'n' & end\nact 'Go south': pl 's' & end\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive detection — flags all occurrences', () => {
    expect(run(`# main\nact 'Attack': pl 'a' & end\nact 'ATTACK': pl 'b' & end\n---\n`)).toHaveLength(2);
  });

  it('same action name in different locations is NOT a duplicate', () => {
    expect(run(`# loc1\nact 'Talk': pl 'a' & end\n---\n# loc2\nact 'Talk': pl 'b' & end\n---\n`)).toHaveLength(0);
  });

  it('multiple duplicate sets — each group fully flagged', () => {
    const diags = run(`# main\nact 'X': end\nact 'Y': end\nact 'X': end\nact 'Y': end\nact 'X': end\n---\n`);
    expect(diags).toHaveLength(5); // X×3 + Y×2
    const names = diags.map(d => {
      const m = d.message.match(/'([^']+)'/);
      return m ? m[1] : '';
    });
    expect(names.filter(n => n === 'X')).toHaveLength(3);
    expect(names.filter(n => n === 'Y')).toHaveLength(2);
  });

  it('flags duplicate block act too', () => {
    expect(run(`# main\nact 'Open':\n  pl 'opened'\nend\nact 'Open':\n  pl 'again'\nend\n---\n`)).toHaveLength(2);
  });

  it('diagnostic severity is Information', () => {
    expect(run(`# main\nact 'X': end\nact 'X': end\n---\n`)[0].severity).toBe(3);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\nact 'X': end\nact 'X': end\n---\n`),
      'Duplicate action',
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unresolved action refs
// ──────────────────────────────────────────────────────────────────────

describe('unresolved action reference detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unresolvedActionRefs: true }),
      'is referenced but never defined',
    );

  it('detects delact for non-existent action', () => {
    const diags = run(`# main\ndelact 'missing'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing'");
  });

  it('no warning when action is defined', () => {
    expect(run(`# main\nact 'Go': pl 'ok' & end\ndelact 'Go'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive matching', () => {
    expect(run(`# main\nact 'Attack': end\ndelact 'ATTACK'\n---\n`)).toHaveLength(0);
  });

  it('cross-location: action defined in another location resolves', () => {
    expect(run(`# loc1\nact 'Go': end\n---\n# loc2\ndelact 'Go'\n---\n`)).toHaveLength(0);
  });

  it('detects del act (spaced) for non-existent action', () => {
    const diags = run(`# main\ndel act 'ghost'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'ghost'");
  });

  it('detects multiple unresolved action refs', () => {
    expect(run(`# main\ndelact 'a'\ndelact 'b'\n---\n`)).toHaveLength(2);
  });

  it('skips delact with <<>> interpolation — dynamic name', () => {
    expect(run(`# main\ndelact '<<$act_name>>'\n---\n`)).toHaveLength(0);
  });

  it('still detects static action refs alongside dynamic ones', () => {
    const diags = run(`# main\ndelact 'missing'\ndelact '<<$x>>'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'missing'");
  });

  it('diagnostic severity is Warning', () => {
    expect(run(`# main\ndelact 'ghost'\n---\n`)[0].severity).toBe(2);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\ndelact 'ghost'\n---\n`),
      'is referenced but never defined',
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unresolved object refs
// ──────────────────────────────────────────────────────────────────────

describe('unresolved object reference detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unresolvedObjectRefs: true }),
      'is referenced but never added',
    );

  it('detects delobj for non-existent object', () => {
    const diags = run(`# main\ndelobj 'Sword'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'Sword'");
  });

  it('no warning when object is added', () => {
    expect(run(`# main\naddobj 'Sword'\ndelobj 'Sword'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive matching', () => {
    expect(run(`# main\nadd obj 'Key'\ndel obj 'KEY'\n---\n`)).toHaveLength(0);
  });

  it('cross-location: addobj in another location resolves', () => {
    expect(run(`# loc1\naddobj 'Shield'\n---\n# loc2\ndelobj 'Shield'\n---\n`)).toHaveLength(0);
  });

  it('no warning for addobj itself', () => {
    expect(run(`# main\naddobj 'Potion'\n---\n`)).toHaveLength(0);
  });

  it('detects modobj for non-existent object', () => {
    const diags = run(`# main\nmodobj 'Ghost'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'Ghost'");
  });

  it('detects multiple unresolved object refs', () => {
    expect(run(`# main\ndelobj 'a'\ndelobj 'b'\n---\n`)).toHaveLength(2);
  });

  it('skips delobj with <<>> interpolation — dynamic name', () => {
    expect(run(`# main\ndelobj '<<$obj_name>>'\n---\n`)).toHaveLength(0);
  });

  it('skips addobj with <<>> interpolation', () => {
    expect(run(`# main\naddobj '<<$item>>'\n---\n`)).toHaveLength(0);
  });

  it('diagnostic severity is Warning', () => {
    expect(run(`# main\ndelobj 'Ghost'\n---\n`)[0].severity).toBe(2);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\ndelobj 'Ghost'\n---\n`),
      'is referenced but never added',
    )).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unused labels
// ──────────────────────────────────────────────────────────────────────

describe('unused label detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unusedLabels: true }),
      'never targeted by jump',
    );

  it('detects unused label', () => {
    const diags = run(`# main\n:orphan\npl 'hi'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'orphan'");
  });

  it('no warning when label is targeted by jump', () => {
    expect(run(`# main\n:loop\npl 'hi'\njump 'loop'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive matching', () => {
    expect(run(`# main\n:MyLabel\njump 'MYLABEL'\n---\n`)).toHaveLength(0);
  });

  it('labels are location-scoped: jump in another location does not count', () => {
    const diags = run(`# loc1\n:target\npl 'a'\n---\n# loc2\njump 'target'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'loc1'");
  });

  it('detects multiple unused labels', () => {
    expect(run(`# main\n:a\n:b\njump 'c'\n:c\npl 'hi'\n---\n`)).toHaveLength(2);
  });

  it('no warning when all labels are used', () => {
    expect(run(`# main\n:start\njump 'start'\n---\n`)).toHaveLength(0);
  });

  it('diagnostic severity is Information', () => {
    expect(run(`# main\n:orphan\n---\n`)[0].severity).toBe(3);
  });

  it('diagnostic is tagged Unnecessary', () => {
    expect(run(`# main\n:orphan\n---\n`)[0].tags).toContain(1);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\n:orphan\n---\n`),
      'never targeted by jump',
    )).toHaveLength(0);
  });

  it('label inside an act with no jump is unused', () => {
    expect(run(
      `# main\nact 'a':\n  :inner\nend\n---\n`,
    )).toHaveLength(1);
  });

  it('label inside an act with a jump in the same act is used', () => {
    expect(run(
      `# main\nact 'a':\n  :inner\n  jump 'inner'\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('top-level label is unused when only an act-internal jump exists', () => {
    // Outer `:retry` is unreachable from inside the act; the act's
    // jump cannot escape its isolated label namespace.
    const diags = run(
      `# main\n:retry\nact 'a':\n  jump 'retry'\nend\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'retry'");
  });

  it('act-internal label and top-level label of same name are both used independently', () => {
    expect(run(
      `# main\n:foo\njump 'foo'\nact 'a':\n  :foo\n  jump 'foo'\nend\n---\n`,
    )).toHaveLength(0);
  });

  it('only the unjumped definition of a re-used name is reported as unused', () => {
    // :foo at top level has a jump; :foo inside the act does NOT.
    const diags = run(
      `# main\n:foo\njump 'foo'\nact 'a':\n  :foo\nend\n---\n`,
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'foo'");
    // The act-internal definition is on the line `  :foo` (line 4, 0-indexed)
    expect(diags[0].range.start.line).toBe(4);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Unused objects
// ──────────────────────────────────────────────────────────────────────

describe('unused object detection (real computeDiagnostics)', () => {
  const parser = new QspTreeSitterParser();
  beforeAll(async () => { await parser.init(async () => fs.readFileSync(WASM_PATH)); });

  const run = (code: string) =>
    diagnosticsMatching(
      runDiagnostics(parser, code, { unusedObjects: true }),
      'is added but never referenced',
    );

  it('detects addobj with no references', () => {
    const diags = run(`# main\naddobj 'Sword'\n---\n`);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("'Sword'");
  });

  it('no warning when object is referenced by delobj', () => {
    expect(run(`# main\naddobj 'Sword'\ndelobj 'Sword'\n---\n`)).toHaveLength(0);
  });

  it('no warning when object is referenced by obj operator', () => {
    expect(run(`# main\naddobj 'Key'\nif obj 'Key': pl 'have it'\n---\n`)).toHaveLength(0);
  });

  it('cross-location: reference in another location counts', () => {
    expect(run(`# loc1\naddobj 'Shield'\n---\n# loc2\ndelobj 'Shield'\n---\n`)).toHaveLength(0);
  });

  it('case-insensitive matching', () => {
    expect(run(`# main\naddobj 'Potion'\ndelobj 'POTION'\n---\n`)).toHaveLength(0);
  });

  it('detects multiple unused objects', () => {
    expect(run(`# main\naddobj 'a'\naddobj 'b'\ndelobj 'c'\n---\n`)).toHaveLength(2);
  });

  it('no warning when referenced by modobj', () => {
    expect(run(`# main\naddobj 'Ring'\nmodobj 'Ring', 'Magic Ring'\n---\n`)).toHaveLength(0);
  });

  it('diagnostic severity is Information', () => {
    expect(run(`# main\naddobj 'X'\n---\n`)[0].severity).toBe(3);
  });

  it('diagnostic is tagged Unnecessary', () => {
    expect(run(`# main\naddobj 'X'\n---\n`)[0].tags).toContain(1);
  });

  it('disabled check produces no diagnostics', () => {
    expect(diagnosticsMatching(
      runDiagnostics(parser, `# main\naddobj 'X'\n---\n`),
      'is added but never referenced',
    )).toHaveLength(0);
  });
});
