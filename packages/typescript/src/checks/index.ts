// TypeScript AST checks — one concern per file.
export { requireExportPairs, requireExportFactories } from './export-pairs';
export { requireCallShape } from './call-shape';
export { noFunctionCalls } from './function-calls';
export { noLiteralJsxText, noLiteralJsxProp, noJsxElements } from './jsx';
export { noHardcodedStrings, DEFAULT_TEXT_ATTRIBUTES } from './i18n';
export type { NoHardcodedStringsOptions } from './i18n';
export { requireImportBoundary } from './import-boundary';
export { noLocalFunctionComponents } from './local-components';
export { noObjectProperty, noCrossModuleImports } from './content-checks';
export { requireDirectoryStructure } from './directory-structure';
export { requireMinTestScore } from './test-score';
export type { TestScoring } from './test-score';
