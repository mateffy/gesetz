/**
 * Turns the paths an external tool is invoked with into the file globs that
 * decide when its rule needs to run again.
 *
 * These are two different kinds of pattern and conflating them silently broke
 * every external-tool gate in this repository.
 *
 *   `oxfmt({ pattern: 'packages' })` runs `oxfmt --list-different packages`,
 *   so `'packages'` is a **directory to lint**. The compiled project rule also
 *   used it as a micromatch glob against changed file paths, where
 *   `micromatch.some(['packages/cli/src/x.ts'], ['packages'])` is `false`.
 *
 * The rule therefore never looked "relevant", never re-ran, and went on
 * reporting whatever it found the first time — a gate frozen at a stale answer,
 * including one frozen at "clean". The default `'.'` had the same problem.
 *
 * A directory becomes `<dir>` followed by a recursive glob, a real glob is kept,
 * and a specific file is
 * kept. Tool configuration files are the caller's business: pass them in too so
 * editing the tool's config re-runs the rule.
 */
export function toolWatchPatterns(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === '') continue;
    // already a glob
    if (/[*?{}[\]]/.test(pattern)) {
      out.add(pattern);
      continue;
    }
    // the whole project
    if (pattern === '.' || pattern === './') {
      out.add('**/*');
      continue;
    }
    // a specific file
    if (/\.[A-Za-z0-9]+$/.test(pattern)) {
      out.add(pattern);
      continue;
    }
    // a directory
    out.add(`${pattern.replace(/\/+$/, '')}/**/*`);
  }
  return [...out];
}
