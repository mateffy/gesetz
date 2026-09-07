import * as nodePath from 'node:path';
import type { Rule, Exemption } from './rule';
import type { SyntaxBackend } from '../services/syntax-tree';

/**
 * Where the violation-marker cache lives. Structurally identical to
 * netzwerk's NetworkStorageConfig, but declared here so the public d.ts
 * has no netzwerk references (consumers would otherwise typecheck
 * netzwerk's TS source).
 */
export type GesetzStorageConfig =
  | { readonly kind?: 'memory' | undefined }
  | { readonly kind: 'sqlite'; readonly path: string; readonly dimensions?: number | undefined };

export interface CategoryThreshold {
  /** Category name matching `Rule.category` */
  readonly category: string;
  /** Minimum score 0–10. Default: 7 */
  readonly minScore: number;
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
   * Where the violation-marker cache lives. `{ kind: 'sqlite', path }`
   * persists across runs (CLI default); `{ kind: 'memory' }` is ephemeral
   * (tests, one-shot runs). Default: memory.
   */
  readonly storage?: GesetzStorageConfig | undefined;
}

export interface ResolvedConfig {
  readonly projectRoot: string;
  readonly tsConfigPath: string;
  readonly rules: Rule[];
  readonly exemptions: Exemption[];
  readonly changedSince: string | undefined;
  readonly thresholds: CategoryThreshold[];
  readonly adapters: readonly SyntaxBackend[];
  readonly storage: GesetzStorageConfig;
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
    changedSince: config.changedSince,
    thresholds: config.thresholds ?? [],
    adapters: config.adapters ?? [],
    storage: config.storage ?? { kind: 'memory' },
  };
}
