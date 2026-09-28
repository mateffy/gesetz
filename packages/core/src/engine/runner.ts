import * as childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { hashValue, sync } from '../cache';
import type { CacheEntry, FileRef } from '../cache';
import { KEEP_STORED } from '../cache';
import type { Violation, CheckServices, File, Rule, ProjectRuleOutcome } from './rule';
import type { ResolvedConfig } from './config';
import { createConfiguredStore } from './cache-store';
import { candidateFileRefs, listProjectFiles } from './discovery';
import { backendFingerprint, ruleFingerprint } from './fingerprint';
import { createCheckServices } from '../services/check-services';
import { servicesLayer } from './services-layer';
import { applyExemptions, computeCategoryScores } from './result';
import { expandRequest, rulesForRequest } from '../backend/request-scope';
import { partitionByBaseline, type BaselineStats } from './baseline-apply';
import { STALE_RULE_ID, type BaselineFile } from './baseline';
import type { CategoryScore, RuleResult, RunResult } from './result';

// Re-exported so the public entry point keeps a single source of truth.
export { applyExemptions } from './result';
export type { CategoryScore, RuleResult, RunResult } from './result';


export interface RunAllOptions {
  /**
   * When set (CLI `--files`), the run is scoped to the files matching these
   * micromatch globs: rules that cannot match any of them are not run at all,
   * files outside the request keep their cached results, and violations for them
   * are suppressed. This reduces work, not just output.
   */
  readonly fileFilter?: readonly string[] | null | undefined;
  /**
   * Violation baseline to check against. When set, violations already in the
   * baseline are counted but not reported, and entries with no violation left
   * are reported as stale. `null`/absent means no baseline.
   */
  readonly baseline?: BaselineFile | null | undefined;
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

/** Bumped when the rules-scope key's meaning changes, invalidating old entries. */
const CACHE_KEY_VERSION = 3;
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

/**
 * True when any of a rule's checks asks the file system rather than being a
 * function of its own file.
 *
 * Such a rule cannot be cached against file content: `requireTest` asks whether a
 * test file *exists*, so adding it changes the answer without touching the source.
 */
function ruleReadsFileSystem(rule: Rule): boolean {
  const checks = rule.perFile?.checks;
  if (checks === undefined || checks.length === 0) return false;
  return checks.some((check) => check.needsFileSet === true);
}

/**
 * Runs a file-system rule over the files it covers.
 *
 * This is the per-file check loop, run over a whole rule's file set instead of one
 * file at a time, in the project pass — because the answer depends on more than
 * one file. It reads each covered file and runs the checks; they ask `fs.exists`
 * against the run's file list, so nothing is parsed and recomputing is cheap.
 */
async function executeFileSystemRule(
  rule: Rule,
  relevant: readonly FileRef[],
  services: CheckServices,
): Promise<{ violations: Violation[]; failed: boolean; examinedPaths: string[] }> {
  const violations: Violation[] = [];
  const examinedPaths: string[] = [];
  for (const reference of relevant) {
    let content: string;
    try {
      content = await readFile(reference.absolutePath, 'utf-8');
    } catch {
      continue; // vanished since discovery
    }
    examinedPaths.push(reference.path);
    violations.push(...(await runChecks(rule, fileFromRef(reference, content), services)));
  }
  return { violations, failed: false, examinedPaths };
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
  context: {
    readonly rootDir: string;
    readonly changedFiles: readonly string[];
    readonly requestedPaths: readonly string[] | null;
  },
  services: CheckServices,
  fileFilter: readonly string[] | null,
  throwOnError: boolean,
): Promise<{ violations: Violation[]; failed: boolean; examinedPaths?: readonly string[] }> {
  try {
    if (rule.project === undefined) {
      const violations = await Effect.runPromise(
        Effect.provide(rule.run, servicesLayer(services, fileFilter)),
      );
      return { violations, failed: false };
    }
    const outcome: ProjectRuleOutcome = await rule.project.run(context);
    if ('violations' in outcome) {
      return {
        violations: [...outcome.violations],
        failed: false,
        ...(outcome.examinedPaths === undefined
          ? {}
          : { examinedPaths: outcome.examinedPaths }),
      };
    }
    return { violations: [...outcome], failed: false };
  } catch (cause) {
    if (throwOnError) throw cause;
    return {
      failed: true,
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

      const requestedPaths = fileFilterActive ? expandRequest(allPaths, fileFilter) : null;
      const activeRules =
        requestedPaths === null ? config.rules : rulesForRequest(config.rules, requestedPaths);

      const perFileRules = activeRules.filter((rule) => rule.perFile !== undefined);
      // A rule whose checks ask the file system cannot be cached against file
      // content: adding the file they are looking for changes the answer without
      // touching the source. They run in the project pass, which is keyed by the
      // set of files the rule covers, so an add or a delete recomputes them and an
      // edit does not — and they parse nothing, so recomputing is cheap.
      const fileSystemRules = perFileRules.filter((rule) => ruleReadsFileSystem(rule));
      const contentRules = perFileRules.filter((rule) => !ruleReadsFileSystem(rule));
      const projectRules = activeRules.filter((rule) => rule.perFile === undefined);
      const rulePasses = [...projectRules, ...fileSystemRules];

      const changed = new Set<string>();
      const violationsByRule = new Map<string, Violation[]>();
      const failedRules: string[] = [];

      // ── Per-file rules ───────────────────────────────────────────────────
      // One cache scope, one entry per file.
      //
      // The fingerprint covers every input a *content-pure* per-file result
      // depends on: the rule definitions and the syntax backends.
      // The project's path set is deliberately NOT here. It used to be, so that a
      // check asking `fs.exists` (`requireSibling` and friends) could not serve a
      // stale "sibling present" after the sibling was deleted — but folding it in
      // meant one added file recomputed every per-file result in the project, which
      // is unaffordable where files come and go. Those rules run in the project
      // pass instead (see `fileSystemRules`), which is keyed by the covered path
      // set, so correctness is kept and the cost lands only on the rules that asked
      // for it.
      const scopeFingerprint = hashValue({
        v: CACHE_KEY_VERSION,
        backends: backendFingerprint(config.adapters),
        rules: contentRules.map((rule) => [rule.id, ruleFingerprint(rule)]),
      });

      const synced = await sync<FileRuleResults>({
        scope: RULES_SCOPE,
        store,
        files: candidates,
        fingerprint: scopeFingerprint,
        compute: async (reference, source) => {
          if (requestedPaths !== null && !requestedPaths.includes(reference.path)) {
            // Not this run's business. Its stored result stays as it is: if the
            // content did not change it is still correct, and if it did the hash no
            // longer matches, so the next run that covers the file recomputes it.
            // Storing an empty result here would erase a violation nobody looked at.
            return KEEP_STORED;
          }
          const file = fileFromRef(reference, source.content);
          const results: Record<string, Violation[]> = {};
          for (const rule of contentRules) {
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

      // ── Deterministic rules: project rules and file-system rules ─────────
      //
      // One cache entry per rule, keyed by the content hashes of the files it
      // covers — so an add, delete or rename recomputes it and an edit does not.
      for (const rule of rulePasses) {
        const perFile = rule.perFile;
        const patterns = perFile?.patterns ?? rule.project?.patterns ?? null;
        const inPatterns =
          perFile !== undefined
            ? candidates.filter((file) => matchesPerFile(file.path, perFile))
            : patterns === null
              ? candidates
              : candidates.filter((file) =>
                  micromatch.isMatch(file.path, [...patterns], { dot: true }),
                );
        // A scoped run looks at the requested files only; an unscoped run looks at
        // everything the rule covers. Either way the set is deterministic given the
        // request, which is what makes it safe to use as a cache key.
        const relevant =
          requestedPaths === null
            ? inPatterns
            : inPatterns.filter((file) => requestedPaths.includes(file.path));
        // A file-system rule's answer depends on which files exist, not only on the
        // contents of the ones it covers: `requireTest` asks whether a test file is
        // *there*, and that file is usually outside the rule's own patterns (they
        // exclude tests). So the path set is part of its key — paths only, so an
        // edit does not recompute it and an add or a delete does.
        //
        // ponytail: a file-system rule that reads the *contents* of files outside its
        // patterns can serve a stale answer, because those contents are not in the
        // key. Core's three (`requireTest`, `requireSibling`, `requireChildren`) only
        // ask existence. A custom rule that reads further should widen its patterns
        // or set an explicit `Rule.fingerprint`.
        const projectHash = hashValue([
          ['covered', relevant.map((file) => [file.path, synced.hashes.get(file.path) ?? ''])],
          ...(perFile === undefined ? [] : [['paths', allPaths] as const]),
        ]);
        const fingerprint = ruleFingerprint(rule);
        const cached: CacheEntry<Violation[]> | undefined = await store.get<Violation[]>(
          rule.id,
          PROJECT_KEY,
        );

        // A `--files` request is part of the key: a run that looked at three files
        // must never be served for a run that was supposed to look at the project.
        // (The requested paths also narrow `relevant`, so this is belt and braces —
        // but a key that cannot be read as "which question did this answer" is how
        // these caches go wrong.)
        const cacheHash = hashValue([
          ['project', projectHash],
          ['request', requestedPaths === null ? null : [...requestedPaths].sort()],
        ]);

        if (
          cached !== undefined &&
          cached.hash === cacheHash &&
          cached.meta?.['fingerprint'] === fingerprint
        ) {
          violationsByRule.set(rule.id, cached.value);
          continue;
        }

        const execution =
          perFile !== undefined
            ? await executeFileSystemRule(rule, relevant, services)
            : await executeProjectRule(
                rule,
                {
                  rootDir: config.projectRoot,
                  changedFiles: [...changed],
                  requestedPaths,
                },
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
            hash: cacheHash,
            value: execution.violations,
            meta: { fingerprint },
          });
        }
        violationsByRule.set(rule.id, execution.violations);
      }

      // ── Aggregation ──────────────────────────────────────────────────────
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
        if (changedSinceFiles !== null) {
          violations = violations.filter((violation) => changedSinceFiles.has(violation.path));
        }
        violations = applyExemptions(violations, config.exemptions, ruleId);
        return { ruleId, description, category, violations };
      };

      const changedSinceFiles = resolveChangedFiles(config.changedSince, config.projectRoot);
      /**
       * Whether a path is inside what this run examined. A `--since` or `--files`
       * run cannot see files outside its scope, so a baseline entry for such a file
       * is not stale — it was simply not looked at.
       */
      const inScope = (path: string): boolean => {
        if (fileFilterActive && fileFilter !== null && !micromatch.isMatch(path, [...fileFilter])) {
          return false;
        }
        if (changedSinceFiles !== null && !changedSinceFiles.has(path)) return false;
        return true;
      };

      let results: RuleResult[] = activeRules.map((rule) =>
        buildResult(rule.id, rule.description, rule.category),
      );

      let baselineStats: BaselineStats | undefined;
      if (options.baseline !== undefined && options.baseline !== null) {
        const modes = new Map(
          config.rules.map((rule) => [rule.id, rule.baselineMessage ?? 'normalized'] as const),
        );
        const partition = partitionByBaseline(
          results.map((result) => ({ rule: result.ruleId, violations: result.violations })),
          options.baseline,
          {
            modes,
            inScope,
            allowStale: (path) =>
              applyExemptions(
                [{ message: '', path, severity: 'error', source: 'core' }],
                config.exemptions,
                STALE_RULE_ID,
              ).length > 0,
          },
        );
        results = results.map((result) => ({
          ...result,
          violations: partition.newByRule.get(result.ruleId) ?? [],
        }));
        if (partition.stale.length > 0) {
          results.push({
            ruleId: STALE_RULE_ID,
            description: 'A baseline entry no longer matches a violation',
            category: undefined,
            violations: [...partition.stale],
          });
        }
        baselineStats = partition.stats;
      }

      const totalViolations = results.reduce((sum, result) => sum + result.violations.length, 0);
      const byCategory = computeCategoryScores(results, config.thresholds);
      // A rule that could not run makes the run incomplete: never report a pass.
      const categoriesPass =
        failedRules.length === 0 &&
        (byCategory.length === 0 || byCategory.every((category) => category.passing));
      // With a baseline in play, the baseline is the gate: a category score can be
      // high enough while a new violation or a stale entry still needs attention.
      const passing =
        baselineStats === undefined
          ? categoriesPass
          : categoriesPass && baselineStats.new === 0 && baselineStats.stale === 0;

      options.onScan?.({
        filesSeen: allPaths.length,
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
        ...(baselineStats === undefined ? {} : { baseline: baselineStats }),
      };
    } finally {
      await store.close();
    }
  });
