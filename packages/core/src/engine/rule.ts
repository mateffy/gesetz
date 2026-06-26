import type { Effect } from 'effect';
import type { FileSystem, ProjectRoot, FileFilter } from '../services/fs';
import type { TsAdapter } from '../services/ts-adapter';
import type { PhpAdapter } from '../services/php-adapter';
export type Severity = 'error' | 'warn' | 'info';
export type ViolationSource = 'core' | 'eslint' | 'phpstan' | 'oxlint' | 'custom';

export interface Violation {
  readonly rule: string;
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
 * A single-file analysis function. Returns violations for the given file.
 * Errors are absorbed into violations — never throw.
 */
export type Check = (
  file: File,
) => Effect.Effect<Violation[], never, FileSystem | TsAdapter | ProjectRoot>;

/**
 * A named rule that runs against the entire project context.
 * The rule's run Effect is fully self-contained — it accesses files via the
 * FileSystem service, and AST analysis via TsAdapter / PhpAdapter.
 *
 * The error channel is `never` — rules must catch all internal errors and
 * convert them to violations. The RuleRunner also catches any uncaught errors.
 */
/**
 * Categories align with Regel's scoring dimensions.
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
   * Used by `regel list` and the `regel skill` command.
   */
  readonly guidance?: RuleGuidance | undefined;
  /** The Effect that produces violations when run */
  readonly run: Effect.Effect<Violation[], never, FileSystem | TsAdapter | PhpAdapter | ProjectRoot | FileFilter>;
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
