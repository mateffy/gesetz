import type { Effect } from 'effect';
import type { FileSystem, ProjectRoot, FileFilter, GlobOptions } from '../services/fs';
import type { SyntaxTree, SyntaxTreeProcessOptions } from '../services/syntax-tree';
import type { SyntaxBackendProcessResult } from '../services/syntax-tree';
import type { ImportResolver } from '../services/import-resolver';

export type Severity = 'error' | 'warn' | 'info';
export type ViolationSource = 'core' | 'eslint' | 'phpstan' | 'oxlint' | 'custom';

export interface Violation {
  /** Rule ID — injected by the builder when absent. */
  readonly rule?: string | undefined;
  readonly message: string;
  readonly path: string;
  readonly line?: number | undefined;
  /**
   * Source text of the offending line, when a caller has read it. Baseline
   * identity includes it so an entry covers one *occurrence* rather than a count
   * of them, while still surviving a line shift. Absent for a violation with no
   * line, and for callers that never read the file.
   */
  readonly lineText?: string | undefined;
  readonly column?: number | undefined;
  readonly severity: Severity;
  readonly context?: string | undefined;
  readonly fix?: string | undefined;
  readonly source: ViolationSource;
}

export interface File {
  /** Repository-relative path, e.g. `src/components/Foo.tsx` */
  readonly path: string;
  /** Absolute path on disk */
  readonly absolutePath: string;
  /** Full file name, e.g. `Foo.tsx` */
  readonly name: string;
  /** File name without extension, e.g. `Foo` */
  readonly stem: string;
  /** Extension including dot, e.g. `.tsx` */
  readonly ext: string;
  /** Repository-relative parent directory, e.g. `src/components` */
  readonly dir: string;
  /** Raw file content as UTF-8 string */
  readonly content: string;
  /** File size in bytes */
  readonly size: number;
  /** Last modified time in milliseconds */
  readonly mtimeMs: number;
}

/**
 * Services bag passed to every check. Destructure what you need.
 * These are bridged from the internal Effect service layer — you
 * interact with them via plain async/await.
 */
export interface CheckServices {
  fs: {
    glob(pattern: string | string[], options?: GlobOptions): Promise<File[]>;
    readFile(absolutePath: string): Promise<string>;
    exists(absolutePath: string): Promise<boolean>;
  };
  syntax: {
    canProcess(file: File): boolean;
    process(file: File, options: SyntaxTreeProcessOptions): Promise<SyntaxBackendProcessResult>;
  };
  imports: {
    resolve(fromFile: File, specifier: string): string | null;
  };
  /** Absolute path to the project root directory. */
  projectRoot: string;
}

/**
 * A single-file analysis function. Returns a promise of violations.
 * Errors are absorbed by the runner — never throw (return [] on failure).
 */
export type Check = ((file: File, services: CheckServices) => Promise<Violation[]>) & {
  /**
   * True when this check's answer for a file depends on which *other* files
   * exist — `requireTest` looks for a test file beside the source.
   *
   * Such a check cannot be cached against the file's own content: adding the
   * missing file changes the answer without touching the file. Rules made only of
   * these checks run in the project pass, which is keyed by the set of files the
   * rule covers, so an add or a delete recomputes them while an edit does not.
   */
  needsFileSet?: boolean;
};

/**
 * A named rule that runs against the entire project context.
 * The rule's run Effect is fully self-contained — it accesses files via the
 * FileSystem service, and AST analysis via the SyntaxTree service.
 *
 * The error channel is `never` — rules must catch all internal errors and
 * convert them to violations. The RuleRunner also catches any uncaught errors.
 */
/**
 * Categories align with Gesetz's scoring dimensions.
 * Rules with no category still run but don't contribute to category scores.
 */
export type RuleCategory =
  | 'strictness'
  | 'structure'
  | 'organization'
  | 'cleanup'
  | 'security'
  | 'react'
  | 'effect-ts'
  | string; // extensible

