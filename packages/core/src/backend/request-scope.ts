/**
 * Narrowing a run to the files a caller asked about.
 *
 * `--files` used to be an aggregation-time filter: every rule ran, every tool ran
 * over the whole project, and the report simply hid the violations nobody asked
 * for. That is a report filter, not a scope, and it does none of the work
 * reduction a caller asking for three files expects.
 *
 * This module turns the request into concrete paths and decides which rules have
 * anything to say about them. The rules that remain are then compiled so they
 * look only at those paths, which is what makes the run cheaper.
 *
 * Two invariants hold, and both are tested:
 *
 *   1. A scoped run never clears or rewrites the marks of a file outside the
 *      request. Marks for a file change only when that file is examined.
 *   2. A scoped run never hides a change from a later, wider run. Files keep
 *      their content fingerprints whether or not a given rule looked at them, so
 *      the next run that covers them re-checks them.
 */
import micromatch from 'micromatch';
import type { Rule } from '../engine/rule';

/**
 * The project files a request's globs match, out of the paths the run already
 * discovered. Nothing is walked here: the caller has the list.
 */
export function expandRequest(paths: readonly string[], globs: readonly string[]): string[] {
  const wanted = globs.filter((glob) => glob.trim() !== '');
  if (wanted.length === 0) return [...paths];
  return paths.filter((path) => micromatch.some([path], [...wanted]));
}

/** Every path a rule declares an interest in. Empty when it declares none. */
function patternsOf(rule: Rule): readonly string[] {
  return rule.perFile?.patterns ?? rule.project?.patterns ?? [];
}

/** A path a rule would check: matching its patterns, and not excluded. */
function ruleCovers(rule: Rule, path: string): boolean {
  const patterns = patternsOf(rule);
  if (patterns.length === 0) return true;
  const exclusions = rule.perFile?.exclusions ?? [];
  if (exclusions.length > 0 && micromatch.some([path], [...exclusions])) return false;
  return micromatch.some([path], [...patterns]);
}

/**
 * The rules that can say anything about the requested files.
 *
 * A rule with nothing to look at is dropped rather than run and then filtered:
 * dropping it is the difference between a scoped run and a scoped report. A rule
 * that declares no patterns is kept, because nothing here can prove it idle.
 */
export function rulesForRequest(rules: readonly Rule[], requestedPaths: readonly string[]): Rule[] {
  if (requestedPaths.length === 0) return [...rules];
  return rules.filter((rule) => requestedPaths.some((path) => ruleCovers(rule, path)));
}
