// Re-export the ts-morph type we expose
export type { TsSourceFile } from '@gesetz/core';

// Live TsAdapter implementation (requires ts-morph)
export { TsAdapterLive } from './adapter';

// TypeScript check primitives
export {
  requireExportPairs,
  requireExportFactories,
  requireCallShape,
  noFunctionCalls,
  noLiteralJsxText,
  noLiteralJsxProp,
  noJsxElements,
  noHardcodedStrings,
  DEFAULT_TEXT_ATTRIBUTES,
  requireImportBoundary,
  noLocalFunctionComponents,
  noObjectProperty,
  noCrossModuleImports,
  requireDirectoryStructure,
  requireMinTestScore,
} from './checks';
export type { TestScoring, NoHardcodedStringsOptions } from './checks';
