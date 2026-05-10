/**
 * Per-location symbol diagnostics.
 *
 * Checks that reason about labels, actions, objects, and references
 * within a single location block: duplicates, unresolved refs, unused
 * definitions, invalid function-prefix usage, wrong argument counts,
 * and mixed call-type patterns.
 */


import { DiagnosticSeverity } from 'vscode-languageserver';
import {
  type LocationSymbols,
  type QspSymbol,
} from '../../parser';
import { DiagnosticCtx, mapPush } from './diagnosticHelpers';

// ── Labels ────────────────────────────────────────────────────────────

/**
 * Duplicate label names within the same label namespace.
 *
 * QSP labels are scoped to the nearest enclosing label-isolating
 * construct (act body, stored or dynamic code_block, or location
 * root): a `jump` can only reach labels in its own namespace.
 *
 * Labels are bucketed by their namespace key in {@link LocationSymbols.labels},
 * so a duplicate is simply a bucket entry whose `references[]` has
 * more than one entry — every entry is a definition site within the
 * same namespace.
 */
/**
 * Unreachable labels: a `:label` that does not begin a line — e.g.
 * the body of an inline `if` / `loop` / `act`, or a label after `&`
 * in a `&`-chain.  The grammar accepts these, but the QSP runtime
 * only recognizes labels at the start of a line.  The walker records
 * such positions in `LocationSymbols.unreachableLabels`; we surface them
 * here as warnings so the author knows the label is unreachable.
 */
export function checkUnreachableLabels(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const loc of locSyms.unreachableLabels) {
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(loc),
      'Label is not at the start of a line and will not be recognized'
      + ' at runtime.',
    );
  }
}

export function checkDuplicateLabels(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const label of locSyms.allLabelSymbols()) {
    if (label.references.length <= 1) continue;
    for (const ref of label.references) {
      const others = label.references.filter(r => r !== ref);
      const otherLines = others.map(r => r.line + 1).join(', ');
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.locRange(ref),
        `Duplicate label '${label.name}' in location '${locSyms.locationName}'`
        + ` (also at line ${otherLines})`,
      );
    }
  }
}

/**
 * Unresolved label refs: each `jump` is checked against the labels
 * visible in its own label-namespace (the nearest enclosing isolated
 * scope — act body, code_block, or location root).  A `jump` inside
 * an `act` cannot reach a label outside it, and vice-versa.
 *
 * Both `labels` and `labelRefs` are bucketed by namespace root, so
 * iterating `labelRefs` yields one bucket per root: a ref is unresolved
 * iff `labels.get(root)` lacks the same name.
 */
export function checkUnresolvedLabelRefs(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const [root, refBucket] of locSyms.labelRefs) {
    const defBucket = locSyms.labels.get(root);
    for (const [name, ref] of refBucket) {
      if (defBucket?.has(name)) continue;
      for (const r of ref.references) {
        ctx.push(
          DiagnosticSeverity.Warning,
          ctx.locRange(r),
          `Label '${ref.name}' is not defined in location '${locSyms.locationName}'`,
        );
      }
    }
  }
}

/**
 * Unused labels: a label definition is unused when no `jump` in the
 * same label-namespace targets it.  With per-root buckets, a label is
 * unused iff `labelRefs.get(root)` lacks the same name.
 */
export function checkUnusedLabels(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const [root, defBucket] of locSyms.labels) {
    const refBucket = locSyms.labelRefs.get(root);
    for (const [name, label] of defBucket) {
      if (refBucket?.has(name)) continue;
      // `label.references` holds every definition site of this name
      // within the same namespace bucket (duplicates inside the same
      // root are appended by `addLabel`).
      for (const def of label.references) {
        ctx.push(
          DiagnosticSeverity.Information,
          ctx.locRange(def),
          `Label '${label.name}' is defined but never targeted by jump in`
          + ` location '${locSyms.locationName}'`,
          true,  // unnecessary
        );
      }
    }
  }
}

// ── Actions ───────────────────────────────────────────────────────────

/** Duplicate action names within a location. */
export function checkDuplicateActions(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  const actGroups = new Map<string, QspSymbol[]>();
  for (const act of locSyms.actions) mapPush(actGroups, act.nameLower, act);
  for (const [, group] of actGroups) {
    if (group.length <= 1) continue;
    for (const act of group) {
      const others = group.filter(a => a !== act);
      const otherLines = others.map(a => a.definition!.line + 1).join(', ');
      ctx.push(
        DiagnosticSeverity.Information,
        ctx.locRange(act.definition!),
        `Duplicate action '${act.name}' in location '${locSyms.locationName}'`
        + ` (also at line ${otherLines})`,
      );
    }
  }
}

/** Unresolved action refs (delact) with no matching act definition
 *  anywhere in the project/file. */
export function checkUnresolvedActionRefs(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  definedActions: ReadonlySet<string>,
): void {
  for (const [, ref] of locSyms.actionRefs) {
    if (definedActions.has(ref.nameLower)) continue;
    for (const r of ref.references) {
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.locRange(r),
        `Action '${ref.name}' is referenced but never defined`,
      );
    }
  }
}

// ── Locations ─────────────────────────────────────────────────────────

/** Unresolved location refs (gs/func/goto) targeting undefined locations. */
export function checkUnresolvedLocationRefs(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  allLocationDefs: ReadonlyMap<string, QspSymbol>,
  isProject: boolean,
): void {
  for (const [, ref] of locSyms.locationRefs) {
    if (allLocationDefs.has(ref.nameLower)) continue;
    for (const r of ref.references) {
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.locRange(r),
        isProject
          ? `Location '${ref.name}' is not defined in the project`
          : `Location '${ref.name}' is not defined in this file`,
      );
    }
  }
}

