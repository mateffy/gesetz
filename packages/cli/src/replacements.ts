import type { Rule } from '@gesetz/core';

/**
 * The agent-facing recipe for the adapters this project configured.
 *
 * Generated, never hand-maintained: a project that installs an adapter gets its
 * recipe, and one that installs none is told that plainly.
 *
 * The closing line about what is *not* covered is deliberate. A list of replacements
 * reads as "everything is covered", and an agent that assumes coverage stops looking —
 * which is the same failure as a check that cannot run reporting success.
 */
export function renderReplacements(rules: readonly Rule[]): string {
  const seen = rules.flatMap((rule) => rule.replaces ?? []);

  if (seen.length === 0) {
    return (
      'No configured adapter replaces a command, so run the tools directly. If one of ' +
      'them deserves an adapter, say so.'
    );
  }

  const lines = seen.map(
    (entry) =>
      `- \`${entry.instead}\` → \`${entry.use}\`${entry.note === undefined ? '' : ` (${entry.note})`}`,
  );

  return [
    'Run these through gesetz instead of running the tool yourself:',
    '',
    ...lines,
    '',
    'Tools not listed here are not covered by gesetz: run them directly, and say so if',
    'one of them deserves an adapter.',
  ].join('\n');
}
