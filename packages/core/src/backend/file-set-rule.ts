/**
 * Rules whose answers depend on which files exist.
 *
 * `requireTest` and `requireSibling` look for files beside the one they run for.
 * Adding the missing file changes the answer without touching the source, so a
 * content-keyed cache would keep reporting a violation that has been fixed.
 *
 * The first fix was to mix a fingerprint of the whole file set into every rule's
 * key. That was worse than the disease in a repository where files come and go:
 * netzwerk reprocesses *every* file whenever any extension's fingerprint changes,
 * so adding one file re-parsed the entire project — 9,247 files in the repository
 * this was measured on. These rules compile to project rules instead, which re-run
 * when a file is added, changed or removed inside their patterns, and cost nothing
 * to the rules that do not care.
 */
import * as nodePath from 'node:path';
import micromatch from 'micromatch';
import type { NetworkExtension } from 'netzwerk';
import type { CompileContext } from './compile';
import type { File, Rule, Violation } from '../engine/rule';
import {
  hasStoredMarkers,
  networkFileFromStorage,
  refreshSharedPaths,
  ruleFingerprint,
} from './compile-shared';
import { storeProjectViolations } from './project-violations';

/**
 * True when a rule's answers depend on which files exist, and so cannot be cached
 * against file content.
 *
 * A rule is treated as file-set dependent when *any* of its checks says so, in
 * which case all of them run in the project form. Splitting a rule between the two
 * forms would be worse: the same file would be reported by two different paths.
 */
export function needsFileSet(rule: Rule): boolean {
  const checks = rule.perFile?.checks;
  if (checks === undefined || checks.length === 0) return false;
  return checks.some((check) => check.needsFileSet === true);
}

/**
 * A `File` for a record in storage, without going through a `SourceFile`.
 *
 * `gesetzFileFromSource` takes netzwerk's own source-file type, which the scan
 * builds. A project rule walks the stored records instead, so it builds the same
 * shape from a path and the content it read.
 */
function fileFromRecord(rootDir: string, relativePath: string, content: string): File {
  const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const ext = nodePath.extname(name);
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);
  const slash = relativePath.lastIndexOf('/');
  return {
    path: relativePath,
    absolutePath: nodePath.join(rootDir, relativePath),
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : relativePath.slice(0, slash),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Whether this rule is responsible for a path, exclusions included. */
function ruleCovers(perFile: NonNullable<Rule['perFile']>, path: string): boolean {
  if (!micromatch.some([path], [...perFile.patterns])) return false;
  if (perFile.exclusions.length === 0) return true;
  return !micromatch.some([path], [...perFile.exclusions]);
}

/**
 * Runs a rule's checks against one file.
 *
 * A throwing check is reported rather than silently contributing nothing — the
 * same contract as the per-file compiler, and the fail-open shape this project
 * exists to find in other codebases.
 */
async function runChecks(
  rule: Rule,
  checks: NonNullable<Rule['perFile']>['checks'],
  file: File,
  services: Parameters<NonNullable<Rule['perFile']>['checks'][number]>[1],
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const [index, check] of checks.entries()) {
    try {
      violations.push(...(await check(file, services)));
    } catch (cause) {
      violations.push({
        rule: rule.id,
        message: `Check #${index + 1} threw: ${String(cause)}. This file was not fully checked.`,
        path: file.path,
        severity: 'error',
        source: 'core',
      });
    }
  }
  return violations;
}

/**
 * Compiles a rule whose checks consult the file system into a project rule.
 *
 * It runs once per scan over every file the rule matches, in memory — no parsing,
 * just `fs.exists` against the network — and reports which paths it examined, so
 * the marks of everything else are left alone. It re-runs whenever a file is
 * added, changed or removed inside its patterns, which is exactly when a
 * `requireSibling`-style answer can change.
 */
export function compileFileSetRule(rule: Rule, ctx: CompileContext): NetworkExtension {
  const perFile = rule.perFile!;
  return {
    name: rule.id,
    fingerprint: ruleFingerprint(rule),

    async after(entries, extCtx) {
      const changed = entries.map((entry) => entry.path);
      const relevant = micromatch.some(
        [...changed, ...extCtx.removedPaths],
        [...perFile.patterns],
        { dot: true },
      );
      if (!relevant && (await hasStoredMarkers(extCtx.storage, rule.id))) return;

      await refreshSharedPaths(ctx, extCtx);
      const services = ctx.getServices();
      const violations: Violation[] = [];
      const examinedPaths: string[] = [];

      for (const record of await extCtx.storage.listFiles()) {
        if (!ruleCovers(perFile, record.path)) continue;
        const stored = await networkFileFromStorage(extCtx.storage, ctx.rootDir, record.path);
        const file = fileFromRecord(ctx.rootDir, record.path, await stored.content());
        if (!perFile.predicates.every((predicate) => predicate(file))) continue;
        examinedPaths.push(record.path);
        violations.push(...(await runChecks(rule, perFile.checks, file, services)));
      }

      await storeProjectViolations(extCtx.storage, rule, violations, ctx, examinedPaths);
    },
  };
}
