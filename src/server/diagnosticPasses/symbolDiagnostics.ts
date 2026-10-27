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
  argCountsFor,
  lookupBuiltin,
} from '../../parser';
import type { SyntaxFeatureUse } from '../../parser/symbolTypes';
import { SYNTAX_VERSION_LABELS } from '../../common/syntaxVersion';
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
      { code: 'unreachableLabels' },
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
        { code: 'duplicateLabels', name: label.name },
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
          { code: 'unresolvedLabelRefs', name: ref.name },
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
          { code: 'unusedLabels', name: label.name, unnecessary: true },
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
        { code: 'duplicateActions', name: act.name },
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
        { code: 'unresolvedActionRefs', name: ref.name },
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
        { code: 'unresolvedLocationRefs', name: ref.name },
      );
    }
  }
}

/** Mixed call types: a location is called inconsistently (mix of func/gosub/goto/desc). */
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
        { code: 'mixedLocationCallTypes', name: entry.name },
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
        { code: 'unresolvedObjectRefs', name: ref.name },
      );
    }
  }
}

/** Unused objects: added (addobj) but never referenced. */
export function checkUnusedObjects(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
  referencedObjects: ReadonlySet<string>,
  namedInText: ReadonlySet<string> = new Set(),
): void {
  for (const [key, obj] of locSyms.objectRefs) {
    if (!obj.definition) continue;
    if (referencedObjects.has(key)) continue;
    // Its name is a value in the code (`$item = 'lamp'`, `gs 'drop', 'lamp'`): used through it.
    if (namedInText.has(key)) continue;
    ctx.push(
      DiagnosticSeverity.Information,
      ctx.locRange(obj.definition),
      `Object '${obj.name}' is added but never referenced`,
      { code: 'unusedObjects', name: obj.name, unnecessary: true },
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
      { code: 'invalidFunctionPrefix', name: pw.funcName },
    );
  }
}

/** A system variable written with a prefix of another type than it holds. */
export function checkSystemVariablePrefix(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  // 5.9.6 reads a system variable as the type it needs, whatever was
  // stored in it; 5.9.5 ignores a value of the other type.
  if (ctx.settings.syntaxVersion !== '5.9.5') return;
  for (const w of locSyms.systemVariablePrefixWarnings) {
    const holds = w.valueType === '$'
      ? `holds text: write it '$${w.varName}'`
      : `holds a number: write it '${w.varName}' or '#${w.varName}', not '${w.prefix}${w.varName}'`;
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(w.loc),
      `System variable '${w.varName}' ${holds}`,
      { code: 'systemVariablePrefix', name: w.varName },
    );
  }
}

const FEATURE_LABELS: Record<Exclude<SyntaxFeatureUse['feature'], 'builtin' | 'spaceAfterAt' | 'nameDelimiter' | 'reservedName'>, string> = {
  undefinedValue: "The undefined value '?'",
  unaryPlus: 'Unary plus',
  tabContinuation: "A tab before the '_' that joins lines",
};

/** Constructs the chosen syntax version doesn't have. */
export function checkUnsupportedSyntax(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  const version = ctx.settings.syntaxVersion;
  for (const fu of locSyms.syntaxFeatureUses) {
    let message: string;
    if (fu.feature === 'nameDelimiter') {
      if (version === '5.9.5') continue;
      const ch = /[\\;^@?]/.exec(fu.name!)![0];
      message = `'${ch}' ends a name in QSP ${SYNTAX_VERSION_LABELS[version]}: '${fu.name}' is not one name`;
    } else if (fu.feature === 'reservedName') {
      if (version === '5.9.5') continue;
      const isFunction = lookupBuiltin(fu.name!)?.kind === 'function';
      message = `'${fu.name}' ${isFunction ? 'is a function' : 'starts a statement'} in QSP ${SYNTAX_VERSION_LABELS[version]} and can't name a variable`;
    } else {
      if (version !== '5.9.5') continue;
      const what = fu.feature === 'builtin' ? fu.name!.toUpperCase()
        : fu.feature === 'spaceAfterAt' ? `A space after '${fu.name}'`
          : FEATURE_LABELS[fu.feature];
      message = `${what} is new in QSP 5.9.6; the syntax version is 5.9.5`;
    }
    ctx.push(
      DiagnosticSeverity.Error,
      ctx.locRange(fu.loc),
      message,
      { code: 'unsupportedSyntax', name: fu.name },
    );
  }
}

/** Wrong number of positional arguments to a built-in statement/function. */
export function checkInvalidArgCount(
  ctx: DiagnosticCtx,
  locSyms: LocationSymbols,
): void {
  for (const aw of locSyms.argCountWarnings) {
    const { min, max } = argCountsFor(aw.name, ctx.settings.syntaxVersion) ?? aw;
    if (aw.actual >= min && (max === undefined || aw.actual <= max)) continue;
    const expected = max === undefined
      ? `at least ${min}`
      : min === max
        ? `${min}`
        : `${min} to ${max}`;
    const noun = aw.actual === 1 ? 'argument' : 'arguments';
    const kindLabel = aw.kind === 'statement' ? 'Statement' : 'Function';
    ctx.push(
      DiagnosticSeverity.Warning,
      ctx.locRange(aw.loc),
      `${kindLabel} '${aw.name}' expects ${expected} arguments, got ${aw.actual} ${noun}`,
      { code: 'invalidBuiltinArgCount', name: aw.name },
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
      { code: 'deprecatedBuiltins', name: dw.name, deprecated: true },
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
  referencesIncomplete: boolean,
  namedInText: ReadonlySet<string> = new Set(),
): void {
  if (ctx.settings.duplicateLabels)            checkDuplicateLabels(ctx, locSyms);
  if (ctx.settings.duplicateActions)           checkDuplicateActions(ctx, locSyms);
  if (ctx.settings.unreachableLabels)          checkUnreachableLabels(ctx, locSyms);
  if (ctx.settings.unresolvedLocationRefs)     checkUnresolvedLocationRefs(ctx, locSyms, allLocationDefs, isProject);
  if (ctx.settings.unresolvedLabelRefs)        checkUnresolvedLabelRefs(ctx, locSyms);
  if (ctx.settings.unresolvedActionRefs)       checkUnresolvedActionRefs(ctx, locSyms, definedActions);
  if (ctx.settings.unresolvedObjectRefs)       checkUnresolvedObjectRefs(ctx, locSyms, definedObjects);
  if (ctx.settings.unusedLabels)               checkUnusedLabels(ctx, locSyms);
  if (ctx.settings.unusedObjects && !referencesIncomplete) checkUnusedObjects(ctx, locSyms, referencedObjects, namedInText);
  if (ctx.settings.invalidFunctionPrefix)      checkInvalidFunctionPrefix(ctx, locSyms);
  if (ctx.settings.systemVariablePrefix)       checkSystemVariablePrefix(ctx, locSyms);
  if (ctx.settings.unsupportedSyntax)          checkUnsupportedSyntax(ctx, locSyms);
  if (ctx.settings.invalidBuiltinArgCount)     checkInvalidArgCount(ctx, locSyms);
  if (ctx.settings.mixedLocationCallTypes)     checkMixedCallTypes(ctx, locSyms, callTypesPerTarget);

  if (ctx.settings.deprecatedBuiltins)         checkDeprecatedBuiltins(ctx, locSyms);
}
