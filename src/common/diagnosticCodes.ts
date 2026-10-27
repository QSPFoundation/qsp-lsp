// ── Diagnostic codes ─────────────────────────────────────────────────
//
// Every QSP diagnostic carries one of these as its `code`. A code is the
// name of the check's `qsp.diagnostics.<code>` setting, so the Problems
// panel, `!@qsp-ignore` comments and the "turn off" quick fix all name a
// check the same way. Pure: shared by the server and the suppression parser.

/** Checks with a `qsp.diagnostics.<code>` setting. */
export const CHECK_CODES = [
  'duplicateLocations',
  'duplicateLabels',
  'duplicateActions',
  'unreachableLabels',
  'unclosedLocations',
  'uninitializedVariables',
  'unresolvedLocationRefs',
  'unresolvedLabelRefs',
  'unresolvedActionRefs',
  'unresolvedObjectRefs',
  'unusedLocations',
  'unusedLabels',
  'unusedVariables',
  'unusedObjects',
  'invalidFunctionPrefix',
  'systemVariablePrefix',
  'unsupportedSyntax',
  'invalidBuiltinArgCount',
  'deprecatedBuiltins',
  'mixedVariablePrefixes',
  'typeMismatch',
  'mixedLocationCallTypes',
  'inconsistentLocalPropagation',
  'untrackedDynamicCalls',
  'missingResultInFunctionCall',
  'extraArgsToTargetWithoutArgs',
  'shadowsCallFrameBuiltin',
  'shadowsPropagatedLocal',
  'maxLocationLines',
] as const;

/**
 * Codes without a setting of their own: syntax errors, a mistake in a
 * `!@qsp-ignore` comment, and the note that a file's list was cut short.
 */
export const OTHER_CODES = ['syntax', 'suppression', 'maxPerFile'] as const;

export type CheckCode = typeof CHECK_CODES[number];
export type DiagnosticCode = CheckCode | typeof OTHER_CODES[number];

/** Codes a `!@qsp-ignore` comment may name. */
export const SUPPRESSIBLE_CODES: ReadonlySet<string> = new Set<string>(
  CHECK_CODES.filter(c => c !== 'duplicateLocations'),
);

/**
 * Never hidden by a comment: a syntax error breaks the game, and the build
 * stops on a duplicate location name anyway, so hiding either would only
 * hide why.
 */
export const UNSUPPRESSIBLE_CODES: ReadonlySet<string> = new Set<string>(['syntax', 'duplicateLocations', 'suppression', 'maxPerFile']);

/** True for a code that has a `qsp.diagnostics.<code>` setting. */
export function isCheckCode(code: string): code is CheckCode {
  return (CHECK_CODES as readonly string[]).includes(code);
}
