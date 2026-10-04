import * as nodePath from 'node:path';
import type { Rule, Exemption } from './rule';
import type { SyntaxBackend } from '../services/syntax-tree';

/**
 * Where the incremental cache lives.
 *
 * - `{ kind: 'memory' }` — nothing is persisted. Use this to opt out of
 *   caching for a project, or when calling `runAll` from tests.
 * - `{ kind: 'sqlite', path }` — a persistent SQLite cache at `path`.
 *
 * Omit the field to accept the default: the CLI persists to
 * `<projectRoot>/.gesetz/cache.db`, while a programmatic `runAll` stays in
 * memory.
 *
 * The SQLite driver is chosen automatically — the built-in `node:sqlite`
 * module when the runtime has it, otherwise a driver registered by an optional
 * compatibility package such as `@gesetz/sqlite-compat`. When neither exists,
 * the run continues without persistence and says so once.
 */
export type GesetzStorageConfig =
  | { readonly kind: 'memory' }
  | { readonly kind: 'sqlite'; readonly path: string };

export interface CategoryThreshold {
  /** Category name matching `Rule.category` */
  readonly category: string;
  /** Minimum score 0–10. Default: 7 */
  readonly minScore: number;
}

/** Baseline behaviour a project can pin in its config. */
export interface BaselineConfig {
  /**
   * When true, `gesetz baseline` refuses to write the baseline file. The baseline
   * is a maintainer decision; an agent batch must never absorb a backlog.
   */
  readonly readOnly?: boolean | undefined;
}

export interface UserConfig {
  /**
   * Root directory for the project. All rule paths are relative to this.
   * Defaults to `process.cwd()` when not set.
   */
  readonly projectRoot?: string | undefined;
  /**
   * Path to tsconfig.json, relative to projectRoot.
   * Defaults to `'tsconfig.json'`.
   */
  readonly tsConfigPath?: string | undefined;
  readonly rules: Rule[];
  readonly exemptions?: Exemption[] | undefined;
  /**
   * Only report violations in files changed since this git ref.
   * e.g. `'HEAD~5'`, `'main'`, a commit SHA.
   * Violations in unchanged files are suppressed.
   */
  readonly changedSince?: string | undefined;
  /**
   * Per-category minimum scores. Checked by ProcessReporter and CLI.
   * Default minimum is 7 for all categories.
   */
  readonly thresholds?: CategoryThreshold[] | undefined;
  /**
   * SyntaxBackend objects from language adapters.
   * Provide these to enable structural checks (noDirectCalls, requireNamingConvention, etc.)
   * and accurate import extraction for defineArchitecture and noCycles.
   *
   * @example
   * import { typescriptSyntaxBackend } from '@gesetz/typescript'
   * import { phpSyntaxBackend } from '@gesetz/php'
   *
   * defineConfig({
   *   adapters: [typescriptSyntaxBackend, phpSyntaxBackend],
   *   rules: [...]
   * })
   */
  readonly adapters?: readonly SyntaxBackend[] | undefined;
  /**
   * Where the incremental cache lives. Omit for the default (the CLI persists
   * to `<projectRoot>/.gesetz/cache.db`; `runAll` stays in memory). Set
   * `{ kind: 'memory' }` to opt out of caching entirely.
   */
  readonly storage?: GesetzStorageConfig | undefined;
  /**
   * Violation baseline behaviour. The baseline file itself lives at
   * `.gesetz-baseline.json` in the project root.
   */
  readonly baseline?: BaselineConfig | undefined;
  /**
   * Route `check` through a daemon when one is running, in this project.
   *
   * Off by default. Setting it true does **not** start a daemon — a background
   * process nobody asked for outlives the command that summoned it — it only says
   * that a running one may be used. `--daemon` and `--no-daemon` override it per run.
   */
  readonly daemon?: boolean | undefined;
}

export interface ResolvedConfig {
  readonly projectRoot: string;
  readonly tsConfigPath: string;
  readonly rules: Rule[];
  readonly exemptions: Exemption[];
  /** Resolved baseline behaviour; an empty object when the config sets none. */
  readonly baseline: BaselineConfig;
  readonly changedSince: string | undefined;
  readonly thresholds: CategoryThreshold[];
  readonly adapters: readonly SyntaxBackend[];
  /** Undefined means "not specified" — the caller picks the default. */
  readonly storage: GesetzStorageConfig | undefined;
  /**
   * Whether `check` should route through a daemon when one is running. Off unless a
   * project opts in; `--daemon` and `--no-daemon` override it per run. The daemon is
   * never started implicitly — `gesetz daemon start` is the only thing that starts
   * one, because a background process nobody asked for outlives the command that
   * summoned it.
   */
  readonly daemon: boolean;
}

/**
 * Defines a QA configuration. `projectRoot` defaults to `process.cwd()`.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   rules: [
 *     select('src/**\/*.tsx').label('Components need stories').check(requireSibling('.stories.tsx')),
 *   ],
 * });
 * ```
 */
export function defineConfig(config: UserConfig): ResolvedConfig {
  const projectRoot = nodePath.resolve(config.projectRoot ?? process.cwd());
  return {
    projectRoot,
    tsConfigPath: nodePath.resolve(projectRoot, config.tsConfigPath ?? 'tsconfig.json'),
    rules: config.rules,
    exemptions: config.exemptions ?? [],
    baseline: config.baseline ?? {},
    changedSince: config.changedSince,
    daemon: config.daemon ?? false,
    thresholds: config.thresholds ?? [],
    adapters: config.adapters ?? [],
    // A relative cache path is project-relative, like every other path here.
    storage:
      config.storage?.kind === 'sqlite'
        ? { kind: 'sqlite', path: nodePath.resolve(projectRoot, config.storage.path) }
        : config.storage,
  };
}
