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
export type Check = (
  file: File,
  services: CheckServices,
) => Promise<Violation[]>;

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
  /** The Effect that produces violations when run */
  readonly run: Effect.Effect<
    Violation[],
    never,
    FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter
  >;
  /**
   * Internal: present for per-file rules built by select(). The runner
   * compiles this descriptor into a netzwerk extension instead of
   * executing `run` directly.
   */
  readonly perFile?: {
    readonly patterns: readonly string[];
    readonly exclusions: readonly string[];
    readonly predicates: ReadonlyArray<(file: File) => boolean>;
    readonly checks: readonly Check[];
  } | undefined;
  /**
   * Internal: present for project-level rules (architecture, cycle
   * detection, external-tool adapters). Runs once per scan against the
   * network; re-runs only when a file matching `patterns` changed.
   */
  readonly project?: {
    readonly patterns: readonly string[];
    readonly run: (ctx: ProjectRuleContext) => Promise<Violation[]>;
  } | undefined;
}

/**
 * One scanned file as seen by project rules. Structurally matches
 * netzwerk's NetworkFile, declared locally so the public d.ts has no
 * netzwerk references.
 */
export interface NetworkFileLike {
  readonly path: string;
  readonly markers: readonly { readonly type: string; readonly data: unknown; readonly lines?: readonly number[] | undefined }[];
  hasMarker(type: string): boolean;
  markersOf<D = unknown>(type: string): readonly { readonly type: string; readonly data: D; readonly lines?: readonly number[] | undefined }[];
  content(): Promise<string>;
}

/** Minimal network surface project rules are allowed to see. */
export interface ProjectRuleContext {
  readonly network: {
    glob(pattern: string): Promise<readonly NetworkFileLike[]>;
    file(path: string): Promise<NetworkFileLike | null>;
  };
  /** Repo-relative paths reprocessed by this scan (added + changed). */
  readonly changedFiles: readonly string[];
  readonly rootDir: string;
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
