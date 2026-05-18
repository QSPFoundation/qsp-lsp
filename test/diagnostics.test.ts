/**
 * Tests for variable-related diagnostics focused on propagated-local
 * correctness across reads AND writes in callees.
 *
 * Covered diagnostics:
 *   - unusedVariables
 *   - uninitializedVariables
 *   - mixedVariablePrefixes
 *   - inconsistentLocalPropagation
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticTag } from 'vscode-languageserver';
import { QspTreeSitterParser, extractSymbols } from '../src/parser/treeSitter';
import { buildLocationIndex } from '../src/common/locations';
import { computeDiagnostics, type DiagnosticSettings } from '../src/server/diagnostics';
import { WASM_PATH } from './testHelpers';

const ALL_OFF: DiagnosticSettings = {
  duplicateLocations: false,
  duplicateLabels: false,
  duplicateActions: false,
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

describe('diagnostics: propagated locals (reads & writes)', () => {
  const parser = new QspTreeSitterParser();

  beforeAll(async () => {
    await parser.init(async () => fs.readFileSync(WASM_PATH));
  });

  function run(code: string, overrides: Partial<DiagnosticSettings>) {
    const uri = 'test://diag';
    const doc = TextDocument.create(uri, 'qsp', 1, code);
    const tree = parser.parse(uri, code)!;
    const { symbols } = extractSymbols(tree, uri);
    const locationIndex = buildLocationIndex(code);
    const settings = { ...ALL_OFF, ...overrides };
    return computeDiagnostics(doc, uri, locationIndex, settings, parser, new Map(), symbols);
  }

  // ── unusedVariables ──────────────────────────────────────────────
  describe('unusedVariables', () => {
    it('does not flag a write to a propagated-in local', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
pl x
---
# b
x = 2
---
`,
        { unusedVariables: true },
      );
      const msgs = diags.map(d => d.message);
      expect(msgs).not.toContain("Variable 'x' is assigned but never read");
    });

    it('still flags a truly unused global write', () => {
      const diags = run(
        `# a
y = 99
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'y' is assigned but never read")).toBe(true);
    });

    it('does NOT flag top-level write when same-name `local` lives only in inline-if scope', () => {
      // Regression: the parser scopes `local x` inside `if 1: ...` to
      // the inline scope; the top-level `x = 99` and `pl x` resolve to
      // the non-local symbol.  The proper read at `pl x` must keep
      // the non-local write out of the unused diagnostic.
      const diags = run(
        `# a
if 1: local x = 5
x = 99
pl x
---
`,
        { unusedVariables: true },
      );
      // Top-level `x = 99` is on line 2 (0-indexed) — the non-local
      // write must NOT be flagged unused, because `pl x` reads it.
      const topLevelWriteFlagged = diags.some(
        d => d.message === "Variable 'x' is assigned but never read"
          && d.range.start.line === 2,
      );
      expect(topLevelWriteFlagged).toBe(false);
    });

    it('does NOT flag top-level write when same-name `local` lives only in multiline-if scope', () => {
      const diags = run(
        `# a
if 1:
  local x = 5
end
x = 99
pl x
---
`,
        { unusedVariables: true },
      );
      const topLevelWriteFlagged = diags.some(
        d => d.message === "Variable 'x' is assigned but never read"
          && d.range.start.line === 4,
      );
      expect(topLevelWriteFlagged).toBe(false);
    });

    it('does NOT flag top-level write when same-name `local` lives only in else-branch', () => {
      const diags = run(
        `# a
if 0:
  pl 'never'
else
  local x = 1
end
x = 99
pl x
---
`,
        { unusedVariables: true },
      );
      const topLevelWriteFlagged = diags.some(
        d => d.message === "Variable 'x' is assigned but never read"
          && d.range.start.line === 6,
      );
      expect(topLevelWriteFlagged).toBe(false);
    });

    it('does NOT flag top-level write when same-name `local` lives only inside a stored code block', () => {
      // `local x` is inside a scope-isolating code block — completely
      // unreachable from the location body.  Top-level `x = 1` / `pl x`
      // operate on the non-local symbol; the read must register.
      const diags = run(
        `# a
$code = { local x = 99 }
x = 1
pl x
---
`,
        { unusedVariables: true },
      );
      const topLevelWriteFlagged = diags.some(
        d => d.message === "Variable 'x' is assigned but never read"
          && d.range.start.line === 2,
      );
      expect(topLevelWriteFlagged).toBe(false);
    });

    it('still flags a declared local that is neither read nor propagated', () => {
      const diags = run(
        `# a
local z = 7
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'z' is assigned but never read")).toBe(true);
    });

    it('does not flag a global write when a pure read follows a compound op', () => {
      const diags = run(
        `# a
x = 5
x += 3
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    it('flags a global write when only compound ops follow (compound LHS is not a read)', () => {
      const diags = run(
        `# a
x = 5
x += 3
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('does not flag a local write when a pure read follows a compound op', () => {
      const diags = run(
        `# a
local x = 5
x += 3
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    it('flags a local write when only compound ops follow (compound LHS is not a read)', () => {
      const diags = run(
        `# a
local x = 5
x += 3
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('flags a global write when only a self-ref `=` follows (`x = x + 1` is compound, not a read)', () => {
      // `x = x + 1` is treated as `compoundOp: 'other'` — the LHS is
      // neither a proper read nor a proper write.  The RHS read of `x`
      // IS a proper read though, so `x` is "read" — but only by a
      // compound op that doesn't itself constitute a new definition
      // either.  The original `x = 5` write has no PURE read following,
      // so it stays flagged as unused.
      const diags = run(
        `# a
x = 5
x = x + 1
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
      // (`x` has a proper read on the RHS, so it's NOT unused — the
      // self-ref RHS counts as a real read of the prior value.)
    });

    it('still flags a global write when only killvar follows (no pure read)', () => {
      const diags = run(
        `# a
x = 5
killvar 'x'
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('still flags a global write when killvar is in a different location', () => {
      const diags = run(
        `# a
x = 5
---
# b
killvar 'x'
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('does not flag a global write when killvar precedes a pure read', () => {
      const diags = run(
        `# a
x = 5
killvar 'x'
x = 10
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    // ── globallyRead refinement (propagation-aware) ──────────────────

    it("setvar 'x',N alone does not count as a read of x", () => {
      // setvar is a definition, not a proper-usage read.  A lone
      // setvar of x in another location must not silence the
      // unused-var diagnostic on a plain global write to x.
      const diags = run(
        `# a
qq = 5
---
# b
setvar 'qq', 44
---
`,
        { unusedVariables: true },
      );
      // 'qq' is written in #a and (re)defined via setvar in #b — never
      // read by isProperUsage anywhere → both writes are unused.
      const qqDiags = diags.filter(d => d.message === "Variable 'qq' is assigned but never read");
      expect(qqDiags.length).toBe(2);
    });

    it('read of x in a callee that receives x as a propagated local does NOT mark global x as used', () => {
      // In #b, x arrives as a propagated local (gs from #a passes
      // local x).  The `pl x` read consumes that local — it does NOT
      // make the unrelated global write `x = 99` in #c "used".
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
pl x
---
# c
x = 99
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('read of x in a location that defines local x does NOT mark global x as used', () => {
      // In #b, `local x = 5` shadows any global; `pl x` reads the
      // local.  This must not silence the unused-var diagnostic on
      // the global write `x = 99` in #c.
      const diags = run(
        `# a
x = 99
---
# b
local x = 5
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(true);
    });

    it('read of x in a location where x is neither propagated-in nor locally defined DOES mark global x as used', () => {
      // #b has a plain global read of x — that's a genuine global
      // usage, so the global write in #a must NOT be flagged.
      const diags = run(
        `# a
x = 99
---
# b
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    it('mix: propagated read in one callee + plain read in another DOES mark global x as used', () => {
      // #b reads x as a propagated local (skipped for globallyRead).
      // #c has a plain global read (counts).  Net result: x IS in
      // globallyRead, so the global write `x = 99` in #d is "used".
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
pl x
---
# c
pl x
---
# d
x = 99
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    it('desc-call propagates locals: callee read suppresses unused for caller local', () => {
      const diags = run(
        `# a
local x = 1
$t = desc('b')
---
# b
pl x
---
`,
        { unusedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
    });

    it('mixed gs + dynamic-block from the same caller: callee sees x via both paths', () => {
      // `local x` is declared once in caller; both `gs 'b'` and the
      // `dynamic { gs 'b' }` should propagate it, so the read in #b is
      // valid and #a's `local x` is not "unused".
      const diags = run(
        `# a
local x = 1
gs 'b'
dynamic {
  gs 'b'
}
---
# b
pl x
---
`,
        { unusedVariables: true, uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is assigned but never read")).toBe(false);
      expect(diags.filter(d => d.message.includes("'x'") && d.message.includes('used but never assigned'))).toEqual([]);
    });

    it('emits exactly one diagnostic when a local is propagated into a deferred dynamic block', () => {
      // Regression: injectLocalIntoScope shares the same QspSymbol under
      // multiple scope keys, so naive iteration over locSyms.variables
      // would emit a duplicate "assigned but never read" diagnostic.
      const diags = run(
        `# main
local o = 8
$spell = {
    pl 'hello'
}
dynamic $spell
---
`,
        { unusedVariables: true },
      );
      const oDiags = diags.filter(d => d.message === "Variable 'o' is assigned but never read");
      expect(oDiags).toHaveLength(1);
    });

    it('emits exactly one diagnostic per local with multiple var-mediated dispatch targets', () => {
      // Two global code-block bindings for $spell make `dynamic $spell`
      // a multi-target dispatch — caller locals are injected into BOTH
      // target blocks.  Without ownedVariables() the unused-warning would
      // multiply with the number of targets.
      const diags = run(
        `# main
local o = 8
if rand(0, 1):
    $spell = {
        pl 'A'
    }
else
    $spell = {
        pl 'B'
    }
end
dynamic $spell
---
`,
        { unusedVariables: true },
      );
      const oDiags = diags.filter(d => d.message === "Variable 'o' is assigned but never read");
      expect(oDiags).toHaveLength(1);
    });
  });

  // ── uninitializedVariables ───────────────────────────────────────
  describe('uninitializedVariables', () => {
    it('does not flag a read of a propagated-in local', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      const msgs = diags.map(d => d.message);
      expect(msgs).not.toContain("Variable 'x' is used but never assigned");
    });

    it('does not flag a read after a write in the callee (propagated)', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
x = 2
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'x'"))).toEqual([]);
    });

    it('still flags a truly uninitialized read', () => {
      const diags = run(
        `# a
pl q
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'q' is used but never assigned")).toBe(true);
    });

    it('flags a compound op on a variable with no prior assignment', () => {
      const diags = run(
        `# a
x += 5
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is used but never assigned")).toBe(true);
    });

    it('does not flag a compound op when the variable was previously assigned', () => {
      const diags = run(
        `# a
x = 5
x += 3
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'x'"))).toEqual([]);
    });

    it('flags every reference after a compound op acts as the only "write" (compound is not a definition)', () => {
      // `hp += 100` is not a definition, so the later `pl hp` is also
      // a read of an uninitialised variable.  Both references warn.
      const diags = run(
        `# a
hp += 100
pl hp
---
`,
        { uninitializedVariables: true },
      );
      const hpWarns = diags.filter(d => d.message === "Variable 'hp' is used but never assigned");
      expect(hpWarns.length).toBeGreaterThanOrEqual(2);
    });

    it('flags a compound op on a bare `local x` declaration (declaration alone is not value-bearing)', () => {
      // `local x` without an initial value declares the slot but does
      // not assign a value; `x += 1` is then a read-then-write of an
      // uninitialised value.
      const diags = run(
        `# a
local x
x += 1
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'x' is used but never assigned")).toBe(true);
    });

    // ── self-referential plain `=` (compound op `'other'`) ─────────
    it('flags `hp = hp + 5` alone as uninitialized (self-ref `=` is compound, not a definition)', () => {
      // `hp = hp + 5` is semantically `hp += 5` — read-then-write of
      // the same slot.  Both the LHS (compound, no chain) and the RHS
      // read see no prior value-bearing binding → uninit warns.
      const diags = run(
        `# a
hp = hp + 5
pl hp
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'hp' is used but never assigned")).toBe(true);
    });

    it('flags `hp = min(hp + 20, 100)` alone as uninitialized (self-ref through nested call)', () => {
      const diags = run(
        `# a
hp = min(hp + 20, 100)
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'hp' is used but never assigned")).toBe(true);
    });

    it('does not flag `hp = hp + 5` when hp was previously assigned', () => {
      const diags = run(
        `# a
hp = 100
hp = hp + 5
pl hp
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'hp'"))).toEqual([]);
    });

    it('does not flag `$s = $s + ".txt"` when $s was previously assigned', () => {
      const diags = run(
        `# a
$s = 'file'
$s = $s + '.txt'
pl $s
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'s'"))).toEqual([]);
    });

    it('flags `hp = hp, 5` alone as uninitialized (multi-RHS self-ref is compound, not a definition)', () => {
      // `hp = hp, 5` is single-LHS plain `=` whose RHS tuple contains
      // `hp` — semantically read-then-write of the same slot, just
      // like `hp += …`.  With no prior assignment, both the LHS and
      // the RHS read see an uninitialized variable.
      const diags = run(
        `# a
hp = hp, 5
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'hp' is used but never assigned")).toBe(true);
    });

    it('does not flag `hp = hp, 5` when hp was previously assigned', () => {
      const diags = run(
        `# a
hp = 100
hp = hp, 5
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("used but never assigned"))).toEqual([]);
    });

    it('detects element-wise self-ref in multi-LHS positional zip (`a, b = a, 1` → a is compound)', () => {
      // Under positional zip, `a, b = a, 1` is `a = a` (self-ref,
      // compound) and `b = 1` (definition).  With no prior assignment
      // of `a`, the self-ref read warns uninit; `b` is fine.
      const diags = run(
        `# a
a, b = a, 1
pl b
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'a' is used but never assigned")).toBe(true);
      expect(diags.filter(d => d.message.includes("'b'"))).toEqual([]);
    });

    it('does not flag `a, b = a, 1` when a was previously assigned', () => {
      const diags = run(
        `# a
a = 10
a, b = a, 1
pl a
pl b
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("used but never assigned"))).toEqual([]);
    });

    it('treats a swap `a, b = b, a` as definitions on both sides (not self-ref under positional zip)', () => {
      // `a, b = b, a` reads outer `b`/`a` and writes them swapped.
      // With no prior assignments, both reads warn uninit, but the
      // LHS positions are normal definitions, not compound ops.
      const diags = run(
        `# a
a = 1
b = 2
a, b = b, a
pl a
pl b
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("used but never assigned"))).toEqual([]);
    });

    it('detects last-LHS tail-absorption self-ref (`a, b = 1, b + 2` → b is compound)', () => {
      // Under positional zip the last LHS absorbs every remaining
      // tail element: here `b` pairs with `b + 2` → self-ref.
      const diags = run(
        `# a
a, b = 1, b + 2
pl a
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'b' is used but never assigned")).toBe(true);
      expect(diags.filter(d => d.message.includes("'a'"))).toEqual([]);
    });

    it('detects tail-absorption self-ref into a `%` LHS (`a, %t = 1, %t, 3` → %t is compound)', () => {
      // `%t` absorbs the tail `(%t, 3)` — a tuple containing `%t`
      // is read-then-written.
      const diags = run(
        `# a
a, %t = 1, %t, 3
pl a
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 't' is used but never assigned")).toBe(true);
    });

    it('detects indexed self-ref (`arr[0] = arr[0] + 1` → compound, flags uninit)', () => {
      // `arr[0] = arr[0] + 1` reads arr (slot 0), adds 1, writes back.
      // The base name `arr` matches between LHS and RHS → compound;
      // with no prior assignment the read warns uninit.
      const diags = run(
        `# a
arr[0] = arr[0] + 1
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.some(d => d.message === "Variable 'arr' is used but never assigned")).toBe(true);
    });

    // ── desc / @@ propagation ──────────────────────────────────────
    it('desc-called location reading a caller local is NOT uninitialized', () => {
      const diags = run(
        `# a
local x = 1
$t = desc('b')
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'x'"))).toEqual([]);
    });

    it('@@-called location reading a caller local is NOT uninitialized', () => {
      const diags = run(
        `# a
local x = 1
@@b
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'x'"))).toEqual([]);
    });

    it('@-called (no-parens) location reading a caller local is NOT uninitialized', () => {
      const diags = run(
        `# a
local x = 1
y = @b
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(diags.filter(d => d.message.includes("'x'"))).toEqual([]);
    });

    it('bare-`local x` (no value) propagated then read in callee IS uninitialized', () => {
      // Caller declares local x with no initializer; callee reads it —
      // there's no value flowing in, so this should warn.
      const diags = run(
        `# a
local x
gs 'b'
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('used but never assigned')),
      ).toBe(true);
    });

    it('xgoto callee read of caller local IS uninitialized (xgoto does not propagate)', () => {
      const diags = run(
        `# a
local x = 1
xgt 'b'
---
# b
pl x
---
`,
        { uninitializedVariables: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('used but never assigned')),
      ).toBe(true);
    });
  });

  // ── missingResultInFunctionCall ──────────────────────────────────
  describe('missingResultInFunctionCall', () => {
    const NEEDLE = "never assigns 'result'";

    it('warns on `y = func("b")` when b never assigns result', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
x = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when target only writes `result` inside a stored code-block (block has its own frame)', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
$code = { result = 42 }
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when target only writes `result` inside an inline `dyneval` arg block', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
dyneval({ result = 42 })
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when target only writes `result` inside an inline `dynamic` arg block', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
dynamic { result = 42 }
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when target writes `result` at top level AND inside a code block', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
result = 1
$code = { result = 99 }
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns on `y = @b` when b never assigns result', () => {
      const diags = run(
        `# a
y = @b
---
# b
x = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when target directly assigns result', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
result = 42
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(false);
    });

    it('does NOT warn when target assigns $result (string prefix)', () => {
      const diags = run(
        `# a
$y = func('b')
---
# b
$result = 'hi'
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(false);
    });

    it('does NOT warn when target compound-assigns result after an initial value-bearing assignment', () => {
      // `result += 1` alone is a read-then-write of an uninitialised
      // value (compound LHS is not a definition); the user must seed
      // result first.  Use a `=` then a `+=` to exercise the case.
      const diags = run(
        `# a
y = func('b')
---
# b
result = 0
result += 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns when target only compound-assigns result (compound LHS is not a definition)', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
result += 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when target only delegates to a callee via gs (gs gets a fresh result)', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
gs 'c'
---
# c
result = 7
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns even when a transitive callee chain writes result (each call has its own result)', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
y = func('c')
---
# c
gs 'd'
---
# d
result = 9
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when only goto-style call from target reaches a writer (goto does not propagate)', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
gt 'c'
---
# c
result = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes("'b'") && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn for gosub/gs calls (only func/@ are checked)', () => {
      const diags = run(
        `# a
gs 'b'
---
# b
x = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns at every func/@ call site referencing the bad target', () => {
      const diags = run(
        `# a
y = func('b')
z = @b
---
# b
x = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.filter(d => d.message.includes("'b'") && d.message.includes(NEEDLE)).length)
        .toBe(2);
    });

    it('does NOT warn when result is assigned via setvar', () => {
      const diags = run(
        `# a
y = func('b')
---
# b
setvar 'result', 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.includes(NEEDLE))).toBe(false);
    });

    // ── dyneval block variant ──────────────────────────────────────
    it('warns when dyneval code block does not assign result', () => {
      const diags = run(
        `# a
y = dyneval({
  x = 1
})
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when dyneval block directly assigns result', () => {
      const diags = run(
        `# a
y = dyneval({
  result = 42
})
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval'))).toBe(false);
    });

    it('warns when dyneval block calls a location that writes result (callee has fresh result)', () => {
      const diags = run(
        `# a
y = dyneval({
  gs 'b'
})
---
# b
result = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when dyneval block calls a location via goto (goto does not propagate result)', () => {
      const diags = run(
        `# a
y = dyneval({
  gt 'b'
})
---
# b
result = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when dyneval block calls @target (func) even if target writes result (func has fresh result)', () => {
      const diags = run(
        `# a
y = dyneval({
  z = @b
})
---
# b
result = 1
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT confuse a result write OUTSIDE the dyneval block with one inside', () => {
      // The surrounding location writes result, but the dyneval block
      // itself doesn't — the block must still warn.
      const diags = run(
        `# a
result = 1
y = dyneval({
  x = 2
})
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    // ── var-mediated dyneval ───────────────────────────────────────
    it('warns when dyneval($code) resolves to a single block that does NOT assign result', () => {
      const diags = run(
        `# a
$code = { x = 1 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when dyneval($code) resolves to a single block that assigns result', () => {
      const diags = run(
        `# a
$code = { result = 42 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval'))).toBe(false);
    });

    it('warns when dyneval($code) resolves to multiple local blocks that all lack result', () => {
      // Two distinct local code-block bindings, neither assigns
      // `result` — universal-AND fires.  The multiple-local-bindings
      // info diag also fires, but the missing-result warning is
      // independent.
      const diags = run(
        `# a
local $code
if 1:
  $code = { x = 1 }
else
  $code = { x = 2 }
end
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when dyneval($code) has multiple local blocks and ANY assigns result', () => {
      // Universal-quantification: at least one candidate writes
      // `result`, so the warning is suppressed (runtime may dispatch
      // to it).
      const diags = run(
        `# a
local $code
if 1:
  $code = { x = 1 }
else
  $code = { result = 42 }
end
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    it('does NOT warn when dyneval($code) is unresolved (no visible binding)', () => {
      const diags = run(
        `# a
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns when dyneval($code) has multiple global assignments that all lack result', () => {
      // Multiple distinct global assignments — the multiple-assignments
      // info diag fires AND the missing-result warning fires too,
      // because no candidate writes `result`.
      const diags = run(
        `# a
$code = { x = 1 }
$code = { x = 2 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when dyneval($code) has multiple global assignments and ANY assigns result', () => {
      const diags = run(
        `# a
$code = { x = 1 }
$code = { result = 42 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns when dyneval($code) has mixed local+global bindings that all lack result', () => {
      // Mixed local+global — routed through the multi-assignments
      // branch.  No candidate writes `result`, so universal-AND fires.
      const diags = run(
        `# a
$code = { x = 1 }
local $code = { x = 2 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('warns when dyneval($alias) chains through a var-ref to a single block lacking result', () => {
      // Alias chain: `$alias = $code; dyneval($alias)` should resolve
      // to the same block(s) as `dyneval($code)` would.
      const diags = run(
        `# a
$code = { x = 1 }
$alias = $code
y = dyneval($alias)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when dyneval($alias) chains through to a block that assigns result', () => {
      const diags = run(
        `# a
$code = { result = 42 }
$alias = $code
y = dyneval($alias)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    it('warns on dyneval($code) when same-scope sequential overwrites all lack result (no info diag, still universal-AND)', () => {
      // Sequential writes to a same-scope local: no info diag, but
      // the per-target diagnostic must still apply universal-AND
      // across both blocks.
      const diags = run(
        `# a
local $code = { x = 1 }
$code = { x = 2 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn on dyneval($code) when same-scope sequential overwrites and ANY assigns result', () => {
      const diags = run(
        `# a
local $code = { x = 1 }
$code = { result = 42 }
y = dyneval($code)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    // ── cross-location global dispatch ─────────────────────────────
    it('warns when dyneval($g) resolves to a global block in another location that lacks result', () => {
      const diags = run(
        `# init
$dispatch = { x = 1 }
---
# other
y = dyneval($dispatch)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(true);
    });

    it('does NOT warn when the cross-location global block assigns result', () => {
      const diags = run(
        `# init
$dispatch = { result = 42 }
---
# other
y = dyneval($dispatch)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });

    it('does NOT warn when at least ONE cross-location candidate assigns result', () => {
      const diags = run(
        `# a
$d = { x = 1 }
---
# b
$d = { result = 99 }
---
# other
y = dyneval($d)
---
`,
        { missingResultInFunctionCall: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(NEEDLE))).toBe(false);
    });
  });

  // ── extraArgsToTargetWithoutArgs ──────────────────────────────────
  describe('extraArgsToTargetWithoutArgs', () => {
    const TAG = "never reads 'args'";

    it('warns on gs with extra args when target has no args', () => {
      const diags = run(
        `# a
gs 'b', 1, 2
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      const hits = diags.filter(d => d.message.includes(TAG));
      expect(hits.length).toBe(1);
      expect(hits[0].message).toContain("'b'");
      expect(hits[0].message).toMatch(/2 extra arguments/);
    });

    it('does not warn when no extra args are passed', () => {
      const diags = run(
        `# a
gs 'b'
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG))).toBe(false);
    });

    it('warns on @user_call with extra args', () => {
      const diags = run(
        `# a
@b('x')
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(true);
    });

    it('warns on @@user_call (statement form) with extra args', () => {
      const diags = run(
        `# a
@@b 1, 2
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      const hits = diags.filter(d => d.message.includes(TAG) && d.message.includes("'b'"));
      expect(hits.length).toBe(1);
      expect(hits[0].message).toMatch(/2 extra arguments/);
    });

    it('warns on goto/gt/xgoto/xgt long and short forms with extra args', () => {
      const diags = run(
        `# a
goto 'b', 1
gt 'b', 2
xgoto 'b', 3
xgt 'b', 4
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      const hits = diags.filter(d => d.message.includes(TAG) && d.message.includes("'b'"));
      expect(hits.length).toBe(4);
    });

    it('warns on func/gosub call variants with extra args', () => {
      // goto-family (gt/xgt/goto/xgoto) is covered above; here we cover
      // the remaining LOCATION_REF_NAMES — func (function form) and
      // gosub (long statement form).
      const diags = run(
        `# a
y = func('b', 1)
gosub 'b', 2
---
# b
pl 'hi'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      const hits = diags.filter(d => d.message.includes(TAG) && d.message.includes("'b'"));
      expect(hits.length).toBe(2);
    });

    it('warns on inline dyneval block with extra args that does not read args', () => {
      const diags = run(
        `# a
y = dyneval({ result = 1 }, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(true);
    });

    it('does not warn on inline dyneval block that reads args', () => {
      const diags = run(
        `# a
y = dyneval({ result = args[0] }, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(false);
    });

    it('warns on inline dynamic block with extra args', () => {
      const diags = run(
        `# a
dynamic { x = 1 }, 99
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dynamic') && d.message.includes(TAG))).toBe(true);
    });

    it("treats target's own dyneval-block args usage as not satisfying the target", () => {
      // 'b' itself never reads args — its only `args` ref is inside a
      // dyneval block (which has its own args frame).
      const diags = run(
        `# a
gs 'b', 99
---
# b
y = dyneval({ result = args[0] }, 1)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(true);
    });

    it('does not warn when target is unresolved (handled by another diagnostic)', () => {
      const diags = run(
        `# a
gs 'no_such_loc', 1
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG))).toBe(false);
    });

    it('disabled by default in the test harness', () => {
      const diags = run(
        `# a
gs 'b', 1
---
# b
pl 'hi'
---
`,
        {},
      );
      expect(diags.some(d => d.message.includes(TAG))).toBe(false);
    });

    it("warns when target only has a 'local args' that shadows the built-in (no real args read)", () => {
      // 'b' declares `local $args` and reads from it; the local shadows
      // the built-in args, so the call's extras are still discarded.
      const diags = run(
        `# a
gs 'b', 99
---
# b
local $args = 'x'
pl $args
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(true);
    });

    it("does not warn when target reads built-in args before declaring 'local args'", () => {
      // Pre-declaration reference is on the built-in (non-local) symbol,
      // so the target genuinely consumes args.
      const diags = run(
        `# a
gs 'b', 99
---
# b
pl args[0]
local $args = 'x'
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(false);
    });

    it("warns on inline dyneval block whose only args read is shadowed by 'local args'", () => {
      const diags = run(
        `# a
$y = dyneval({ local $args = 'x' & $result = $args }, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(true);
    });

    it("warns when target's only args read lives inside a stored code block (own frame)", () => {
      // 'b' assigns a code block to $code that reads args; the block
      // has its own per-call args frame, so 'b' itself never reads
      // its incoming args — extras passed to 'b' are still discarded.
      const diags = run(
        `# a
gs 'b', 99
---
# b
$code = { pl args[0] }
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(true);
    });

    // ── var-mediated dynamic/dyneval (universal-AND over targets) ──
    it('warns on var-mediated dyneval($code, extras) when single target lacks args', () => {
      const diags = run(
        `# a
$code = { result = 1 }
y = dyneval($code, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(true);
    });

    it('does NOT warn on var-mediated dyneval($code, extras) when target reads args', () => {
      const diags = run(
        `# a
$code = { result = args[0] }
y = dyneval($code, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(false);
    });

    it('warns on var-mediated dynamic $code, extras when multi-global targets all lack args', () => {
      const diags = run(
        `# a
$code = { x = 1 }
$code = { x = 2 }
dynamic $code, 99
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dynamic') && d.message.includes(TAG))).toBe(true);
    });

    it('does NOT warn on var-mediated dynamic when ANY multi-target reads args', () => {
      // Universal-quantification: at least one candidate reads args,
      // so the warning is suppressed.
      const diags = run(
        `# a
$code = { x = 1 }
$code = { pl args[0] }
dynamic $code, 99
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dynamic') && d.message.includes(TAG))).toBe(false);
    });

    it('warns on var-mediated dyneval with cross-branch local targets that all lack args', () => {
      const diags = run(
        `# a
local $code
if 1:
  $code = { result = 1 }
else
  $code = { result = 2 }
end
y = dyneval($code, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(true);
    });

    it('does NOT warn on var-mediated dyneval with cross-branch locals where ANY reads args', () => {
      const diags = run(
        `# a
local $code
if 1:
  $code = { result = 1 }
else
  $code = { result = args[0] }
end
y = dyneval($code, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(false);
    });

    it('warns on var-mediated dyneval with same-scope sequential overwrites that all lack args (no info diag, still universal-AND)', () => {
      // Sequential writes to a same-scope local: last-write-wins, no
      // `multiple-local-bindings` info diag, but the per-target
      // diagnostic must still apply universal-AND across both blocks.
      const diags = run(
        `# a
local $code = { result = 1 }
$code = { result = 2 }
y = dyneval($code, 99)
---
`,
        { extraArgsToTargetWithoutArgs: true },
      );
      expect(diags.some(d => d.message.toLowerCase().includes('dyneval') && d.message.includes(TAG))).toBe(true);
    });

    // ── partial-args-use (callee reads fewer slots than caller passes) ──
    describe('partial args usage', () => {
      const PARTIAL = "reads at most 'args[";

      it('warns when target reads only args[0] but caller passes 2 extras', () => {
        const diags = run(
          `# a
gs 'b', 1, 2
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(1);
        expect(hits[0].message).toContain("args[0]");
        expect(hits[0].message).toMatch(/2 extra arguments/);
        expect(hits[0].message).toMatch(/1 extra value is discarded/);
      });

      it('does not warn when target reads args[1] (covers 2 passed extras)', () => {
        const diags = run(
          `# a
gs 'b', 1, 2
---
# b
pl args[0]
pl args[1]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('does not warn when target reads args with opaque (non-literal) index', () => {
        const diags = run(
          `# a
gs 'b', 1, 2, 3
---
# b
i = 0
:loop
  pl args[i]
  i = i + 1
  if i < 3: jump 'loop'
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('does not warn when target reads bare `args` (opaque whole-array)', () => {
        const diags = run(
          `# a
gs 'b', 1, 2
---
# b
pl args
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('warns on partial use through @user_call', () => {
        const diags = run(
          `# a
@b(1, 2, 3)
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(1);
        expect(hits[0].message).toMatch(/3 extra arguments/);
        expect(hits[0].message).toMatch(/2 extra values are discarded/);
      });

      it('warns on partial use through @@user_call (statement form)', () => {
        const diags = run(
          `# a
@@b 1, 2, 3
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(1);
        expect(hits[0].message).toMatch(/3 extra arguments/);
        expect(hits[0].message).toMatch(/2 extra values are discarded/);
      });

      it('warns on partial use through func/gosub/xgt', () => {
        const diags = run(
          `# a
y = func('b', 1, 2)
gosub 'b', 3, 4
xgt 'b', 5, 6
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(3);
      });

      it('warns on partial use through goto/gt/xgoto/xgt long and short forms', () => {
        const diags = run(
          `# a
goto 'b', 1, 2
gt 'b', 3, 4
xgoto 'b', 5, 6
xgt 'b', 7, 8
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(4);
      });

      it('warns on partial use in dyneval block with literal index', () => {
        const diags = run(
          `# a
y = dyneval({ result = args[0] }, 11, 22)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.toLowerCase().includes('dyneval')
          && d.message.includes("reads at most 'args[0]'"))).toBe(true);
      });

      it('warns on partial use in dynamic block with literal index', () => {
        const diags = run(
          `# a
dynamic { x = args[0] }, 11, 22, 33
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.toLowerCase().includes('dynamic')
          && d.message.includes("reads at most 'args[0]'"))).toBe(true);
      });

      it('uses ceiling across multi-target dyneval (suppress when ANY consumes all)', () => {
        const diags = run(
          `# a
$code = { result = args[0] }
$code = { result = args[1] }
y = dyneval($code, 11, 22)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        // One candidate reads args[1] which covers both extras → suppress.
        expect(diags.some(d => d.message.toLowerCase().includes('dyneval')
          && (d.message.includes(PARTIAL) || d.message.includes(TAG)))).toBe(false);
      });

      it('warns on multi-target dyneval when ALL targets only partially consume', () => {
        const diags = run(
          `# a
$code = { result = args[0] }
$code = { result = args[0] + 1 }
y = dyneval($code, 11, 22, 33)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        // Every candidate reads only args[0] → reports max-of-maxes (still 0).
        expect(diags.some(d => d.message.toLowerCase().includes('dyneval')
          && d.message.includes("reads at most 'args[0]'"))).toBe(true);
      });

      it('compound LHS `args[0] += 1` counts as a read (suppresses partial warning)', () => {
        const diags = run(
          `# a
gs 'b', 1
---
# b
args[0] += 1
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        // 1 extra passed, max literal idx = 0 → covers it → no warning.
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('pure write `args[0] = 99` does NOT count as a read (still warns "never reads")', () => {
        const diags = run(
          `# a
gs 'b', 1, 2
---
# b
args[0] = 99
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        // Only refs are pure writes → treated as "never reads".
        expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'b'"))).toBe(true);
      });

      it('does not warn when extras exactly match args[0..argCount-1]', () => {
        const diags = run(
          `# a
gs 'b', 10
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('does not warn at the boundary maxIdx+1 === argCount with non-zero index', () => {
        // 3 extras, max literal read is args[2] → covers args[0..2] exactly.
        const diags = run(
          `# a
gs 'b', 1, 2, 3
---
# b
pl args[2]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(PARTIAL))).toBe(false);
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('uses max literal index for non-contiguous reads (args[0] and args[2])', () => {
        // maxIdx=2 → covers 3 extras exactly; 4 extras → 1 discarded.
        const diags = run(
          `# a
gs 'b', 1, 2, 3, 4
---
# b
pl args[0]
pl args[2]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(1);
        expect(hits[0].message).toContain("args[2]");
        expect(hits[0].message).toMatch(/4 extra arguments/);
        expect(hits[0].message).toMatch(/1 extra value is discarded/);
      });

      it('reports per-call-site verdicts: only over-passing sites warn', () => {
        // Same callee reads only args[0]. Three call sites:
        //   - 1 extra  → exactly covered → no warn
        //   - 2 extras → 1 discarded     → partial warn
        //   - 3 extras → 2 discarded     → partial warn
        const diags = run(
          `# a
gs 'b', 10
gs 'b', 10, 20
gs 'b', 10, 20, 30
---
# b
pl args[0]
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        const hits = diags.filter(d => d.message.includes(PARTIAL) && d.message.includes("'b'"));
        expect(hits.length).toBe(2);
        expect(hits.some(h => /1 extra value is discarded/.test(h.message))).toBe(true);
        expect(hits.some(h => /2 extra values are discarded/.test(h.message))).toBe(true);
      });
    });

    // ── cross-location global dispatch ─────────────────────────────
    describe('cross-location global dispatch', () => {
      it('warns when dyneval($g, …) resolves to a global block that never reads args', () => {
        const diags = run(
          `# init
$dispatch = { result = 1 }
---
# other
y = dyneval($dispatch, 1, 2)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'dyneval'"))).toBe(true);
      });

      it('does NOT warn when the cross-location block reads args[0..N]', () => {
        const diags = run(
          `# init
$dispatch = { result = args[0] + args[1] }
---
# other
y = dyneval($dispatch, 1, 2)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('warns with partial-consumption when the block reads only args[0]', () => {
        const diags = run(
          `# init
$dispatch = { result = args[0] }
---
# other
y = dyneval($dispatch, 1, 2, 3)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => /at most 'args\[0\]'/.test(d.message))).toBe(true);
      });

      it("warns when `dynamic $g, …` (statement form) resolves to a global block that never reads args", () => {
        const diags = run(
          `# init
$dispatch = { x = 1 }
---
# other
dynamic $dispatch, 1, 2
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(TAG) && d.message.includes("'dynamic'"))).toBe(true);
      });

      it("does NOT warn on `dynamic $g, …` when the global block reads args[0..N]", () => {
        const diags = run(
          `# init
$dispatch = { y = args[0] + args[1] }
---
# other
dynamic $dispatch, 1, 2
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('suppresses the warning if ANY cross-location candidate fully consumes the args', () => {
        // Universal quantification: any single candidate that
        // consumes all extras suppresses the warning, mirroring
        // intra-location multi-target behaviour.
        const diags = run(
          `# a
$d = { y = 1 }
---
# b
$d = { y = args[0] + args[1] }
---
# other
y = dyneval($d, 1, 2)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });

      it('cross-loc dispatch is suppressed when an intra-loc binding shadows the global', () => {
        // `other` has its own `$d = {...}` — intra-loc resolves the
        // call, so the cross-loc post-pass never fires.  The diagnostic
        // here is the intra-loc one (or none, if the local block reads
        // args).  Confirm no `'dyneval' block` cross-loc warning.
        const diags = run(
          `# init
$d = { y = 1 }
---
# other
$d = { y = args[0] + args[1] }
y = dyneval($d, 1, 2)
---
`,
          { extraArgsToTargetWithoutArgs: true },
        );
        // Either no warning at all, OR an intra-loc one — but the
        // diagnostic should NOT reference 'dyneval' block specifically
        // from cross-loc dispatch since intra-loc resolved the call.
        // (Both branches read args[0..1], so no warning is expected.)
        expect(diags.some(d => d.message.includes(TAG))).toBe(false);
      });
    });
  });

  // ── shadowsCallFrameBuiltin ──────────────────────────────────────
  describe('shadowsCallFrameBuiltin', () => {
    const SHADOW_TAG = 'is already a per-call-frame variable';

    it("warns on 'local args' declaration", () => {
      const diags = run(
        `# a
local args = 1
pl args
---
`,
        { shadowsCallFrameBuiltin: true },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG) && d.message.includes("'local args'"))).toBe(true);
    });

    it("warns on bare 'local args' (no initializer)", () => {
      const diags = run(
        `# a
local args
---
`,
        { shadowsCallFrameBuiltin: true },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG) && d.message.includes("'local args'"))).toBe(true);
    });

    it("warns on 'local result' declaration", () => {
      const diags = run(
        `# a
local result = 1
---
`,
        { shadowsCallFrameBuiltin: true },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG) && d.message.includes("'local result'"))).toBe(true);
    });

    it('does not warn on plain reads or writes to args / result (no `local`)', () => {
      const diags = run(
        `# a
result = 5
pl args[0]
---
`,
        { shadowsCallFrameBuiltin: true },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG))).toBe(false);
    });

    it('produces no warning when the setting is disabled', () => {
      const diags = run(
        `# a
local args = 1
local result = 1
---
`,
        { shadowsCallFrameBuiltin: false },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG))).toBe(false);
    });

    it("warns on 'local args' inside an inline dyneval block", () => {
      const diags = run(
        `# a
y = dyneval({ local args = 1 & result = args }, 99)
---
`,
        { shadowsCallFrameBuiltin: true },
      );
      expect(diags.some(d => d.message.includes(SHADOW_TAG) && d.message.includes("'local args'"))).toBe(true);
    });
  });

  // ── shadowsPropagatedLocal ───────────────────────────────────────
  describe('shadowsPropagatedLocal', () => {
    const PROP_TAG = 'shadows a local variable propagated in from';

    it("flags 'local x' in a callee where caller propagates x", () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
local x = 2
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'") && d.message.includes("'a'"))).toBe(true);
    });

    it('does not flag when callee uses x without re-declaring', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG))).toBe(false);
    });

    it('does not flag a callee local with no caller propagating that name', () => {
      const diags = run(
        `# a
gs 'b'
---
# b
local x = 1
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG))).toBe(false);
    });

    it('does NOT flag a `local x` that lives only inside a stored code block that is never invoked', () => {
      // The callee `b` only declares `local x` inside `{ … }`, a
      // scope-isolated frame.  No `dynamic $code` ever runs the
      // block in `b`'s body, so the propagated `x` from `a` is
      // never actually shadowed at b's top scope.
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
$code = { local x = 99 }
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(0);
    });

    it('does not flag args / result (covered by shadowsCallFrameBuiltin)', () => {
      const diags = run(
        `# a
local args = 1
gs 'b'
---
# b
local args = 2
local result = 3
---
`,
        { shadowsPropagatedLocal: true },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG))).toBe(false);
    });

    it('produces no diagnostic when the setting is disabled', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
local x = 2
---
`,
        { shadowsPropagatedLocal: false },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG))).toBe(false);
    });

    it('flags self-shadow `local x = x` (idiom is not exempt)', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
local x = x
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      expect(diags.some(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"))).toBe(true);
    });

    it('lists multiple distinct callers', () => {
      const diags = run(
        `# a
local x = 1
gs 'c'
---
# b
local x = 2
gs 'c'
---
# c
local x = 3
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const msg = diags.find(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"))?.message;
      expect(msg).toBeDefined();
      expect(msg).toContain("'a'");
      expect(msg).toContain("'b'");
    });

    it('flags `local x` inside an inline dyneval block in the callee', () => {
      // The inline block runs in the callee's scope; the propagated `x`
      // from caller is visible there, so the inner `local x` shadows it.
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
y = dyneval({ local x = 99 & result = x })
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside a stored code block invoked via `dynamic`', () => {
      // `$code = { local x = ... }` and `dynamic $code` in the same
      // location — the block runs in the caller's scope at runtime.
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
$code = { local x = 99 & pl x }
dynamic $code
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside one of MULTIPLE candidate blocks (multi-target dispatch)', () => {
      // Cross-branch local code-blocks: at runtime exactly one is
      // executed, but our deferred walker analyses BOTH with the same
      // caller-locals union.  A `local x` shadowing inside ANY
      // candidate must still trigger the warning.
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
local $code
if 1:
  $code = { local x = 99 & pl x }
else
  $code = { pl x }
end
dynamic $code
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside multi-global-assignments candidates (universal coverage)', () => {
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
$code = { pl x }
$code = { local x = 99 & pl x }
dynamic $code
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside a block reached via alias chain ($outer = $inner; dynamic $outer)', () => {
      // The resolver must follow `$outer -> $inner -> { local x ... }`
      // so the deferred walk reaches the chained block with the
      // caller's propagated locals.
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
$inner = { local x = 99 & pl x }
$outer = $inner
dynamic $outer
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    // ── isExecutableShadow Case A: scope reachable from scope 0 ─────

    it('flags `local x` inside a multiline if-branch', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
if 1:
  local x = 2
end
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside an inline if-branch', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
if 1: local x = 2
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside an inline `dynamic { … }` statement block', () => {
      const diags = run(
        `# a
local x = 5
gs 'b'
---
# b
dynamic { local x = 99 & pl x }
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    it('flags `local x` inside a loop body', () => {
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
loop local i = 0 while i < 3 step i += 1:
  local x = 2
end
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(1);
      expect(matches[0].message).toContain("'a'");
    });

    // ── isExecutableShadow negative: isolation honored ──────────────

    it('does NOT flag `local x` inside an `act` block (isolated scope)', () => {
      // `act` creates its own runtime call frame.  A `local x` inside
      // it does not shadow the propagated `x` at b's top scope, and
      // the act's body itself runs in a fresh frame where the caller's
      // propagated `x` is not visible anyway.
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
act 'go':
  local x = 99
end
pl x
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(0);
    });

    it('does NOT flag `local x` inside a stored block dispatched from a DIFFERENT location', () => {
      // `$code` is assigned in `b` but only dispatched in `c`.  The
      // block is not in `b`'s `resolvedDynamicBlocks` and `b` itself
      // never executes the block locally — no shadow at `b`.
      const diags = run(
        `# a
local x = 1
gs 'b'
gs 'c'
---
# b
$code = { local x = 99 }
pl x
---
# c
dynamic $code
---
`,
        { shadowsPropagatedLocal: true },
      );
      const matches = diags.filter(d => d.message.includes(PROP_TAG) && d.message.includes("'local x'"));
      expect(matches.length).toBe(0);
    });
  });

  // ── inconsistentLocalPropagation ─────────────────────────────────
  describe('inconsistentLocalPropagation', () => {
    it('does not warn when intermediate caller writes to a propagated local', () => {
      // a → b (propagates x) → c (reads x)
      // b writes x = 2 (not a LOCAL declaration) — should remain a
      // transparent pass-through; no inconsistency.
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
x = 2
gs 'c'
---
# c
pl x
---
`,
        { inconsistentLocalPropagation: true },
      );
      const msgs = diags.map(d => d.message);
      expect(msgs.find(m => m.includes("'x'") && m.includes('propagated as local'))).toBeUndefined();
    });

    it('warns through func/@ when one caller does not propagate', () => {
      const diags = run(
        `# a
local x = 1
y = func('c')
---
# d
y = @c
---
# c
pl x
---
`,
        { inconsistentLocalPropagation: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('propagated as local')),
      ).toBe(true);
    });

    it('does NOT warn when all propagating callers (gs+func) supply x and only goto-style callers do not (current behavior)', () => {
      // Documents a known limitation: goto/gt/xgoto callers are not
      // tracked in `propagationCallers`, so they cannot be reported as
      // "non-propagating" mismatched callers. As long as every caller
      // in the propagation graph (gs, func, @, @@, desc) supplies x,
      // the diagnostic stays silent even if a goto-caller also reaches C.
      const diags = run(
        `# a
local x = 1
gs 'c'
---
# b
local x = 2
y = func('c')
---
# d
gt 'c'
---
# c
pl x
---
`,
        { inconsistentLocalPropagation: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('propagated as local')),
      ).toBe(false);
    });

    it('does NOT warn when xgoto/xgt is the non-propagating caller but no read in callee', () => {
      // Sanity: xgoto is non-propagating but if callee never reads x,
      // there's nothing to propagate inconsistently.
      const diags = run(
        `# a
local x = 1
gs 'c'
---
# d
xgt 'c'
---
# c
y = 1
---
`,
        { inconsistentLocalPropagation: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('propagated as local')),
      ).toBe(false);
    });

    it('warns in transitive chain A→B→C even when B has its own `local x` (per-call semantics)', () => {
      // A defines x and calls B; B has `local x` and calls C; D also
      // calls C without any x.  Under per-call semantics B's own
      // `local x` does not block propagation to C — B's call site
      // has x in `localsInScope` so it propagates (with B's value).
      // The inconsistency comes from D, which passes nothing.
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
local x = 99
gs 'c'
---
# d
gs 'c'
---
# c
pl x
---
`,
        { inconsistentLocalPropagation: true },
      );
      const matches = diags.filter(
        d => d.message.includes("'x'") && d.message.includes('propagated as local'),
      );
      expect(matches.length).toBeGreaterThan(0);
      // B and D should be on opposite sides of the message.
      expect(matches[0].message).toMatch(/from b line \d+/);
      expect(matches[0].message).toMatch(/but not from d line \d+/);
    });

    it('warns when desc-call propagates x and a sibling gs-caller does not declare x', () => {
      // Verifies that desc participates as a propagating caller in the
      // inconsistent-propagation graph (same role as gs/func).
      const diags = run(
`# a
local x = 1
$t = desc('c')
---
# d
gs 'c'
---
# c
pl x
---
`,
        { inconsistentLocalPropagation: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('propagated as local')),
      ).toBe(true);
    });
  });

  // ── mixedVariablePrefixes ────────────────────────────────────────
  describe('mixedVariablePrefixes', () => {
    it('detects mismatch between caller local and callee usage of the propagated var', () => {
      // Caller's x is numeric; callee uses $x (string) — should warn in
      // the callee with the merged prefix set.
      const diags = run(
        `# a
local x = 1
gs 'b'
---
# b
pl $x
---
`,
        { mixedVariablePrefixes: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('mixed type prefixes')),
      ).toBe(true);
    });

    it('does not warn when caller and callee agree on prefix', () => {
      const diags = run(
        `# a
local $x = 'hi'
gs 'b'
---
# b
pl $x
---
`,
        { mixedVariablePrefixes: true },
      );
      expect(
        diags.some(d => d.message.includes("'x'") && d.message.includes('mixed type prefixes')),
      ).toBe(false);
    });

    it('no false positive: local y in if-branch and local $y in else-branch are separate', () => {
      // Regression: `else_clause` was not scope-forming, so both bindings
      // shared the if_block scopeNodeId.  The resolver then returned both
      // sibling-branch bindings, adding the wrong prefix to `merged` and
      // firing a spurious warning.  Use literal RHS values (not var-refs)
      // so the resolver does not follow a chain to a differently-prefixed
      // variable.
      const diags = run(
        `# main
if 1:
  local y = 1
else
  local $y = 'hello'
end
---
`,
        { mixedVariablePrefixes: true },
      );
      expect(
        diags.some(d => d.message.includes("'y'") && d.message.includes('mixed type prefixes')),
      ).toBe(false);
    });

    it('no false positive: assigning $x to y is a cross-type assignment, not mixed prefix for y', () => {
      // `local y = $x` — y (no prefix, numeric) is assigned from $x (string).
      // y itself is always accessed as `y`; the fact that the RHS has `$`
      // prefix does NOT mean y is used with mixed prefixes.
      const diags = run(
        `# main
local $x = 'hello'
if 1:
  local y = $x
else
  local $y = $x
end
---
`,
        { mixedVariablePrefixes: true },
      );
      expect(
        diags.some(d => d.message.includes("'y'") && d.message.includes('mixed type prefixes')),
      ).toBe(false);
    });
  });

  // ── Gap 2 interactions with other diagnostics ─────────────────────
  // Verify that existing checks still behave correctly when values
  // flow across locations via var-mediated dynamic dispatch.  The
  // Gap 2 post-pass feeds `externalLocalBindings` / `propagatedSyms`;
  // unusedVariables / uninitializedVariables consume those, so the
  // indirection should not break their semantics.
  describe('Gap 2 — var-mediated dispatch interactions', () => {
    it('unusedVariables: does not flag caller-local written by callee via dynamic $code', () => {
      const diags = run(
        `# a
local x = 0
local $code = { x = 42 }
gs 'b'
pl x
---
# b
dynamic $code
---
`,
        { unusedVariables: true },
      );
      // x is read in the caller (`pl x`); the indirect write via
      // dynamic $code should not trigger the unused diagnostic.
      expect(
        diags.some(d => d.message === "Variable 'x' is assigned but never read"),
      ).toBe(false);
    });

    it('uninitializedVariables: does not flag read of caller-local initialised only via dynamic $code in callee', () => {
      const diags = run(
        `# a
local x = 0
local $code = { x = 42 }
gs 'b'
pl x
---
# b
dynamic $code
---
`,
        { uninitializedVariables: true },
      );
      expect(
        diags.some(d => d.message === "Variable 'x' is used but never assigned"),
      ).toBe(false);
    });

    it('unusedVariables: caller-local read inside ONE of multiple candidate blocks counts as used', () => {
      // Cross-branch local code-blocks: only one candidate reads `x`,
      // but every candidate is walked with the caller-locals union, so
      // the reference is registered against the caller's local.
      const diags = run(
        `# a
local x = 5
local $code
if 1:
  $code = { pl x }
else
  $code = { x = 7 }
end
dynamic $code
---
`,
        { unusedVariables: true },
      );
      expect(
        diags.some(d => d.message === "Variable 'x' is assigned but never read"),
      ).toBe(false);
    });

    it('unusedVariables: caller-local read inside ONE of multiple global candidates counts as used', () => {
      const diags = run(
        `# a
local x = 5
$code = { pl 'a' }
$code = { pl x }
dynamic $code
---
`,
        { unusedVariables: true },
      );
      expect(
        diags.some(d => d.message === "Variable 'x' is assigned but never read"),
      ).toBe(false);
    });

    it('unusedVariables: caller-local read via $outer -> dynamic $inner alias chain counts as used', () => {
      // Read of caller-local `x` only happens inside the inner block
      // reached through the alias chain `$outer = $inner; dynamic $outer`.
      // The resolver must follow the chain so the read is registered.
      const diags = run(
        `# a
local x = 5
$inner = { pl x }
$outer = $inner
dynamic $outer
---
`,
        { unusedVariables: true },
      );
      expect(
        diags.some(d => d.message === "Variable 'x' is assigned but never read"),
      ).toBe(false);
    });

    it('unusedVariables: caller-local written via $outer -> dynamic $inner alias chain counts as initialized + used', () => {
      // Write to `x` happens only via the chained block; subsequent
      // `pl x` in the caller reads it.  Neither uninitialized nor
      // unused diagnostic should fire.
      const diags = run(
        `# a
local x
$inner = { x = 42 }
$outer = $inner
dynamic $outer
pl x
---
`,
        { unusedVariables: true, uninitializedVariables: true },
      );
      expect(
        diags.some(d => d.message === "Variable 'x' is assigned but never read"),
      ).toBe(false);
      expect(
        diags.some(d => d.message === "Variable 'x' is used but never assigned"),
      ).toBe(false);
    });

    it('untrackedDynamicCalls: complex expression info', () => {
      // Complex expression → untracked.
      const diags = run(
        `# a
dynamic $a + $b
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('first argument is not a code block'))).toBe(true);
    });

    it('untrackedDynamicCalls: ambiguous (multiple globals) info', () => {
      // Multiple global bindings → untracked.
      const diags = run(
        `# a
$code = { pl '1' }
$code = { pl '2' }
dynamic $code
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('assigned multiple code blocks'))).toBe(true);
    });

    it('untrackedDynamicCalls: emits multiple-local-bindings info for multiple distinct local code blocks', () => {
      const diags = run(
        `# a
local $code
if 1:
  $code = { pl '1' }
else
  $code = { pl '2' }
end
dynamic $code
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('multiple local code-block bindings'))).toBe(true);
    });

    it('untrackedDynamicCalls: does NOT emit multiple-local-bindings for a single local binding', () => {
      const diags = run(
        `# a
local $code = { pl '1' }
dynamic $code
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('multiple local code-block bindings'))).toBe(false);
    });

    it('untrackedDynamicCalls: bare write to existing local is the same local — not a local+global mix', () => {
      // After `local $code = {...}`, a subsequent bare `$code = {...}`
      // in the same scope still targets the local (per QSP scoping
      // rules; cf. retagPass in bindingCollector.ts).  The dynamic
      // call resolves to a single local symbol with two writes — no
      // ambiguity diagnostic should fire.
      const diags = run(
        `# a
local $code = { pl '1' }
$code = { pl '2' }
dynamic $code
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('assigned multiple code blocks'))).toBe(false);
      expect(diags.some(d => d.message.includes('multiple local code-block bindings'))).toBe(false);
    });

    it('untrackedDynamicCalls: string-bound variable does NOT fire (runtime call is valid, just not statically inspectable)', () => {
      // `$cmd = 'pl 1'` is a perfectly valid argument to dynamic at
      // runtime — QSP treats the string as the code source.  The
      // static analyser cannot inspect the body, but emitting a diag
      // here would be a false positive.  Verify silence.
      const diags = run(
        `# a
$cmd = 'pl 1'
dynamic $cmd
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('dynamic'))).toBe(false);
      expect(diags.some(d => d.message.includes('code block'))).toBe(false);
    });

    it('untrackedDynamicCalls: unbound variable does NOT fire untracked diag', () => {
      // `dynamic $never` where $never is never assigned — runtime
      // would error, but other diagnostics (uninitialized variables)
      // already cover that.  No untracked-dynamic diag should fire.
      const diags = run(
        `# a
dynamic $never
---
`,
        { untrackedDynamicCalls: true },
      );
      expect(diags.some(d => d.message.includes('multiple'))).toBe(false);
      expect(diags.some(d => d.message.includes('first argument'))).toBe(false);
    });
  });

  // ── invalidBuiltinArgCount ─────────────────────────────────────────
  describe('invalidBuiltinArgCount', () => {
    function argDiags(code: string) {
      return run(code, { invalidBuiltinArgCount: true })
        .filter(d => /expects .* arguments/.test(d.message));
    }

    // Statements ─────────────────────────────────────────────────────
    it('flags too many args on a fixed-arity statement (exit takes 0)', () => {
      const diags = argDiags(`# a\nexit 1\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Statement 'exit' expects 0 arguments, got 1 argument$/);
    });

    it('flags too few args on a fixed-arity statement (msg takes 1)', () => {
      const diags = argDiags(`# a\nmsg\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Statement 'msg' expects 1 arguments, got 0 arguments$/);
    });

    it('flags too many args on a 0..1 statement (pl)', () => {
      const diags = argDiags(`# a\npl 'a','b'\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Statement 'pl' expects 0 to 1 arguments, got 2 arguments$/);
    });

    it('does NOT flag pl with 0 args or 1 arg', () => {
      expect(argDiags(`# a\npl\n---\n`)).toHaveLength(0);
      expect(argDiags(`# a\npl 'hi'\n---\n`)).toHaveLength(0);
    });

    it('flags too many args on a bounded-variadic statement (addobj 1..3)', () => {
      const diags = argDiags(`# a\naddobj 'sword', 'icon.png', 1, 'extra'\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/'addobj' expects 1 to 3 arguments, got 4 arguments$/);
    });

    it('does NOT flag truly variadic statements (gs takes 1+)', () => {
      expect(argDiags(`# a\ngs 'b', 1, 2, 3, 4, 5\n---\n# b\n---\n`)).toHaveLength(0);
    });

    it('flags variadic statement called with 0 args (gs takes 1+)', () => {
      const diags = argDiags(`# a\ngs\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/'gs' expects 1 to 20 arguments, got 0 arguments$/);
    });

    it('handles multi-word statement name "add obj" (whitespace-insensitive lookup)', () => {
      // The grammar accepts "add obj"; lookup must canonicalise to a
      // single space.  Too many args → flagged.
      const diags = argDiags(`# a\nadd obj 'a','b','c','d','e'\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/'add obj' expects 1 to 3 arguments/);
    });

    // Functions ──────────────────────────────────────────────────────
    it('flags too many args on a 0-arg function (rnd)', () => {
      const diags = argDiags(`# a\nx = rnd(1,2)\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Function 'rnd' expects 0 arguments, got 2 arguments$/);
    });

    it('flags too few args on a fixed-arity function (iif takes 3)', () => {
      const diags = argDiags(`# a\nx = iif(1, 2)\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Function 'iif' expects 3 arguments, got 2 arguments$/);
    });

    it('flags too few args on a 1-arg function (mid)', () => {
      const diags = argDiags(`# a\nx = mid('abc')\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Function 'mid' expects 2 to 3 arguments, got 1 argument$/);
    });

    it('does NOT flag mid with valid arity (2 or 3)', () => {
      expect(argDiags(`# a\nx = mid('abc', 1)\n---\n`)).toHaveLength(0);
      expect(argDiags(`# a\nx = mid('abc', 1, 2)\n---\n`)).toHaveLength(0);
    });

    it('does NOT flag a no-paren function call with 0 args (rnd)', () => {
      // `rnd` with no parens or args at all is the canonical idiom.
      expect(argDiags(`# a\nx = rnd\n---\n`)).toHaveLength(0);
    });

    it('flags variadic function called with 0 args (max takes 1+)', () => {
      const diags = argDiags(`# a\nx = max()\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/'max' expects 1 to 20 arguments, got 0 arguments$/);
    });

    it('does NOT flag variadic function with many args (max)', () => {
      expect(argDiags(`# a\nx = max(1, 2, 3, 4, 5)\n---\n`)).toHaveLength(0);
    });

    // Range placement / setting gating ──────────────────────────────
    it('attaches the diagnostic to the call name token, not the args', () => {
      const diags = run(`# a\nexit 1, 2\n---\n`, { invalidBuiltinArgCount: true })
        .filter(d => /expects/.test(d.message));
      expect(diags).toHaveLength(1);
      const r = diags[0].range;
      // Range covers `exit` on line 1 (0-based line 1, columns 0..4).
      expect(r.start.line).toBe(1);
      expect(r.start.character).toBe(0);
      expect(r.end.line).toBe(1);
      expect(r.end.character).toBe(4);
    });

    it('emits no diagnostics when the setting is disabled', () => {
      const diags = run(`# a\nexit 1\n---\n`, { invalidBuiltinArgCount: false });
      expect(diags.filter(d => /expects/.test(d.message))).toHaveLength(0);
    });

    it('does NOT range-check unknown statement-like tokens', () => {
      // User functions are NOT builtins; no arg-count warning expected.
      const diags = argDiags(`# a\n@@foo 1, 2, 3\n---\n# foo\n---\n`);
      expect(diags).toHaveLength(0);
    });

    it('does NOT flag an empty-parens function call when 0 is allowed (rnd())', () => {
      expect(argDiags(`# a\nx = rnd()\n---\n`)).toHaveLength(0);
    });

    // Runtime-aligned constraints ───────────────────────────────────
    it('flags exceeding QSP_MAXSTATARGS (20) on gs', () => {
      const args = Array.from({ length: 21 }, (_, i) => i === 0 ? `'b'` : `${i}`).join(',');
      const diags = argDiags(`# a\ngs ${args}\n---\n# b\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/'gs' expects 1 to 20 arguments, got 21 arguments$/);
    });

    it('does NOT flag a 4-arg rgb (alpha channel)', () => {
      expect(argDiags(`# a\nx = rgb(1, 2, 3, 128)\n---\n`)).toHaveLength(0);
    });

    it('does NOT flag a 1-arg arritem / arrtype (return first element / its type)', () => {
      expect(argDiags(`# a\nx = arritem('foo')\n---\n`)).toHaveLength(0);
      expect(argDiags(`# a\n$x = arrtype('foo')\n---\n`)).toHaveLength(0);
    });

    it('does NOT flag a 2-arg modobj (third arg is optional)', () => {
      expect(argDiags(`# a\nmodobj 'sword', 'new title'\n---\n`)).toHaveLength(0);
    });

    it('does NOT flag a 2- or 3-arg menu', () => {
      expect(argDiags(`# a\nmenu 'arr', 1\n---\n`)).toHaveLength(0);
      expect(argDiags(`# a\nmenu 'arr', 1, 2\n---\n`)).toHaveLength(0);
    });
  });

  // ── deprecated builtins (always on; no setting flag) ─────────────
  describe('deprecated builtins', () => {
    function depDiags(code: string) {
      return run(code, {}).filter(d => /is outdated/.test(d.message));
    }

    it('flags ADDQST as deprecated and suggests INCLIB', () => {
      const diags = depDiags(`# a\naddqst 'lib.qsp'\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Statement 'ADDQST' is outdated; use 'INCLIB' instead/);
      expect(diags[0].tags).toContain(DiagnosticTag.Deprecated);
    });

    it('flags KILLQST as deprecated and suggests FREELIB', () => {
      const diags = depDiags(`# a\nkillqst\n---\n`);
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toMatch(/Statement 'KILLQST' is outdated; use 'FREELIB' instead/);
      expect(diags[0].tags).toContain(DiagnosticTag.Deprecated);
    });

    it('does NOT flag the modern replacements (INCLIB, FREELIB)', () => {
      expect(depDiags(`# a\ninclib 'lib.qsp'\nfreelib\n---\n`)).toHaveLength(0);
    });

    it('attaches the diagnostic range to the call name token only', () => {
      const diags = depDiags(`# a\naddqst 'lib.qsp'\n---\n`);
      expect(diags).toHaveLength(1);
      const r = diags[0].range;
      expect(r.start.line).toBe(1);
      expect(r.start.character).toBe(0);
      expect(r.end.line).toBe(1);
      expect(r.end.character).toBe(6);  // 'addqst' length
    });
  });

  // ── typeMismatch ─────────────────────────────────────────────────
  describe('typeMismatch', () => {
    function mismatch(code: string) {
      return run(code, { typeMismatch: true })
        .filter(d => d.message.startsWith('Type mismatch'));
    }

    // ── string variable ← number / numeric var / numeric func ─────
    it('flags number literal assigned to string variable', () => {
      expect(mismatch(`# a\n$x = 44\n---\n`)).toHaveLength(1);
    });

    it('flags numeric variable assigned to string variable', () => {
      expect(mismatch(`# a\n$x = y\n---\n`)).toHaveLength(1);
    });

    it('flags #-prefixed numeric variable assigned to string variable', () => {
      expect(mismatch(`# a\n$x = #y\n---\n`)).toHaveLength(1);
    });

    it('flags numeric-only function call assigned to string variable', () => {
      // rand() always returns a number; calling it without $ prefix and
      // assigning to $x is a type mismatch.
      expect(mismatch(`# a\n$x = rand(1, 10)\n---\n`)).toHaveLength(1);
    });

    it('does not flag string function call assigned to string variable', () => {
      expect(mismatch(`# a\n$x = $str(42)\n---\n`)).toHaveLength(0);
    });

    // ── numeric variable ← string ────────────────────────────────
    it('flags string literal assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = 'hello'\n---\n`)).toHaveLength(1);
    });

    it('flags string literal assigned to #-prefixed numeric variable', () => {
      expect(mismatch(`# a\n#x = 'hello'\n---\n`)).toHaveLength(1);
    });

    it('flags string variable assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = $y\n---\n`)).toHaveLength(1);
    });

    it('flags local: string var-ref assigned to numeric local', () => {
      expect(mismatch(`# a\nlocal y = $x\n---\n`)).toHaveLength(1);
    });

    it('flags string-only function result assigned to numeric variable', () => {
      // $input() returns a string; assigning to numeric x is a mismatch.
      expect(mismatch(`# a\nx = $input('msg')\n---\n`)).toHaveLength(1);
    });

    it('does not flag numeric function result assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = rand(1, 10)\n---\n`)).toHaveLength(0);
    });

    // ── tuple variable ← number / string ─────────────────────────
    it('flags number literal assigned to tuple variable', () => {
      expect(mismatch(`# a\n%x = 5\n---\n`)).toHaveLength(1);
    });

    it('flags string literal assigned to tuple variable', () => {
      expect(mismatch(`# a\n%x = 'hello'\n---\n`)).toHaveLength(1);
    });

    it('flags string variable assigned to tuple variable', () => {
      expect(mismatch(`# a\n%x = $y\n---\n`)).toHaveLength(1);
    });

    it('flags numeric variable assigned to tuple variable', () => {
      expect(mismatch(`# a\n%x = y\n---\n`)).toHaveLength(1);
    });

    // ── non-tuple variable ← tuple ────────────────────────────────
    it('flags tuple variable assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = %t\n---\n`)).toHaveLength(1);
    });

    it('flags tuple variable assigned to string variable', () => {
      expect(mismatch(`# a\n$x = %t\n---\n`)).toHaveLength(1);
    });

    it('flags bracket_tuple literal assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = [1, 2, 3]\n---\n`)).toHaveLength(1);
    });

    it('flags bracket_tuple literal assigned to string variable', () => {
      expect(mismatch(`# a\n$x = [1, 2, 3]\n---\n`)).toHaveLength(1);
    });

    // ── tuple unpacking — element types are unknown, no flag ─────
    it('does not flag tuple-unpacking `local a, $b, #c = %t` (opaque %-typed RHS)', () => {
      expect(mismatch(`# a\nlocal a, $b, #c = %t\n---\n`)).toHaveLength(0);
    });

    it('does not flag opaque tuple-unpacking `$a, #b = %f` (no local)', () => {
      expect(mismatch(`# a\n$a, #b = %f\n---\n`)).toHaveLength(0);
    });

    // Arity-matched tuple literals spread element-wise (equivalent to
    // the comma form `$a, #b = 1, 2`), so element-level type-mismatches
    // ARE flagged — this is the correct, more-precise behavior.
    it('flags element-wise mismatch in spread `$a, #b = [1, 2]` (== `$a = 1`)', () => {
      // $a = 1 is a number-into-string mismatch; #b = 2 is fine.
      expect(mismatch(`# a\n$a, #b = [1, 2]\n---\n`)).toHaveLength(1);
    });

    it('flags element-wise mismatch in comma form `$a, #b = 1, 2` (same as spread)', () => {
      expect(mismatch(`# a\n$a, #b = 1, 2\n---\n`)).toHaveLength(1);
    });

    // ── valid assignments — no flag ────────────────────────────────
    it('does not flag number to numeric variable', () => {
      expect(mismatch(`# a\nx = 42\n---\n`)).toHaveLength(0);
    });

    it('does not flag #-prefixed number to numeric variable', () => {
      expect(mismatch(`# a\n#x = 42\n---\n`)).toHaveLength(0);
    });

    it('does not flag string to string variable', () => {
      expect(mismatch(`# a\n$x = 'hello'\n---\n`)).toHaveLength(0);
    });

    it('does not flag string variable to string variable', () => {
      expect(mismatch(`# a\n$x = $y\n---\n`)).toHaveLength(0);
    });

    it('does not flag numeric variable to numeric variable', () => {
      expect(mismatch(`# a\nx = y\n---\n`)).toHaveLength(0);
    });

    it('does not flag compound operator when types match ($x += string)', () => {
      expect(mismatch(`# a\n$x += 'more'\n---\n`)).toHaveLength(0);
    });

    it('does not flag compound operator when types match (#x += number)', () => {
      expect(mismatch(`# a\n#x += 5\n---\n`)).toHaveLength(0);
    });

    it('flags compound += with numeric literal into string variable', () => {
      expect(mismatch(`# a\n$x += 5\n---\n`)).toHaveLength(1);
    });

    it('flags compound += with string literal into numeric variable', () => {
      expect(mismatch(`# a\n#x += 'hello'\n---\n`)).toHaveLength(1);
    });

    it('flags compound += with string variable RHS into numeric variable', () => {
      expect(mismatch(`# a\n#x += $y\n---\n`)).toHaveLength(1);
    });

    it('flags compound += with tuple literal RHS into numeric variable', () => {
      expect(mismatch(`# a\n#x += [1, 2]\n---\n`)).toHaveLength(1);
    });

    it('flags compound += with tuple variable RHS into numeric variable', () => {
      expect(mismatch(`# a\n#x += %t\n---\n`)).toHaveLength(1);
    });

    it('does NOT flag `%x += 3` (tuple variable accepts any RHS)', () => {
      expect(mismatch(`# a\n%x += 3\n---\n`)).toHaveLength(0);
    });

    it('flags compound -= with string literal into numeric variable', () => {
      expect(mismatch(`# a\n#x -= 'str'\n---\n`)).toHaveLength(1);
    });

    it('flags compound *= with string literal into numeric variable', () => {
      expect(mismatch(`# a\n#x *= 'str'\n---\n`)).toHaveLength(1);
    });

    it('flags compound /= with string literal into numeric variable', () => {
      expect(mismatch(`# a\n#x /= 'str'\n---\n`)).toHaveLength(1);
    });

    it('flags compound += with tuple variable RHS into string variable', () => {
      expect(mismatch(`# a\n$x += %t\n---\n`)).toHaveLength(1);
    });

    it('flags compound -= with numeric literal into string variable', () => {
      expect(mismatch(`# a\n$x -= 5\n---\n`)).toHaveLength(1);
    });

    it('flags compound -= with tuple variable RHS into string variable', () => {
      expect(mismatch(`# a\n$x -= %t\n---\n`)).toHaveLength(1);
    });

    it('flags compound -= on string variable even with string RHS', () => {
      expect(mismatch(`# a\n$x -= 'more'\n---\n`)).toHaveLength(1);
    });

    it('flags compound *= with numeric literal into string variable', () => {
      expect(mismatch(`# a\n$x *= 5\n---\n`)).toHaveLength(1);
    });

    it('flags compound *= with tuple variable RHS into string variable', () => {
      expect(mismatch(`# a\n$x *= %t\n---\n`)).toHaveLength(1);
    });

    it('flags compound *= on string variable even with string RHS', () => {
      expect(mismatch(`# a\n$x *= 'more'\n---\n`)).toHaveLength(1);
    });

    it('flags compound /= with numeric literal into string variable', () => {
      expect(mismatch(`# a\n$x /= 5\n---\n`)).toHaveLength(1);
    });

    it('flags compound /= with tuple variable RHS into string variable', () => {
      expect(mismatch(`# a\n$x /= %t\n---\n`)).toHaveLength(1);
    });

    it('flags compound /= on string variable even with string RHS', () => {
      expect(mismatch(`# a\n$x /= 'more'\n---\n`)).toHaveLength(1);
    });

    // ── compound operators on tuple variables ─────────────────────
    it('does not flag tuple += with any RHS (string)', () => {
      expect(mismatch(`# a\n%x += 'hello'\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple += with any RHS (number)', () => {
      expect(mismatch(`# a\n%x += 5\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple += with any RHS (tuple)', () => {
      expect(mismatch(`# a\n%x += %t\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple -= with numeric RHS', () => {
      expect(mismatch(`# a\n%x -= 5\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple -= with tuple RHS', () => {
      expect(mismatch(`# a\n%x -= %t\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple *= with numeric RHS', () => {
      expect(mismatch(`# a\n%x *= 5\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple *= with tuple RHS', () => {
      expect(mismatch(`# a\n%x *= %t\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple /= with numeric RHS', () => {
      expect(mismatch(`# a\n%x /= 5\n---\n`)).toHaveLength(0);
    });

    it('does not flag tuple /= with tuple RHS', () => {
      expect(mismatch(`# a\n%x /= %t\n---\n`)).toHaveLength(0);
    });

    it('flags tuple -= with string literal RHS', () => {
      expect(mismatch(`# a\n%x -= 'str'\n---\n`)).toHaveLength(1);
    });

    it('flags tuple *= with string literal RHS', () => {
      expect(mismatch(`# a\n%x *= 'str'\n---\n`)).toHaveLength(1);
    });

    it('flags tuple /= with string literal RHS', () => {
      expect(mismatch(`# a\n%x /= 'str'\n---\n`)).toHaveLength(1);
    });

    it('does not flag tuple to tuple variable', () => {
      expect(mismatch(`# a\n%x = %t\n---\n`)).toHaveLength(0);
    });

    it('does not flag bracket_tuple to tuple variable', () => {
      expect(mismatch(`# a\n%x = [1, 2, 3]\n---\n`)).toHaveLength(0);
    });

    it('does not flag polymorphic function call matching LHS prefix', () => {
      // $iif() is called with $ prefix → returns string; assigned to $x → fine
      expect(mismatch(`# a\n$x = $iif(1, 'a', 'b')\n---\n`)).toHaveLength(0);
    });

    // ── Indexed writes ──────────────────────────────────────────────
    // The slot value isn't tracked, but the prefix lens at the write
    // site IS — so type-mismatch checks apply just like scalar writes.

    it('flags numeric indexed write of a string literal', () => {
      // x[0] = 'val' — `#x[0]` ← `$` value
      expect(mismatch(`# a\nx[0] = 'val'\n---\n`)).toHaveLength(1);
    });

    it('flags string indexed write of a numeric literal', () => {
      // $arr[0] = 5 — `$arr[0]` ← `#` value
      expect(mismatch(`# a\n$arr[0] = 5\n---\n`)).toHaveLength(1);
    });

    it('flags numeric indexed write of a $-prefixed var-ref', () => {
      // arr[0] = $b — write lens `#` ← read lens `$`
      // (Mirrors how `arr = $b` is already flagged for non-indexed.)
      expect(mismatch(`# a\narr[0] = $b\n---\n`)).toHaveLength(1);
    });

    it('flags numeric indexed write of an indexed $-prefixed read', () => {
      // arr[0] = $b[0] — write lens `#` ← read lens `$`
      expect(mismatch(`# a\narr[0] = $b[0]\n---\n`)).toHaveLength(1);
    });

    it('flags numeric indexed write of a tuple', () => {
      // arr[0] = [1, 2] — write lens `#` ← `%`
      expect(mismatch(`# a\narr[0] = [1, 2]\n---\n`)).toHaveLength(1);
    });

    it('does not flag matching-prefix indexed writes', () => {
      expect(mismatch(`# a\n$arr[0] = 'v'\n---\n`)).toHaveLength(0);
      expect(mismatch(`# a\n#arr[0] = 5\n---\n`)).toHaveLength(0);
      expect(mismatch(`# a\n%arr[0] = [1, 2]\n---\n`)).toHaveLength(0);
    });

    it('flags indexed RHS read with mismatched prefix', () => {
      // $a = b[0] — read of `b[0]` is numeric (no prefix), assigned to $a
      expect(mismatch(`# a\n$x = b[0]\n---\n`)).toHaveLength(1);
    });

    it('does not flag indexed RHS read with matching prefix', () => {
      // $a = $b[0] — read coerces slot to string, assigned to $a
      expect(mismatch(`# a\n$x = $b[0]\n---\n`)).toHaveLength(0);
    });

    it('flags indexed LHS = indexed RHS with conflicting prefixes', () => {
      // $a[0] = #b[0] — string slot ← numeric slot
      expect(mismatch(`# a\n$arr[0] = #b[0]\n---\n`)).toHaveLength(1);
    });

    it('flags local indexed write with mismatched RHS', () => {
      expect(mismatch(`# a\nlocal $arr[0] = 5\n---\n`)).toHaveLength(1);
    });

    it('does not flag when type is disabled', () => {
      const diags = run(`# a\n$x = 44\n---\n`, { typeMismatch: false });
      expect(diags.filter(d => d.message.startsWith('Type mismatch'))).toHaveLength(0);
    });

    // ── code-block RHS — typed as string ──────────────────────────
    // `dynamic`/`dyneval` consume `{…}` as strings, and `$x = {…}` is
    // the canonical storage form, so a code-block RHS should match
    // string LHS but mismatch numeric/tuple LHS.
    it('does not flag code-block assigned to string variable', () => {
      expect(mismatch(`# a\n$x = {y+1}\n---\n`)).toHaveLength(0);
    });

    it('flags code-block assigned to numeric variable', () => {
      expect(mismatch(`# a\nx = {y+1}\n---\n`)).toHaveLength(1);
    });

    it('flags code-block assigned to #-prefixed numeric variable', () => {
      expect(mismatch(`# a\n#x = {y+1}\n---\n`)).toHaveLength(1);
    });

    it('flags code-block assigned to tuple variable', () => {
      expect(mismatch(`# a\n%x = {y+1}\n---\n`)).toHaveLength(1);
    });

    it('flags code-block compound += into numeric variable', () => {
      expect(mismatch(`# a\n#x += {y+1}\n---\n`)).toHaveLength(1);
    });

    it('does not flag code-block compound += into string variable', () => {
      expect(mismatch(`# a\n$x += {y+1}\n---\n`)).toHaveLength(0);
    });

    it('flags numeric indexed write of a code-block', () => {
      expect(mismatch(`# a\narr[0] = {y+1}\n---\n`)).toHaveLength(1);
    });

    it('does not flag string indexed write of a code-block', () => {
      expect(mismatch(`# a\n$arr[0] = {y+1}\n---\n`)).toHaveLength(0);
    });

    it('flags local code-block assigned to numeric local', () => {
      expect(mismatch(`# a\nlocal x = {y+1}\n---\n`)).toHaveLength(1);
    });
  });
});
