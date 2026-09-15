import * as childProcess from 'node:child_process';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { hashValue, sync } from '../cache';
import type { CacheEntry, FileRef } from '../cache';
import type { Violation, CheckServices, File, Rule } from './rule';
import type { ResolvedConfig } from './config';
import { createConfiguredStore } from './cache-store';
import { candidateFileRefs, listProjectFiles } from './discovery';
import { backendFingerprint, ruleFingerprint } from './fingerprint';
import { createCheckServices } from '../services/check-services';
import { servicesLayer } from './services-layer';
import { applyExemptions, computeCategoryScores } from './result';
import type { CategoryScore, RuleResult, RunResult } from './result';

// Re-exported so the public entry point keeps a single source of truth.
export { applyExemptions } from './result';
export type { CategoryScore, RuleResult, RunResult } from './result';


export interface RunAllOptions {
  /**
   * When set (CLI `--files`), violations for files not matching these
   * micromatch globs are suppressed. Pure aggregation-time filter — the cache
   * is unaffected.
   */
  readonly fileFilter?: readonly string[] | null | undefined;
  /** Called with the scan statistics after the run (for CLI reporting). */
  readonly onScan?: ((result: ScanStats) => void) | undefined;
  /**
   * When true, a project-level rule (a tool adapter, architecture rule, or
   * cycle check) that throws fails the whole run instead of being reported as a
   * critical violation. Default: false.
   */
  readonly throwOnRuleError?: boolean | undefined;
}

/** Scan statistics for one run. */
export interface ScanStats {
  readonly filesSeen: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly reused: number;
  readonly durationMs: number;
}

/** Cache scope holding one entry per file: `{ [ruleId]: Violation[] }`. */
const RULES_SCOPE = 'rules';
/** Synthetic cache key for whole-project rule results. */
const PROJECT_KEY = '__project__';

/** Per-file violation lists, keyed by rule id. */
type FileRuleResults = Readonly<Record<string, Violation[]>>;

/**
 * Resolves the git-changed file set for `changedSince`.
 * Returns `null` when not filtering (all files included).
 */
