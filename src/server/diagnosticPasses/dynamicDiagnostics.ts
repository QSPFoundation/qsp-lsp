/**
 * Dynamic/dyneval call diagnostics.
 *
 * Checks that reason about `dynamic` and `dyneval` calls whose first
 * argument is a variable holding a code block, or an expression that
 * can't be statically resolved to a known code block.
 */


import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  type DocumentSymbols,
  type LocationSymbols,
} from '../../parser';
import { DiagnosticCtx } from './diagnosticHelpers';

// ── Untracked dynamic/dyneval ─────────────────────────────────────────

/**
 * Flag dynamic/dyneval call sites where the first argument cannot be
 * statically resolved to a unique code block, meaning the block body
 * is not being analysed with caller-site locals.
 *
 *   • `multiple-assignments` — variable has ≥ 2 code-block assignments
 *     (or a mix of local + global).
 *   • `multiple-local-bindings` — variable has ≥ 2 distinct local
 *     code-block bindings in different scopes; runtime target depends
 *     on which scope is active.
 *   • `complex-expression` — first argument is not a bare variable ref
 *     or code-block literal.
 */
export function checkUntrackedDynamicCalls(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const u of locSyms.untrackedDynamicVarCalls) {
    let msg: string;
    if (u.reason === 'multiple-assignments') {
      msg = `'${u.varName}' is assigned multiple code blocks`
        + ` — the runtime target depends on which assignment last executed`;
    } else if (u.reason === 'multiple-local-bindings') {
      msg = `'${u.varName}' has multiple local code-block bindings`
        + ` — the runtime target depends on the call path`;
    } else {
      msg = `Cannot analyse dynamic block: first argument is not a code block literal`
        + ` or a variable with a known code-block binding`
        + ` — local variables and references inside it are not tracked`;
    }
    ctx.push(DiagnosticSeverity.Information, ctx.locRange(u.loc), msg);
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────

export function checkDynamicCalls(
  ctx: DiagnosticCtx,
  symbols: DocumentSymbols,
): void {
  for (const [, locSyms] of symbols.locations) {
    if (locSyms.hasErrors) continue;
    if (ctx.settings.untrackedDynamicCalls)      checkUntrackedDynamicCalls(ctx, locSyms);
  }
}
