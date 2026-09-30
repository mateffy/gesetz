/**
 * Turning a run's raw violations into a result: filters, input.baseline, scores, verdict.
 *
 * Kept out of `runner.ts` so that file stays about orchestration and this one about
 * accounting.
 */
import micromatch from 'micromatch';
import type { ResolvedConfig } from './config';
import type { Rule, Violation } from './rule';
import { applyExemptions, applyExemptionsWithCounts, computeCategoryScores } from './result';
import type { ExemptionSuppression, RuleResult, RunResult } from './result';
import { partitionByBaseline, type BaselineStats } from './baseline-apply';
import { STALE_RULE_ID, type BaselineFile } from './baseline';
import { resolveChangedFiles } from './rule-execution';

export interface AggregateInput {
  readonly activeRules: readonly Rule[];
  readonly violationsByRule: ReadonlyMap<string, Violation[]>;
  readonly config: ResolvedConfig;
  readonly baseline: BaselineFile | null | undefined;
  readonly fileFilter: readonly string[] | null;
  readonly fileFilterActive: boolean;
  readonly requestedPaths: readonly string[] | null;
  readonly failedRules: readonly string[];
}

export interface AggregateOutput {
  readonly results: RuleResult[];
  readonly byCategory: ReturnType<typeof computeCategoryScores>;
  readonly totalViolations: number;
  readonly passing: boolean;
  readonly baselineStats: BaselineStats | undefined;
  /** Suppressions by exemptions that named no rule — see `RunResult`. */
  readonly exemptionSuppressions: readonly ExemptionSuppression[];
}

