/**
 * Rule filtering, for `--rule`.
 *
 * A filter is globbed, so `--rule 'no-*'` names a family and a tool name names the
 * rule that tool contributed. A filter matching no rule is an error, not an empty
 * run: an agent that believes it checked something must not be told a quiet nothing.
 */
import micromatch from 'micromatch';
import type { Rule } from '../engine/rule';

export function filterRules(rules: readonly Rule[], filter: readonly string[] | null): Rule[] {
  if (filter === null) return [...rules];
  const kept = rules.filter((rule) => micromatch.some([rule.id], [...filter]));
  if (kept.length === 0) {
    const known = rules
      .map((rule) => rule.id)
      .sort()
      .join(', ');
    throw new Error(`no rule matches '${filter.join(', ')}'. Rules in this config: ${known}`);
  }
  return kept;
}
