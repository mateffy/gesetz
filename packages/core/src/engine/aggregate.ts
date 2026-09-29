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
import type { ExemptionSuppression, RuleResult } from './result';
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
