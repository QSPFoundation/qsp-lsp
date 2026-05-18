export { buildLocationIndex, findLocationAtLine, findLocationByName, getLocationText } from '../common/locations';
export type { LocationEntry } from '../common/locations';
export { ALL_BUILTINS, QSP_FUNCTIONS, QSP_KEYWORDS, QSP_STATEMENTS, QSP_VARIABLES, lookupBuiltin, lookupValidPrefixes, lookupArgConstraints, lookupDeprecated } from './builtins';
export type { BuiltinInfo } from './builtins';
export { DocumentSymbols, LocationSymbols, QspSymbolKind } from './symbolTable';
export type { PrefixWarning, ArgCountWarning, DeprecationWarning, QspSymbol, SymbolLocation } from './symbolTable';
export { QspTreeSitterParser, computeTreeEdit } from './treeSitter';
export type { WasmLoader, WasmDirProvider } from './treeSitter';
export { extractErrors, hasStructuralErrors } from './extractErrors';
export type { SyntaxError } from './extractErrors';
export { extractSymbols, isVariableDefinition } from './extractSymbols';
export { findBlockKeywordRanges } from './blockKeywords';
export type { KeywordRange } from './blockKeywords';
export {
  getPossibleValuesAtCursor,
  splitVarKey,
  parseVarStringArg,
  resolvePossibleValuesInDocument,
  resolvePossibleValuesAcrossProject,
} from './variableBindings';
export type {
  CursorValueEntry,
  CursorValueOptions,
  PossibleValueEntry,
  TypePrefix,
  VarResolverCallGraph,
} from './variableBindings';
export { ARGS_VAR_NAME, RESULT_VAR_NAME, CALL_FRAME_BUILTINS } from './lookupTables';
export type {
  BindingValue,
  VariableBinding,
} from './symbolTable';
