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
  TsAdapterError,
  PhpAdapterError,
  ReporterError,
} from './engine/errors';

// ─── Config ───────────────────────────────────────────────────────────────────
export { defineConfig } from './engine/config';
export type { UserConfig, ResolvedConfig, CategoryThreshold } from './engine/config';

// ─── Runner ───────────────────────────────────────────────────────────────────
export { runAll, applyExemptions } from './engine/runner';
export type { RunResult, RuleResult, CategoryScore } from './engine/runner';

// ─── Services ─────────────────────────────────────────────────────────────────
export { FileSystem, FileSystemLive, MemoryFileSystem, ProjectRoot, ProjectRootLive, FileFilter, FileFilterLive } from './services/fs';
export type { GlobOptions, FileSystemService, FileFilterService } from './services/fs';

// TsAdapter — abstract tag + stub. Live implementation: /typescript
export { TsAdapter, TsAdapterStub } from './services/ts-adapter';
export type { TsSourceFile, TsAdapterService } from './services/ts-adapter';

// PhpAdapter — abstract tag + stub. Live implementation: /php
export { PhpAdapter, PhpAdapterStub } from './services/php-adapter';
export type { PhpSyntaxNode, PhpAdapterService } from './services/php-adapter';

// ─── Select DSL ───────────────────────────────────────────────────────────────
export { select, slugify } from './primitives/select';
export type { Selector } from './primitives/select';

// ─── Primitive checks (language-agnostic) ─────────────────────────────────────
export { requireSibling, requireChildren, forbidFile, relativeImports } from './primitives/checks/fs';
export { noImportFrom, requireImportFrom } from './primitives/checks/imports';
export { noPattern, requirePattern } from './primitives/checks/patterns';
export {
  noGodFile,
  noDeepNesting,
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  noDebuggingResidueFiles,
  noHardcodedSecret,
} from './primitives/checks/structure';

// ─── Dependency graph ─────────────────────────────────────────────────────────
export { noCycles } from './primitives/graph';

// ─── Architecture ─────────────────────────────────────────────────────────────
export { defineArchitecture } from './architecture';
export type { ArchitectureConfig, ArchitectureLayer, ForbiddenImport } from './architecture';
