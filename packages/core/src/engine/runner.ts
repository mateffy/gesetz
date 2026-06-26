import * as childProcess from 'node:child_process';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import type { Violation, Exemption } from './rule';
import type { ResolvedConfig } from './config';
import type { FileSystem, ProjectRoot } from '../services/fs';
import { FileFilter } from '../services/fs';
import type { TsAdapter } from '../services/ts-adapter';
import type { PhpAdapter } from '../services/php-adapter';

export interface RuleResult {
  readonly ruleId: string;
  readonly description: string;
  readonly category: string | undefined;
  readonly violations: Violation[];
}

/**
 * Score for a single category, computed from all rules in that category.
 *
 * Score formula (same as Regel):
 *   weighted = errors * 1.0 + warnings * 0.5 + infos * 0.1
 *   score    = max(0, 10 - weighted)
 */
export interface CategoryScore {
  readonly category: string;
  /** 0–10, higher is better */
  readonly score: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly totalViolations: number;
  /** Rule IDs that contributed to this category */
  readonly ruleIds: string[];
  /** Whether this category meets its configured threshold */
  readonly passing: boolean;
}

export interface RunResult {
  readonly byRule: RuleResult[];
  readonly byCategory: CategoryScore[];
  readonly totalViolations: number;
  /** True when all category scores are at or above their thresholds */
  readonly passing: boolean;
}

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

/**
 * Computes category scores from rule results and config thresholds.
 */
function computeCategoryScores(
  results: RuleResult[],
  thresholds: ResolvedConfig['thresholds'],
): CategoryScore[] {
  const byCategory = new Map<string, { errors: number; warnings: number; infos: number; ruleIds: string[] }>();

  for (const result of results) {
    if (!result.category) continue;
    const existing = byCategory.get(result.category) ?? { errors: 0, warnings: 0, infos: 0, ruleIds: [] };
    for (const v of result.violations) {
      if (v.severity === 'error') existing.errors++;
      else if (v.severity === 'warn') existing.warnings++;
      else existing.infos++;
    }
    existing.ruleIds.push(result.ruleId);
    byCategory.set(result.category, existing);
  }

  return Array.from(byCategory.entries()).map(([category, counts]) => {
    const weighted = counts.errors * 1.0 + counts.warnings * 0.5 + counts.infos * 0.1;
    const score = Math.max(0, Math.round((10 - weighted) * 10) / 10);
    const threshold = thresholds.find((t) => t.category === category)?.minScore ?? 7;
    return {
      category,
      score,
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      totalViolations: counts.errors + counts.warnings + counts.infos,
      ruleIds: counts.ruleIds,
      passing: score >= threshold,
    };
  });
}

/**
 * Applies exemptions to a list of violations.
 * An exemption suppresses a violation when:
 * 1. The violation path matches the exemption path glob
 * 2. The violation rule matches the exemption rule glob (default: '*')
 * 3. The exemption is not expired (until date is absent or in the future)
 */
export function applyExemptions(
  violations: Violation[],
  exemptions: Exemption[],
  ruleId: string,
): Violation[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return violations.filter((violation) => {
    return !exemptions.some((exemption) => {
      // Check expiry
      if (exemption.until !== undefined && exemption.until < today) {
        return false; // Expired exemption — does not suppress
      }
      // Check rule match
      const rulePattern = exemption.rule ?? '*';
      if (!micromatch.isMatch(ruleId, rulePattern)) {
        return false;
      }
      // Check path match
      return micromatch.isMatch(violation.path, exemption.path);
    });
  });
}

/**
 * Runs all rules in the config, applies exemptions, and returns a RunResult.
 *
 * Rules run concurrently (max 5 at once). Rule errors are caught and reported
 * as special violations so a broken rule doesn't prevent others from running.
 *
 * Requires a `FileFilter` in the environment. When no `--files` filter is
 * active, provide `FileFilterLive(null)` (the default in the CLI and test
 * runner) — it scans everything.
 */
export const runAll = (
  config: ResolvedConfig,
): Effect.Effect<RunResult, never, FileSystem | TsAdapter | PhpAdapter | ProjectRoot | FileFilter> =>
  Effect.gen(function* () {
    const changedFiles = resolveChangedFiles(config.changedSince, config.projectRoot);
    const fileFilter = yield* FileFilter;

    const results = yield* Effect.all(
      config.rules.map((rule) =>
        rule.run.pipe(
          Effect.map((violations) => {
            // Apply the --files filter: suppress violations for non-matching files.
            // This catches external-tool adapters (eslint, oxlint, phpstan, vitest,
            // prettier, …) that don't use select()'s file scanning.
            const fileFiltered = fileFilter.patterns !== null && fileFilter.patterns.length > 0
              ? violations.filter((v) => fileFilter.matches(v.path))
              : violations;
            // Apply changedSince filter: suppress violations for unchanged files
            const filtered = changedFiles !== null
              ? fileFiltered.filter((v) => changedFiles.has(v.path))
              : fileFiltered;
            return applyExemptions(filtered, config.exemptions, rule.id);
          }),
          // Rules should not fail (error = never), but we catch defects defensively
          Effect.catchAllCause((cause) =>
            Effect.succeed<Violation[]>([
              {
                rule: rule.id,
                message: `Rule threw an unexpected error: ${String(cause)}`,
                path: config.projectRoot,
                severity: 'error' as const,
                source: 'core' as const,
              },
            ]),
          ),
          Effect.map(
            (violations): RuleResult => ({
              ruleId: rule.id,
              description: rule.description,
              category: rule.category,
              violations,
            }),
          ),
        ),
      ),
      { concurrency: 5 },
    );

    const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);
    const byCategory = computeCategoryScores(results, config.thresholds);
    const passing = byCategory.length === 0 || byCategory.every((c) => c.passing);

    return { byRule: results, byCategory, totalViolations, passing };
  });
