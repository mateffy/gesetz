// ─── Core types ───────────────────────────────────────────────────────────────
export type { Check, CheckServices, Exemption, File, Rule, RuleCategory, RuleGuidance, Severity, ToolReplacement, Violation, ViolationSource } from './engine/rule';

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
export type { UserConfig, ResolvedConfig, CategoryThreshold, GesetzStorageConfig } from './engine/config';

// ─── Runner ───────────────────────────────────────────────────────────────────
export { runAll, applyExemptions } from './engine/runner';
export type { RunResult, RuleResult, CategoryScore, RunAllOptions, ScanStats } from './engine/runner';
export { narrowRunResult } from './engine/aggregate';
export { filterRules } from './backend/rule-filter';
export { resolveChangedFiles } from './engine/rule-execution';

// ─── Exec helpers ─────────────────────────────────────────────────────────────
export {
  execTool,
  execToolResult,
  runWithTempFile,
  extractLocation,
  resolveToolCwd,
  resolveToolBin,
} from './engine/exec';

// ─── Cache drivers ────────────────────────────────────────────────────────────
export {
  getCacheDriver,
  registerCacheDriver,
  unregisterCacheDriver,
  createSqliteStore,
  createSqliteStoreFromDatabase,
  isNodeSqliteAvailable,
  sqliteUnavailableMessage,
  DEFAULT_CACHE_TTL_MS,
  SQLITE_COMPAT_PACKAGE,
  SqliteUnavailableError,
} from './cache';
export type {
  CacheDriverFactory,
  CacheEntry,
  CacheStore,
  FileRef,
  SqliteDriver,
  SqliteLikeDatabase,
  SqliteLikeStatement,
  SqliteStoreOptions,
  SqliteStoreNamespaceOptions,
} from './cache';

// ─── Cache location ───────────────────────────────────────────────────────────
export { defaultCacheDir, defaultCachePath } from './engine/cache-path';

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
export { select, slugify, group } from './primitives/select';
export type { Selector, SelectOptions } from './primitives/select';

// ─── Check types ─────────────────────────────────────────────────────────────
export type {
  BaselineMessageMode,
  ProjectRuleContext,
  ProjectRuleOutcome,
  ProjectRuleResult,
} from './engine/rule';

// ─── Test helpers ─────────────────────────────────────────────────────────────
export { makeFile, makeCheckServices, runCheck } from './test-helpers';
export type { MakeCheckServicesOptions } from './test-helpers';

// ─── Primitive checks (language-agnostic) ─────────────────────────────────────
export {
  forbidFile,
  requireChildren,
  requireSibling,
  requireTest,
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

// ─── Request and test scoping ────────────────────────────────────────────────
export { expandRequest, rulesForRequest } from './backend/request-scope';
export { DEFAULT_TEST_SUFFIXES, testFilesForPaths } from './backend/test-scope';
export type { TestScopeOptions } from './backend/test-scope';
export { scopedPatterns, toolScope, toolWatchPatterns } from './engine/tool-patterns';

// ─── Multi-agent coordination ────────────────────────────────────────────────
export {
  acquireSlot,
  coordinateRun,
  coordDirFor,
  countWaiters,
  findReusableRecord,
  readRecords,
  readSlot,
  registerWaiter,
  releaseSlot,
  takeOverSlot,
  writeRecord,
} from './engine/run-lock';
export type {
  CoordinateOptions,
  CoordinationEvent,
  CoordinationMode,
  CoordinationOutcome,
  RunRecord,
} from './engine/run-lock';
export { KEEP_STORED, type ComputeResult } from './cache';
export { BaselineFileError } from './engine/errors';
export { listFiles, treeStateFor, treeStatesMatch } from './engine/file-set';
export type { TreeState } from './engine/file-set';

// ─── Violation baseline ──────────────────────────────────────────────────────
export { partitionByBaseline, planBaselineWrite } from './engine/baseline-apply';
export type {
  BaselinePartition,
  BaselinePartitionOptions,
  BaselineRuleCounts,
  BaselineStats,
  BaselineWritePlan,
} from './engine/baseline-apply';
export {
  BASELINE_FILE_NAME,
  STALE_RULE_ID,
  buildBaselineFile,
  makeBaselineFile,
  normalizeMessage,
  normalizePath,
  violationHash,
} from './engine/baseline';
export type {
  BaselineEntry,
  BaselineFile,
  BaselineViolationGroup,
} from './engine/baseline';
export { baselinePathFor, readBaselineFile, serializeBaseline, writeBaselineFile } from './engine/baseline-file';

// ─── Daemon mode ──────────────────────────────────────────────────────────────
// Optional by construction: the engine never imports this, and every entry point
// here is something the CLI drives. A project with no daemon running behaves exactly
// as it did before this module existed.
export {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SOCKET_PATH,
  askDaemon,
  daemonStatus,
  createLimiter,
  daemonDirFor,
  decodeRequest,
  decodeResponse,
  encodeLine,
  ensureSocketDir,
  isDecodeError,
  orderBatches,
  planBatches,
  removeSocketFile,
  socketExists,
  socketPathFor,
  startDaemonServer,
  stopDaemon,
} from './engine/daemon/index';
export type {
  AskOptions,
  Batch,
  CheckSpec,
  DaemonRequest,
  DaemonResponse,
  DaemonRun,
  DaemonRunner,
  DaemonServer,
  DaemonServerOptions,
  DaemonStats,
  Schedulable,
  Scope,
} from './engine/daemon/index';
