/**
 * Pure helpers for the `check` command: how a caller spelled its request, and how
 * a category filter and a threshold override resolve into the rules that will run.
 *
 * The command itself is wired in `main.ts`, which owns the engine-specific storage
 * resolution; these two are kept here because they are the parts worth testing on
 * their own.
 */
import type { CategoryThreshold, Rule } from '@gesetz/core';

/**
 * The files a run was asked about, from however the caller spelled it.
 *
 * Both spellings are accepted and they combine: `--files a.ts,b.ts` and
 * `--files a.ts --files b.ts` are the same request. A path is a glob, so an exact
 * file name is a valid entry. Returns null when nothing was asked for, which
 * means "the whole project" rather than "no files".
 */
export const parseFileRequest = (values: readonly string[]): string[] | null => {
  const globs = values
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return globs.length > 0 ? globs : null;
};

export const resolveCheckScope = (input: {
  rules: readonly Rule[];
  configuredThresholds: readonly CategoryThreshold[];
  categoryFilter: string | undefined;
  thresholdOverride: number | undefined;
}): { rules: Rule[]; thresholds: CategoryThreshold[] } => {
  const wanted =
    input.categoryFilter === undefined
      ? null
      : new Set(
          input.categoryFilter
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
        );
  const rules =
    wanted === null
      ? [...input.rules]
      : input.rules.filter((rule) => rule.category !== undefined && wanted.has(rule.category));
  const thresholds =
    input.thresholdOverride === undefined
      ? [...input.configuredThresholds]
      : [...new Set(rules.map((rule) => rule.category).filter((c): c is string => c !== undefined))]
          .sort()
          .map((category) => ({ category, minScore: input.thresholdOverride as number }));
  return { rules, thresholds };
};