function resolveChangedFiles(
  changedSince: string | undefined,
  projectRoot: string,
): Set<string> | null {
  if (!changedSince) return null;
  try {
    const output = childProcess
      .execFileSync('git', ['diff', '--name-only', changedSince], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
      .trim();
    if (!output) return new Set();
    return new Set(output.split('\n').map((p) => p.trim()).filter(Boolean));
  } catch {
    // git not available or ref invalid — fall through to no filter
    return null;
  }
}

function matchesPerFile(path: string, perFile: NonNullable<Rule['perFile']>): boolean {
  if (!micromatch.isMatch(path, [...perFile.patterns], { dot: true })) return false;
  if (
    perFile.exclusions.length > 0 &&
    micromatch.isMatch(path, [...perFile.exclusions], { dot: true })
  ) {
    return false;
  }
  return true;
}

function fileFromRef(reference: FileRef, content: string): File {
  const slash = reference.path.lastIndexOf('/');
  const name = slash === -1 ? reference.path : reference.path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  const stem = dot === -1 ? name : name.slice(0, dot);
  return {
    path: reference.path,
    absolutePath: reference.absolutePath,
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : reference.path.slice(0, slash),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Runs every check of a per-file rule against an already-built `File`. */
async function runChecks(
  rule: Rule,
  file: File,
  services: CheckServices,
): Promise<Violation[]> {
  const perFile = rule.perFile;
  if (perFile === undefined) return [];
  if (!perFile.predicates.every((predicate) => predicate(file))) return [];

  const violations: Violation[] = [];
  for (const check of perFile.checks) {
    // Checks never throw — same contract as the v2 runner.
    violations.push(...(await check(file, services).catch((): Violation[] => [])));
  }
  return violations.map((violation) => ({ ...violation, rule: violation.rule ?? rule.id }));
}

/** Human-readable detail for a rule failure, preferring the error message. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return String(cause);
}

/**
 * Executes a project-level rule (tool adapter, architecture rule, or cycle
 * check). Failures become a critical violation unless `throwOnError` is set.
 */
async function executeProjectRule(
  rule: Rule,
  context: { readonly rootDir: string; readonly changedFiles: readonly string[] },
  services: CheckServices,
  fileFilter: readonly string[] | null,
  throwOnError: boolean,
): Promise<{ violations: Violation[]; failed: boolean }> {
  try {
    const violations =
      rule.project !== undefined
        ? await rule.project.run(context)
        : await Effect.runPromise(Effect.provide(rule.run, servicesLayer(services, fileFilter)));
    return { violations, failed: false };
  } catch (cause) {
    if (throwOnError) throw cause;
    return {
      violations: [
        {
          rule: rule.id,
          message: `Rule '${rule.id}' threw an unexpected error: ${describeCause(cause)}`,
          path: context.rootDir,
          severity: 'error',
          source: 'core',
          fix: 'Fix the underlying tool or rule so it can run. Pass --throw to surface the full error instead of a violation.',
        },
      ],
      failed: true,
    };
  }
}

/**
 * Runs all rules in the config and returns a RunResult.
 *
 * Execution is file-major: each file is read once, parsed at most once, and all
 * applicable per-file rules run against that single parse. Results are stored
 * in a content-hash cache (one entry per file, keyed by every per-file rule's
 * fingerprint) so unchanged files are never re-checked. Project-level rules get
 * one cache entry each, keyed by the content hashes of the files they cover.
 *
 * Exemptions, `--files`, and `--since` are aggregation-time filters — they never
 * invalidate the cache.
 */
export const runAll = (
  config: ResolvedConfig,
  options: RunAllOptions = {},
): Effect.Effect<RunResult, never, never> =>
  Effect.promise(async () => {
    const startedAt = Date.now();
    const store = await createConfiguredStore(config.storage, config.projectRoot);
    const fileFilter = options.fileFilter ?? null;
    const fileFilterActive = fileFilter !== null && fileFilter.length > 0;

    try {
      const allPaths = await listProjectFiles(config.projectRoot);
      const candidates = candidateFileRefs(allPaths, config);

      const services = createCheckServices({
        rootDir: config.projectRoot,
        backends: config.adapters,
        allPaths,
      });

      const perFileRules = config.rules.filter((rule) => rule.perFile !== undefined);
      const projectRules = config.rules.filter((rule) => rule.perFile === undefined);

      const changed = new Set<string>();
      const violationsByRule = new Map<string, Violation[]>();
      const failedRules: string[] = [];

      // ── Per-file rules ───────────────────────────────────────────────────
      // One cache scope, one entry per file.
      //
      // The fingerprint must cover every input a per-file result depends on, or
      // the cache serves stale violations. Those inputs are:
      //   - the rule definitions and the syntax backends,
      //   - and the *project's path set*: checks are not pure functions of one
      //     file. `requireSibling` asks `fs.exists`, `requireChildren`/`forbidFile`
      //     and `imports.resolve` consult the file listing. Without the path set
      //     here, deleting `a.test.ts` would leave `a.ts`'s cached result saying
      //     "sibling present" — a silent pass.
      //
      // Paths only, not their contents: an *edit* must stay cheap (only the
      // edited file recomputes), while an add/remove/rename recomputes all
      // per-file results.
      const scopeFingerprint = hashValue({
        v: 2,
        backends: backendFingerprint(config.adapters),
        rules: perFileRules.map((rule) => [rule.id, ruleFingerprint(rule)]),
        files: allPaths,
      });

      const synced = await sync<FileRuleResults>({
        scope: RULES_SCOPE,
        store,
        files: candidates,
        fingerprint: scopeFingerprint,
        compute: async (reference, source) => {
          const file = fileFromRef(reference, source.content);
          const results: Record<string, Violation[]> = {};
          for (const rule of perFileRules) {
            const perFile = rule.perFile;
            if (perFile === undefined) continue;
            if (!matchesPerFile(reference.path, perFile)) continue;
            results[rule.id] = await runChecks(rule, file, services);
          }
          return results;
        },
      });

      for (const path of [...synced.added, ...synced.changed]) changed.add(path);

      for (const rule of perFileRules) violationsByRule.set(rule.id, []);
      for (const fileResults of synced.values.values()) {
        for (const [ruleId, violations] of Object.entries(fileResults)) {
          const list = violationsByRule.get(ruleId);
          if (list !== undefined) list.push(...violations);
        }
      }

      // ── Project and run-only rules ───────────────────────────────────────
      for (const rule of projectRules) {
        const patterns = rule.project?.patterns ?? null;
        const relevant =
          patterns === null
            ? candidates
            : candidates.filter((file) =>
                micromatch.isMatch(file.path, [...patterns], { dot: true }),
              );
        const projectHash = hashValue(
          relevant.map((file) => [file.path, synced.hashes.get(file.path) ?? '']),
        );
        const fingerprint = ruleFingerprint(rule);
        const cached: CacheEntry<Violation[]> | undefined = await store.get<Violation[]>(
          rule.id,
          PROJECT_KEY,
        );

        if (
          cached !== undefined &&
          cached.hash === projectHash &&
          cached.meta?.['fingerprint'] === fingerprint
        ) {
          violationsByRule.set(rule.id, cached.value);
          continue;
        }

        const execution = await executeProjectRule(
          rule,
          { rootDir: config.projectRoot, changedFiles: [...changed] },
          services,
          fileFilter,
          options.throwOnRuleError === true,
        );

        if (execution.failed) {
          failedRules.push(rule.id);
          // Never cache a failed run: the tool may be transiently broken and the
          // next invocation must retry rather than serve a stale error.
          await store.delete(rule.id, PROJECT_KEY);
        } else {
          await store.put(rule.id, PROJECT_KEY, {
            hash: projectHash,
            value: execution.violations,
            meta: { fingerprint },
          });
        }
        violationsByRule.set(rule.id, execution.violations);
      }

      // ── Aggregation ──────────────────────────────────────────────────────
      const changedFiles = resolveChangedFiles(config.changedSince, config.projectRoot);

      const buildResult = (
        ruleId: string,
        description: string,
        category: string | undefined,
      ): RuleResult => {
        let violations = violationsByRule.get(ruleId) ?? [];
        if (fileFilterActive && fileFilter !== null) {
          violations = violations.filter((violation) =>
            micromatch.isMatch(violation.path, [...fileFilter]),
          );
        }
        if (changedFiles !== null) {
          violations = violations.filter((violation) => changedFiles.has(violation.path));
        }
        violations = applyExemptions(violations, config.exemptions, ruleId);
        return { ruleId, description, category, violations };
      };

      const results: RuleResult[] = config.rules.map((rule) =>
        buildResult(rule.id, rule.description, rule.category),
      );

      const totalViolations = results.reduce((sum, result) => sum + result.violations.length, 0);
      const byCategory = computeCategoryScores(results, config.thresholds);
      // A rule that could not run makes the run incomplete: never report a pass.
      const passing =
        failedRules.length === 0 &&
        (byCategory.length === 0 || byCategory.every((category) => category.passing));

      options.onScan?.({
        filesSeen: candidates.length,
        added: synced.added.length,
        changed: synced.changed.length,
        removed: synced.removed.length,
        reused: synced.reused.length,
        durationMs: Date.now() - startedAt,
      });

      return {
        byRule: results,
        byCategory,
        totalViolations,
        passing,
        ...(failedRules.length > 0 ? { failedRules } : {}),
      };
    } finally {
      await store.close();
    }
  });