export function aggregateRun(input: AggregateInput): AggregateOutput {
const buildResult = (
  ruleId: string,
  description: string,
  category: string | undefined,
): RuleResult => {
  let violations = input.violationsByRule.get(ruleId) ?? [];
  if (input.fileFilterActive && input.fileFilter !== null) {
    violations = violations.filter((violation) =>
      micromatch.isMatch(violation.path, [...input.fileFilter ?? []]),
    );
  }
  if (changedSinceFiles !== null) {
    violations = violations.filter((violation) => changedSinceFiles.has(violation.path));
  }
  const exempted = applyExemptionsWithCounts(violations, input.config.exemptions, ruleId);
  for (const suppression of exempted.suppressed) {
    // Only the rule-less ones are collected: a rule-scoped exemption already says
    // what it covers, and reporting every one of them would be noise.
    if (suppression.rule !== '*') continue;
    const key = suppression.path;
    const seen = rulelessSuppressions.get(key) ?? { count: 0, rules: new Set<string>() };
    seen.count += suppression.count;
    seen.rules.add(ruleId);
    rulelessSuppressions.set(key, seen);
  }
  return { ruleId, description, category, violations: exempted.kept };
};

const changedSinceFiles = resolveChangedFiles(input.config.changedSince, input.config.projectRoot);
/** keyed on the exemption's path glob */
const rulelessSuppressions = new Map<string, { count: number; rules: Set<string> }>();
/**
 * Whether a path is inside what this run examined. A `--since` or `--files`
 * run cannot see files outside its scope, so a baseline entry for such a file
 * is not stale — it was simply not looked at.
 */
const inScope = (path: string): boolean => {
  if (input.fileFilterActive && input.fileFilter !== null && !micromatch.isMatch(path, [...input.fileFilter ?? []])) {
    return false;
  }
  if (changedSinceFiles !== null && !changedSinceFiles.has(path)) return false;
  return true;
};

let results: RuleResult[] = input.activeRules.map((rule) =>
  buildResult(rule.id, rule.description, rule.category),
);

let baselineStats: BaselineStats | undefined;
if (input.baseline !== undefined && input.baseline !== null) {
  const modes = new Map(
    input.config.rules.map((rule) => [rule.id, rule.baselineMessage ?? 'normalized'] as const),
  );
  const partition = partitionByBaseline(
    results.map((result) => ({ rule: result.ruleId, violations: result.violations })),
    input.baseline,
    {
      modes,
      inScope,
      allowStale: (path) =>
        applyExemptions(
          [{ message: '', path, severity: 'error', source: 'core' }],
          input.config.exemptions,
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
      description: 'A input.baseline entry no longer matches a violation',
      category: undefined,
      violations: [...partition.stale],
    });
  }
  baselineStats = partition.stats;
}

const totalViolations = results.reduce((sum, result) => sum + result.violations.length, 0);
const byCategory = computeCategoryScores(results, input.config.thresholds);
// A rule that could not run makes the run incomplete: never report a pass.
const categoriesPass =
  input.failedRules.length === 0 &&
  (byCategory.length === 0 || byCategory.every((category) => category.passing));
// With a input.baseline in play, the input.baseline is the gate: a category score can be
// high enough while a new violation or a stale entry still needs attention.
const passing =
  baselineStats === undefined
    ? categoriesPass
    : categoriesPass && baselineStats.new === 0 && baselineStats.stale === 0;

  const exemptionSuppressions: ExemptionSuppression[] = [...rulelessSuppressions]
    .map(([path, seen]) => ({
      path,
      rule: '*',
      ruleId: [...seen.rules].sort().join(', '),
      count: seen.count,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { results, byCategory, totalViolations, passing, baselineStats, exemptionSuppressions };
}

/**
 * Narrows a whole-tree result to one caller's scope.
 *
 * This is what makes a fleet share work: one agent pays for the whole-tree run, and
 * every scoped request afterwards is answered from its record instead of scanning
 * and checking the tree again. Narrowing is a filter, never a re-check, so it is
 * only sound for a record that examined everything.
 *
 * Recomputed for the caller's scope: the violations, the category scores, and both
 * numbers that decide the verdict — `new` and `stale`. Carrying the whole tree's
 * stale count through would fail a scoped caller for entries outside its scope, and
 * stale entries are derivable: they are the violations the run filed under
 * `STALE_RULE_ID`. `baselined` is not derivable (a baselined violation is dropped
 * from the result rather than reported), so it stays the whole-tree number for the
 * rules that appear here, and `coordination.reusedScope` in the envelope says where
 * the numbers came from.
 */
export function narrowRunResult(
  result: RunResult,
  options: {
    readonly fileFilter: readonly string[] | null;
    readonly changedPaths: ReadonlySet<string> | null;
    readonly thresholds: ResolvedConfig['thresholds'];
  },
): RunResult {
  const inScope = (path: string): boolean => {
    if (
      options.fileFilter !== null &&
      options.fileFilter.length > 0 &&
      !micromatch.isMatch(path, [...options.fileFilter])
    ) {
      return false;
    }
    if (options.changedPaths !== null && !options.changedPaths.has(path)) return false;
    return true;
  };

  const byRule = result.byRule.map((entry) => ({
    ...entry,
    violations: entry.violations.filter((violation) => inScope(violation.path)),
  }));
  const staleCount = byRule
    .filter((entry) => entry.ruleId === STALE_RULE_ID)
    .reduce((sum, entry) => sum + entry.violations.length, 0);
  const newCount = byRule
    .filter((entry) => entry.ruleId !== STALE_RULE_ID)
    .reduce((sum, entry) => sum + entry.violations.length, 0);
  const totalViolations = byRule.reduce((sum, entry) => sum + entry.violations.length, 0);
  const byCategory = computeCategoryScores(byRule, options.thresholds);
  const categoriesPass =
    (result.failedRules ?? []).length === 0 &&
    (byCategory.length === 0 || byCategory.every((category) => category.passing));

  const baseline =
    result.baseline === undefined
      ? undefined
      : {
          ...result.baseline,
          new: newCount,
          stale: staleCount,
          byRule: byRule
            .filter((entry) => entry.violations.length > 0)
            .map((entry) => {
              const recorded = result.baseline?.byRule.find((r) => r.rule === entry.ruleId);
              return {
                rule: entry.ruleId,
                new: entry.ruleId === STALE_RULE_ID ? 0 : entry.violations.length,
                baselined: recorded?.baselined ?? 0,
                stale: entry.ruleId === STALE_RULE_ID ? entry.violations.length : 0,
              };
            }),
        };

  return {
    ...result,
    byRule,
    byCategory,
    totalViolations,
    ...(baseline === undefined ? {} : { baseline }),
    // A whole-tree run's exemption notices are about the whole tree; printing them
    // for a scoped caller would be noise about files it did not ask about.
    ...(result.exemptionSuppressions === undefined ? {} : { exemptionSuppressions: [] }),
    passing:
      categoriesPass && (baseline === undefined || (baseline.new === 0 && baseline.stale === 0)),
  };
}