/** Agent-facing guidance: what the rule checks, what to do, what not to do. */
export interface RuleGuidance {
  /** What the rule detects — one short sentence. */
  readonly what: string;
  /** Correct fix — one short sentence, imperative. */
  readonly do: string;
  /** Anti-pattern to avoid — one short sentence. */
  readonly dont: string;
}

/**
 * How a violation's message is compared when matching it to a baseline entry.
 * `normalized` (the default) ignores the numbers in a message, so a baseline
 * survives an assertion message changing from "expected 1 to be 2" to
 * "expected 5 to be 2"; `exact` compares it verbatim.
 */
export type BaselineMessageMode = 'normalized' | 'exact';

export interface Rule {
  /** Stable kebab-case identifier, slugified from the human label */
  readonly id: string;
  /** Human-readable description of what this rule enforces */
  readonly description: string;
  /**
   * Category used for scoring aggregation.
   * When set, violations roll up into a named category score (0–10).
   */
  readonly category?: RuleCategory | undefined;
  /**
   * Agent-facing guidance for fixing violations.
   * Used by `gesetz list` and the `gesetz skill` command.
   */
  readonly guidance?: RuleGuidance | undefined;
  /**
   * How this rule's violation messages are compared against baseline entries.
   * Default: `normalized`. See `BaselineMessageMode`.
   */
  readonly baselineMessage?: BaselineMessageMode | undefined;

  /**
   * Optional explicit cache-invalidation string. When set, the runner uses it
   * verbatim as the rule's fingerprint instead of hashing the rule's shape.
   * Rules whose behaviour is configured at runtime should set this.
   */
  readonly fingerprint?: string | undefined;
  /** The Effect that produces violations when run */
  readonly run: Effect.Effect<
    Violation[],
    never,
    FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter
  >;
  /**
   * Internal: present for per-file rules built by select(). The runner
   * executes this descriptor per file instead of executing `run` directly.
   */
  readonly perFile?: {
    readonly patterns: readonly string[];
    readonly exclusions: readonly string[];
    readonly predicates: ReadonlyArray<(file: File) => boolean>;
    readonly checks: readonly Check[];
  } | undefined;
  /**
   * Internal: present for project-level rules (external-tool adapters). Runs
   * once per scan and is cached until a file matching `patterns` changes or the
   * rule's fingerprint changes.
   */
  readonly project?: {
    readonly patterns: readonly string[];
    readonly run: (ctx: ProjectRuleContext) => Promise<ProjectRuleOutcome>;
  } | undefined;
}

/** Context handed to a project-level rule. */
/**
 * What a project rule found, and which paths it looked at.
 *
 * A rule that examines only some files must say which ones: its result is cached
 * under a key that includes the examined set, so a run that looked at three files
 * can never stand in for a run that was supposed to look at all of them.
 */
export type ProjectRuleOutcome = readonly Violation[] | ProjectRuleResult;

export interface ProjectRuleResult {
  readonly violations: readonly Violation[];
  /** The paths this run examined. Absent means the whole project. */
  readonly examinedPaths?: readonly string[] | undefined;
}

export interface ProjectRuleContext {
  /** Absolute project root. */
  readonly rootDir: string;
  /**
   * Repo-relative paths reprocessed by this scan (added + changed), already
   * narrowed to the caller's `--files` request when there was one. A rule that
   * hands paths to an external tool hands it these.
   */
  readonly changedFiles: readonly string[];
  /**
   * Repo-relative paths the caller asked about (`--files`), or null when the run
   * was not scoped.
   */
  readonly requestedPaths?: readonly string[] | null | undefined;
}

export interface Exemption {
  /** micromatch glob matching file paths to exempt */
  readonly path: string;
  /** micromatch glob matching rule IDs — defaults to '*' (all rules) */
  readonly rule?: string | undefined;
  /** Reason for the exemption (required) */
  readonly reason: string;
  /** Ticket reference, e.g. 'PROJ-123' */
  readonly ticket?: string | undefined;
  /**
   * ISO 8601 date after which this exemption expires.
   * Expired exemptions no longer suppress violations — violations surface again.
   */
  readonly until?: string | undefined;
}
