/**
 * Result types and scoring.
 *
 * Kept separate from `runner.ts` so the orchestration file stays within the
 * project's file-size budget, and because these are pure functions over rule
 * results — they need no cache, no filesystem, and no Effect.
 */
import micromatch from 'micromatch';
import type { Exemption, Violation } from './rule';
import type { ResolvedConfig } from './config';

export interface RuleResult {
  readonly ruleId: string;
  readonly description: string;
  readonly category: string | undefined;
  readonly violations: Violation[];
}

/**
 * Score for a single category, computed from all rules in that category.
 *
 * Score formula:
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
  /**
   * Rule ids that could not run (a tool adapter, architecture rule, or cycle
   * check threw). Their failure is reported as a critical violation and the run
   * never passes, even when every category score is at or above its threshold.
   * Absent when no rule failed.
   */
  readonly failedRules?: readonly string[] | undefined;
}

/** Computes category scores from rule results and config thresholds. */
export function computeCategoryScores(
  results: RuleResult[],
  thresholds: ResolvedConfig['thresholds'],
): CategoryScore[] {
  const byCategory = new Map<
    string,
    { errors: number; warnings: number; infos: number; ruleIds: string[] }
  >();

  for (const result of results) {
    if (!result.category) continue;
    const existing =
      byCategory.get(result.category) ?? { errors: 0, warnings: 0, infos: 0, ruleIds: [] };
    for (const violation of result.violations) {
      if (violation.severity === 'error') existing.errors += 1;
      else if (violation.severity === 'warn') existing.warnings += 1;
      else existing.infos += 1;
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
      if (exemption.until !== undefined && exemption.until < today) {
        return false; // Expired exemption — does not suppress
      }
      const rulePattern = exemption.rule ?? '*';
      if (!micromatch.isMatch(ruleId, rulePattern)) {
        return false;
      }
      return micromatch.isMatch(violation.path, exemption.path);
    });
  });
}
