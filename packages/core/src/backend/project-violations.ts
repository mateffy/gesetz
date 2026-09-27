/**
 * Storing a project rule's violations as markers.
 *
 * A project rule's marks are replaced wholesale — every path that carried them is
 * rewritten, with the empty set when the violation disappeared. A rule that
 * examined only *some* files must say which ones, or the marks for the files it
 * did not look at are cleared and a violation disappears without anyone having
 * checked it.
 *
 * Kept out of `compile.ts` so that file stays about compiling rules.
 */
import * as nodePath from 'node:path';
import type { ExtensionContext } from 'netzwerk';
import type { CompileContext } from './compile';
import type { Rule, Violation } from '../engine/rule';
import { violationToMarker } from './violation-markers';

/** A path as the network stores it: relative to the root, with forward slashes. */
export function normalizeRulePath(path: string, rootDir: string): string {
  if (!nodePath.isAbsolute(path)) return path;
  return nodePath.relative(rootDir, path).split(nodePath.sep).join('/');
}

export function groupByPath(
  violations: readonly Violation[],
  rootDir: string,
): { byPath: Map<string, Violation[]>; orphaned: Violation[] } {
  const byPath = new Map<string, Violation[]>();
  const orphaned: Violation[] = [];
  for (const violation of violations) {
    const rel = normalizeRulePath(violation.path, rootDir);
    if (rel === '' || rel.startsWith('..')) {
      orphaned.push(violation);
      continue;
    }
    const list = byPath.get(rel) ?? [];
    list.push({ ...violation, path: rel });
    byPath.set(rel, list);
  }
  return { byPath, orphaned };
}

/**
 * Replaces this rule's stored violation markers with the fresh set: every
 * path that previously carried this rule's markers is overwritten (with the
 * empty set when the violation disappeared), and new paths are stored.
 */
export async function storeProjectViolations(
  storage: ExtensionContext['storage'],
  rule: Rule,
  violations: readonly Violation[],
  ctx: CompileContext,
  examinedPaths?: readonly string[],
): Promise<void> {
  const { byPath, orphaned } = groupByPath(violations, ctx.rootDir);
  // A rule that examined only some files may only rewrite the marks for those
  // files. Clearing the rest would delete violations for files nobody looked at,
  // and the gate would report a clean project it never checked.
  const examined =
    examinedPaths === undefined
      ? null
      : new Set(examinedPaths.map((path) => normalizeRulePath(path, ctx.rootDir)));
  for (const [path, markers] of await storage.allMarkers()) {
    if (byPath.has(path)) continue;
    if (examined !== null && !examined.has(path)) continue;
    if (markers.some((m) => m.extension === rule.id)) {
      await storage.putMarkers(path, rule.id, []);
    }
  }
  for (const [path, pathViolations] of byPath) {
    if ((await storage.getFile(path)) === undefined) {
      orphaned.push(...pathViolations);
      continue;
    }
    await storage.putMarkers(
      path,
      rule.id,
      pathViolations.map((v) => violationToMarker({ ...v, rule: v.rule ?? rule.id }, rule)),
    );
  }
  if (orphaned.length > 0 && ctx.pendingViolations !== undefined) {
    ctx.pendingViolations.push(...orphaned);
  }
}
