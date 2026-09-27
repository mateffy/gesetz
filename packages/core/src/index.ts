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
  BaselineMessageMode,
} from './engine/rule';

// ─── Tagged errors ────────────────────────────────────────────────────────────
export {
  FileReadError,
  GlobError,
  RuleError,
  PhpstanError,
  ExecError,
  ReporterError,
  BaselineFileError,
} from './engine/errors';

// ─── Config ───────────────────────────────────────────────────────────────────
export { defineConfig } from './engine/config';
export type {
  UserConfig,
  ResolvedConfig,
  CategoryThreshold,
  BaselineConfig,
  GesetzStorageConfig,
} from './engine/config';

// ─── Runner ───────────────────────────────────────────────────────────────────
export { runAll, applyExemptions } from './engine/runner';
export type {
  RunResult,
  RuleResult,
  CategoryScore,
  RunAllOptions,
  ScanStats,
} from './engine/runner';

// ─── Violation baseline ───────────────────────────────────────────────────────
export {
  BASELINE_FILE_NAME,
  BASELINE_FILE_VERSION,
  STALE_RULE_ID,
  buildBaselineFile,
  normalizeMessage,
  normalizePath,
  violationHash,
} from './engine/baseline';
export type { BaselineEntry, BaselineFile, BaselineViolationGroup } from './engine/baseline';
export {
  baselinePathFor,
  readBaselineFile,
  serializeBaseline,
  writeBaselineFile,
} from './engine/baseline-file';
export { partitionByBaseline, planBaselineWrite } from './engine/baseline-apply';
export type {
  BaselinePartition,
  BaselinePartitionOptions,
  BaselineRefusal,
  BaselineRuleCounts,
  BaselineRuleDelta,
  BaselineStats,
  BaselineWritePlan,
} from './engine/baseline-apply';

// ─── Exec helpers ─────────────────────────────────────────────────────────────
export { execTool, runWithTempFile, extractLocation } from './engine/exec';
export { scopedPatterns, toolWatchPatterns } from './engine/tool-patterns';
export { DEFAULT_TEST_SUFFIXES, testFilesForPaths } from './backend/test-scope';
export type { TestScopeOptions } from './backend/test-scope';
export { listFiles, treeStateFor, treeStatesMatch } from './engine/file-set';
export type { TreeState } from './engine/file-set';
export {
  coordinateRun,
  coordDirFor,
  countWaiters,
  findReusableRecord,
  readRecords,
  registerWaiter,
  writeRecord,
} from './engine/run-lock';
export type {
  CoordinateOptions,
  CoordinationEvent,
  CoordinationMode,
  CoordinationOutcome,
  RunRecord,
} from './engine/run-lock';

// ─── Services ─────────────────────────────────────────────────────────────────
export {
  FileSystem,
  FileSystemLive,
  MemoryFileSystem,
  ProjectRoot,
  ProjectRootLive,
  FileFilter,
  FileFilterLive,
} from './services/fs';
export type { GlobOptions, FileSystemService, FileFilterService } from './services/fs';

// SyntaxTree — abstract tag + router factory. Live backends: /typescript, /php, /python
export {
  SyntaxTree,
  SyntaxTreeLive,
  SyntaxTreeStub,
  SyntaxTreeError,
} from './services/syntax-tree';
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
export {
  ImportResolver,
  ImportResolverDefault,
  ImportResolveError,
} from './services/import-resolver';
export type { ImportResolverService } from './services/import-resolver';

// ─── Select DSL ───────────────────────────────────────────────────────────────
export { select, slugify } from './primitives/select';
export type { Selector } from './primitives/select';

// ─── Check types ─────────────────────────────────────────────────────────────
export type {
  CheckServices,
  ProjectRuleContext,
  ProjectRuleOutcome,
  ProjectRuleResult,
} from './engine/rule';

// ─── Test helpers ─────────────────────────────────────────────────────────────
export { makeFile, makeCheckServices, runCheck } from './test-helpers';
export type { MakeCheckServicesOptions } from './test-helpers';

// ─── Primitive checks (language-agnostic) ─────────────────────────────────────
export {
  requireSibling,
  requireChildren,
  requireTest,
  forbidFile,
  relativeImports,
  testCandidates,
} from './primitives/checks/fs';
export type { RequireTestOptions } from './primitives/checks/fs';
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
export type {
  RequireNamingConventionOptions,
  NoForbiddenNamesOptions,
} from './primitives/checks/naming';

export { requireDocstrings } from './primitives/checks/docstrings';
export type { RequireDocstringsOptions } from './primitives/checks/docstrings';

export { requireExportsMatching, requireRelatedExports } from './primitives/checks/exports';
export type {
  RequireExportsMatchingOptions,
  RequireRelatedExportsOptions,
} from './primitives/checks/exports';

export { requireMinStructureCount } from './primitives/checks/structure-count';
export type { RequireMinStructureCountOptions } from './primitives/checks/structure-count';

// ─── Dependency graph ─────────────────────────────────────────────────────────
export { noCycles } from './primitives/graph';

// ─── Architecture ─────────────────────────────────────────────────────────────
export { defineArchitecture } from './architecture';
export type { ArchitectureConfig, ArchitectureLayer, ForbiddenImport } from './architecture';
