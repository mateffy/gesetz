// ─── Core types ───────────────────────────────────────────────────────────────
export type {
  Violation,
  Rule,
  Check,
  File,
  Severity,
  ViolationSource,
  Exemption,
  RuleCategory,
  RuleGuidance,
} from './engine/rule';

// ─── Tagged errors ────────────────────────────────────────────────────────────
export {
  FileReadError,
  GlobError,
  RuleError,
  PhpstanError,
  ExecError,
  ReporterError,
} from './engine/errors';

// ─── Config ───────────────────────────────────────────────────────────────────
export { defineConfig } from './engine/config';
export type { UserConfig, ResolvedConfig, CategoryThreshold } from './engine/config';

// ─── Runner ───────────────────────────────────────────────────────────────────
export { runAll, applyExemptions } from './engine/runner';
export type { RunResult, RuleResult, CategoryScore } from './engine/runner';

// ─── Exec helpers ─────────────────────────────────────────────────────────────
export { execTool, runWithTempFile, extractLocation } from './engine/exec';

// ─── Services ─────────────────────────────────────────────────────────────────
export { FileSystem, FileSystemLive, MemoryFileSystem, ProjectRoot, ProjectRootLive, FileFilter, FileFilterLive } from './services/fs';
export type { GlobOptions, FileSystemService, FileFilterService } from './services/fs';

// SyntaxTree — abstract tag + router factory. Live backends: /typescript, /php, /python
export { SyntaxTree, SyntaxTreeLive, SyntaxTreeStub, SyntaxTreeError } from './services/syntax-tree';
export type {
  SyntaxBackend,
  ParsedImport,
  ParsedCall,
  ParsedExport,
  StructureItem,
  SyntaxBackendProcessResult,
  SyntaxTreeProcessOptions,
  SyntaxTreeService,
} from './services/syntax-tree';

// ImportResolver — abstract tag + default relative-path resolver
export { ImportResolver, ImportResolverDefault, ImportResolveError } from './services/import-resolver';
export type { ImportResolverService } from './services/import-resolver';

// ─── Select DSL ───────────────────────────────────────────────────────────────
export { select, slugify } from './primitives/select';
export type { Selector } from './primitives/select';

// ─── Primitive checks (language-agnostic) ─────────────────────────────────────
export { requireSibling, requireChildren, forbidFile } from './primitives/checks/fs';
export { noImportFrom, requireImportFrom } from './primitives/checks/imports';
export { noPattern, requirePattern } from './primitives/checks/patterns';
export {
  noGodFile,
  noDeepNesting,
  noDebuggingResidueFiles,
  noHardcodedSecret,
} from './primitives/checks/structure';

// ─── New structural primitives (SyntaxTree-backed) ────────────────────────────
export { noDebugLogging } from './primitives/checks/debug-logging';
export type { NoDebugLoggingOptions } from './primitives/checks/debug-logging';

export { noDirectCalls } from './primitives/checks/calls';
export type { NoDirectCallsOptions } from './primitives/checks/calls';

export { requireNamingConvention, noForbiddenNames } from './primitives/checks/naming';
export type { RequireNamingConventionOptions, NoForbiddenNamesOptions } from './primitives/checks/naming';

export { requireDocstrings } from './primitives/checks/docstrings';
export type { RequireDocstringsOptions } from './primitives/checks/docstrings';

export { requireExportsMatching, requireRelatedExports } from './primitives/checks/exports';
export type { RequireExportsMatchingOptions, RequireRelatedExportsOptions } from './primitives/checks/exports';

export { requireMinStructureCount } from './primitives/checks/structure-count';
export type { RequireMinStructureCountOptions } from './primitives/checks/structure-count';

// ─── Dependency graph ─────────────────────────────────────────────────────────
export { noCycles } from './primitives/graph';

// ─── Architecture ─────────────────────────────────────────────────────────────
export { defineArchitecture } from './architecture';
export type { ArchitectureConfig, ArchitectureLayer, ForbiddenImport } from './architecture';
