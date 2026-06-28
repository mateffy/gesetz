// SyntaxBackend for TypeScript/JavaScript (oxc-parser + @ast-grep/napi).
export { typescriptSyntaxBackend } from './syntax-backend';

// TypeScript check primitives
export {
  requireRelatedExports,
  requireExportsMatching,
  requireOptionsObject,
  noFunctionCalls,
  noLiteralJsxText,
  noLiteralJsxProp,
  noJsxElements,
  noHardcodedStrings,
  DEFAULT_TEXT_ATTRIBUTES,
  noLocalFunctionComponents,
  noObjectProperty,
  requireDirectoryStructure,
  requireMinTestScore,
  // Moved from @gesetz/core:
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  relativeImports,
  // New checks:
  noTypedAny,
  noAsUnknownAs,
  noDefaultExport,
  noEnum,
  noBarrelFile,
  requireExplicitReturnType,
} from './checks';
export type {
  NoHardcodedStringsOptions,
  TestScoring,
  RequireOptionsObjectOptions,
  NoConsoleLogOptions,
  NoEmptyCatchOptions,
  NoMagicNumbersOptions,
  NoTrivialCommentOptions,
  NoTypedAnyOptions,
  NoAsUnknownAsOptions,
  NoDefaultExportOptions,
  NoEnumOptions,
  NoBarrelFileOptions,
  RequireExplicitReturnTypeOptions,
} from './checks';