/** Mixed call types: a location is called as both func and gosub/goto. */
export function checkMixedCallTypes(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  callTypesPerTarget: ReadonlyMap<string, { name: string; types: Set<string> }>,
): void {
  const typeLabels: Record<string, string> = {
    func: 'function (func/@)',
    gosub: 'subroutine (gosub/gs/@@)',
    goto: 'goto (goto/gt/xgoto/xgt)',
    desc: 'description (desc)',
  };
  for (const [key, ref] of locSyms.locationRefs) {
    const entry = callTypesPerTarget.get(key);
    if (!entry || entry.types.size <= 1) continue;
    const labels = [...entry.types].sort().map(t => typeLabels[t] ?? t).join(' and ');
    for (const r of ref.references) {
      if (!r.callType) continue;
      ctx.push(
        DiagnosticSeverity.Information,
        ctx.locRange(r),
        `Location '${entry.name}' is called as both ${labels}`,
      );
    }
  }
}

// ── Objects ───────────────────────────────────────────────────────────

/** Unresolved object refs (delobj, modobj, obj operator) with no
 *  matching addobj. */
export function checkUnresolvedObjectRefs(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  definedObjects: ReadonlySet<string>,
): void {
  for (const [, ref] of locSyms.objectRefs) {
    if (ref.definition) continue;
    if (definedObjects.has(ref.nameLower)) continue;
    for (const r of ref.references) {
      ctx.push(
        DiagnosticSeverity.Warning,
        ctx.locRange(r),
        `Object '${ref.name}' is referenced but never added`,
      );
    }
  }
}

/** Unused objects: added (addobj) but never referenced. */
export function checkUnusedObjects(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  referencedObjects: ReadonlySet<string>,
): void {
  for (const [key, obj] of locSyms.objectRefs) {
    if (!obj.definition) continue;
    if (referencedObjects.has(key)) continue;
    ctx.push(
      DiagnosticSeverity.Information,
      ctx.locRange(obj.definition),
      `Object '${obj.name}' is added but never referenced`,
      true,
    );
  }
}

// ── Function calls ────────────────────────────────────────────────────

/** Invalid function type-prefix: a built-in called with a prefix it
 *  doesn't support. */
export function checkInvalidFunctionPrefix(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const pw of locSyms.prefixWarnings) {
    const prefixNames = pw.validPrefixes.split('').join(', ');
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(pw.loc),
      `Function '${pw.funcName}' does not support the '${pw.prefix}' prefix`
      + ` (valid: ${prefixNames})`,
    );
  }
}

/** Wrong number of positional arguments to a built-in statement/function. */
export function checkInvalidArgCount(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const aw of locSyms.argCountWarnings) {
    const expected = aw.max === undefined
      ? `at least ${aw.min}`
      : aw.min === aw.max
        ? `${aw.min}`
        : `${aw.min} to ${aw.max}`;
    const noun = aw.actual === 1 ? 'argument' : 'arguments';
    const kindLabel = aw.kind === 'statement' ? 'Statement' : 'Function';
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(aw.loc),
      `${kindLabel} '${aw.name}' expects ${expected} arguments, got ${aw.actual} ${noun}`,
    );
  }
}

/** Deprecated/outdated built-in statement or function calls. */
export function checkDeprecatedBuiltins(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const dw of locSyms.deprecationWarnings) {
    const kindLabel = dw.kind === 'statement' ? 'Statement' : 'Function';
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(dw.loc),
      `${kindLabel} '${dw.name.toUpperCase()}' is outdated; use '${dw.replacement.toUpperCase()}' instead`,
      false,
      true,  // deprecated tag (strikethrough in editors)
    );
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────

/** Run all per-location symbol diagnostics for one location. */
export function checkLocationSymbols(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  allLocationDefs: ReadonlyMap<string, QspSymbol>,
  definedActions: ReadonlySet<string>,
  definedObjects: ReadonlySet<string>,
  referencedObjects: ReadonlySet<string>,
  callTypesPerTarget: ReadonlyMap<string, { name: string; types: Set<string> }>,
  isProject: boolean,
): void {
  if (ctx.settings.duplicateLabels)            checkDuplicateLabels(ctx, locSyms);
  if (ctx.settings.duplicateActions)           checkDuplicateActions(ctx, locSyms);
  if (ctx.settings.unreachableLabels)          checkUnreachableLabels(ctx, locSyms);
  if (ctx.settings.unresolvedLocationRefs)     checkUnresolvedLocationRefs(ctx, locSyms, allLocationDefs, isProject);
  if (ctx.settings.unresolvedLabelRefs)        checkUnresolvedLabelRefs(ctx, locSyms);
  if (ctx.settings.unresolvedActionRefs)       checkUnresolvedActionRefs(ctx, locSyms, definedActions);
  if (ctx.settings.unresolvedObjectRefs)       checkUnresolvedObjectRefs(ctx, locSyms, definedObjects);
  if (ctx.settings.unusedLabels)               checkUnusedLabels(ctx, locSyms);
  if (ctx.settings.unusedObjects)              checkUnusedObjects(ctx, locSyms, referencedObjects);
  if (ctx.settings.invalidFunctionPrefix)      checkInvalidFunctionPrefix(ctx, locSyms);
  if (ctx.settings.invalidBuiltinArgCount)     checkInvalidArgCount(ctx, locSyms);
  if (ctx.settings.mixedLocationCallTypes)     checkMixedCallTypes(ctx, locSyms, callTypesPerTarget);

  checkDeprecatedBuiltins(ctx, locSyms);
}
