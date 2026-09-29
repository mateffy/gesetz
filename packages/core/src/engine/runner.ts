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
import { aggregateRun } from './aggregate';
import {
  executeFileSystemRule,
  executeProjectRule,
  fileFromRef,
  matchesPerFile,
  resolveChangedFiles,
  ruleReadsFileSystem,
  runChecks,
} from './rule-execution';
import { partitionByBaseline, type BaselineStats } from './baseline-apply';
import { STALE_RULE_ID, type BaselineFile } from './baseline';
import type { CategoryScore, RuleResult, RunResult } from './result';

// Re-exported so the public entry point keeps a single source of truth.
export { applyExemptions, applyExemptionsWithCounts } from './result';
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
      /** Rules already reported as uncacheable, so the notice prints once. */
      const warnedUncacheable = new Set<string>();

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

      // A scoped run's rule set is a subset, so its results belong in a scope of
      // their own. Sharing the unscoped scope would mean the fingerprint (which
      // covers the rules that ran) differs between the two, and every scoped run
      // would recompute every file — the opposite of what `--files` is for.
      const scope =
        requestedPaths === null
          ? RULES_SCOPE
          : `${RULES_SCOPE}:${hashValue([...requestedPaths].sort()).slice(0, 12)}`;

      const synced = await sync<FileRuleResults>({
        scope,
        store,
        // A scoped run has its own scope, so it only ever holds the requested
        // files: handing `sync` the whole candidate list would read every file and
        // store nothing for the ones it skipped.
        files:
          requestedPaths === null
            ? candidates
            : candidates.filter((file) => requestedPaths.includes(file.path)),
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
        // A rule that declares patterns but covers no file in a project that has
        // files cannot be cached. Its key would be a constant, so whatever it found
        // once would be served for ever — including after the violation was fixed.
        // That is not hypothetical: an adapter configured with a `cwd`-relative
        // pattern (`cwd: 'immoui'`, `pattern: 'src/'`) matches nothing at the project
        // root, and it silently kept a stale result until `--full` re-ran it.
        //
        // It is re-run every scan instead, and named, so the pattern gets fixed.
        const uncacheable = patterns !== null && patterns.length > 0 && relevant.length === 0;
        if (uncacheable && !warnedUncacheable.has(rule.id)) {
          warnedUncacheable.add(rule.id);
          process.stderr.write(
            `rule '${rule.id}' declares patterns that match no file in this project (${patterns.join(', ')}), so its result cannot be cached and is re-checked every run. Patterns are relative to the project root, not to the tool's cwd.\n`,
          );
        }

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
          !uncacheable &&
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
        } else if (!uncacheable) {
          await store.put(rule.id, PROJECT_KEY, {
            hash: cacheHash,
            value: execution.violations,
            meta: { fingerprint },
          });
        }
        violationsByRule.set(rule.id, execution.violations);
      }

      // ── Aggregation ──────────────────────────────────────────────────────
      const aggregate = aggregateRun({
        activeRules,
        violationsByRule,
        config,
        baseline: options.baseline,
        fileFilter,
        fileFilterActive,
        requestedPaths,
        failedRules,
      });

      options.onScan?.({
        filesSeen: allPaths.length,
        added: synced.added.length,
        changed: synced.changed.length,
        removed: synced.removed.length,
        reused: synced.reused.length,
        // The scan's own duration, not how long the run has been going: this line
        // is how a user tells a slow scan from slow rules.
        durationMs: synced.durationMs,
      });

      return {
        byRule: aggregate.results,
        byCategory: aggregate.byCategory,
        totalViolations: aggregate.totalViolations,
        passing: aggregate.passing,
        ...(failedRules.length > 0 ? { failedRules: [...failedRules] } : {}),
        ...(aggregate.baselineStats === undefined ? {} : { baseline: aggregate.baselineStats }),
        ...(aggregate.exemptionSuppressions.length === 0
          ? {}
          : { exemptionSuppressions: aggregate.exemptionSuppressions }),
      };
    } finally {
      await store.close();
    }
  });
