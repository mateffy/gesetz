// TypeScript AST checks — one concern per file.
export { requireRelatedExports, requireExportsMatching } from './require-related-exports';
export { requireOptionsObject } from './require-options-object';
export type { RequireOptionsObjectOptions } from './require-options-object';
export { noFunctionCalls } from './function-calls';
export { noLiteralJsxText, noLiteralJsxProp, noJsxElements } from './jsx';
export { noHardcodedStrings, DEFAULT_TEXT_ATTRIBUTES } from './i18n';
export type { NoHardcodedStringsOptions } from './i18n';
export { noLocalFunctionComponents } from './local-components';
export { noObjectProperty } from './content-checks';
export { requireDirectoryStructure } from './directory-structure';
export { requireMinTestScore } from './test-score';
export type { TestScoring } from './test-score';

// Moved from @gesetz/core (TypeScript/JavaScript-specific):
export { noConsoleLog } from './no-console-log';
export type { NoConsoleLogOptions } from './no-console-log';
export { noEmptyCatch } from './no-empty-catch';
export type { NoEmptyCatchOptions } from './no-empty-catch';
export { noMagicNumbers } from './no-magic-numbers';
export type { NoMagicNumbersOptions } from './no-magic-numbers';
export { noTrivialComment } from './no-trivial-comment';
export type { NoTrivialCommentOptions } from './no-trivial-comment';
export { relativeImports } from './relative-imports';

// New checks (ast-grep / SyntaxBackend based, no ts-morph):
export { noTypedAny } from './no-typed-any';
export type { NoTypedAnyOptions } from './no-typed-any';
export { noAsUnknownAs } from './no-as-unknown-as';
export type { NoAsUnknownAsOptions } from './no-as-unknown-as';
export { noDefaultExport } from './no-default-export';
export type { NoDefaultExportOptions } from './no-default-export';
export { noEnum } from './no-enum';
export type { NoEnumOptions } from './no-enum';
export { noBarrelFile } from './no-barrel-file';
export type { NoBarrelFileOptions } from './no-barrel-file';
export { requireExplicitReturnType } from './require-explicit-return-type';
export type { RequireExplicitReturnTypeOptions } from './require-explicit-return-type';
// noFloatingPromises is intentionally NOT provided here — it requires the
// TypeScript type checker. Use @gesetz/eslint or @gesetz/oxlint instead.
