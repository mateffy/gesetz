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
import micromatch from 'micromatch';

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

/**
 * The subset of `changedFiles` a tool is responsible for, or null when the tool
 * has nothing to check this scan.
 *
 * Only sound for a tool whose answer for file X depends solely on file X — a
 * formatter, a linter, per-file static analysis. A test runner or a browser tool
 * answers about the project, not about a file, and must not be scoped this way.
 *
 * Null and `[]` are different answers, and returning empty is the dangerous one:
 * a tool handed no paths scans nothing, reports nothing, and looks exactly like
 * a clean project. The caller must skip the tool instead, and must report the
 * paths it examined so the marks for untouched files are left alone.
 */
export function scopedPatterns(
  changedFiles: readonly string[],
  toolPatterns: readonly string[],
): string[] | null {
  const matches = changedFiles.filter((path) => micromatch.some([path], [...toolPatterns]));
  return matches.length > 0 ? matches : null;
}

/**
 * The paths a tool should be invoked with.
 *
 * Two very different situations, and conflating them is how a tool ends up
 * checking the wrong set:
 *
 * - **No `--files` request.** The tool runs over its own configured patterns,
 *   exactly as it always has. That is what its cached result is keyed by, and it
 *   is the whole project the rule is responsible for.
 * - **A request.** Only the requested files the tool covers. A request that
 *   matches nothing returns null, and the caller must skip the tool: handing it an
 *   empty list makes it scan nothing and report success.
 */
export function toolScope(
  requestedPaths: readonly string[] | null | undefined,
  toolPatterns: readonly string[],
): readonly string[] | null {
  if (requestedPaths === null || requestedPaths === undefined) return toolPatterns;
  return scopedPatterns(requestedPaths, toolPatterns);
}
