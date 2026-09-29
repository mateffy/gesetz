/**
 * Running one rule: per-file checks, file-system rules, and project rules.
 *
 * Kept out of `runner.ts` so that file stays about orchestration — what to scan,
 * what to cache, and how a run is accounted for.
 */
import { readFile } from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import micromatch from 'micromatch';
import { Effect } from 'effect';
import type { CacheEntry, FileRef } from '../cache';
import type { CheckServices, File, Violation, Rule, ProjectRuleOutcome } from './rule';
import { servicesLayer } from './services-layer';

export function resolveChangedFiles(
  changedSince: string | undefined,
  projectRoot: string,
): Set<string> | null {
  if (!changedSince) return null;
  try {
    const output = childProcess
      .execFileSync('git', ['diff', '--name-only', changedSince], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
      .trim();
    if (!output) return new Set();
    return new Set(output.split('\n').map((p) => p.trim()).filter(Boolean));
  } catch {
    // git not available or ref invalid — fall through to no filter
    return null;
  }
}

export function matchesPerFile(path: string, perFile: NonNullable<Rule['perFile']>): boolean {
  if (!micromatch.isMatch(path, [...perFile.patterns], { dot: true })) return false;
  if (
    perFile.exclusions.length > 0 &&
    micromatch.isMatch(path, [...perFile.exclusions], { dot: true })
  ) {
    return false;
  }
  return true;
}

export function fileFromRef(reference: FileRef, content: string): File {
  const slash = reference.path.lastIndexOf('/');
  const name = slash === -1 ? reference.path : reference.path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  const stem = dot === -1 ? name : name.slice(0, dot);
  return {
    path: reference.path,
    absolutePath: reference.absolutePath,
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : reference.path.slice(0, slash),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Runs every check of a per-file rule against an already-built `File`. */
export async function runChecks(
  rule: Rule,
  file: File,
  services: CheckServices,
): Promise<Violation[]> {
  const perFile = rule.perFile;
  if (perFile === undefined) return [];
  if (!perFile.predicates.every((predicate) => predicate(file))) return [];

  const violations: Violation[] = [];
  for (const check of perFile.checks) {
    // Checks never throw — same contract as the v2 runner.
    violations.push(...(await check(file, services).catch((): Violation[] => [])));
  }
  return violations.map((violation) => ({ ...violation, rule: violation.rule ?? rule.id }));
}

/**
 * True when any of a rule's checks asks the file system rather than being a
 * function of its own file.
 *
 * Such a rule cannot be cached against file content: `requireTest` asks whether a
 * test file *exists*, so adding it changes the answer without touching the source.
 */
export function ruleReadsFileSystem(rule: Rule): boolean {
  const checks = rule.perFile?.checks;
  if (checks === undefined || checks.length === 0) return false;
  return checks.some((check) => check.needsFileSet === true);
}

/**
 * Runs a file-system rule over the files it covers.
 *
 * This is the per-file check loop, run over a whole rule's file set instead of one
 * file at a time, in the project pass — because the answer depends on more than
 * one file. It reads each covered file and runs the checks; they ask `fs.exists`
 * against the run's file list, so nothing is parsed and recomputing is cheap.
 */
export async function executeFileSystemRule(
  rule: Rule,
  relevant: readonly FileRef[],
  services: CheckServices,
): Promise<{ violations: Violation[]; failed: boolean; examinedPaths: string[] }> {
  const violations: Violation[] = [];
  const examinedPaths: string[] = [];
  for (const reference of relevant) {
    let content: string;
    try {
      content = await readFile(reference.absolutePath, 'utf-8');
    } catch {
      continue; // vanished since discovery
    }
    examinedPaths.push(reference.path);
    violations.push(...(await runChecks(rule, fileFromRef(reference, content), services)));
  }
  return { violations, failed: false, examinedPaths };
}

/** Human-readable detail for a rule failure, preferring the error message. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return String(cause);
}

/**
 * Executes a project-level rule (tool adapter, architecture rule, or cycle
 * check). Failures become a critical violation unless `throwOnError` is set.
 */
export async function executeProjectRule(
  rule: Rule,
  context: {
    readonly rootDir: string;
    readonly changedFiles: readonly string[];
    readonly requestedPaths: readonly string[] | null;
  },
  services: CheckServices,
  fileFilter: readonly string[] | null,
  throwOnError: boolean,
): Promise<{ violations: Violation[]; failed: boolean; examinedPaths?: readonly string[] }> {
  try {
    if (rule.project === undefined) {
      const violations = await Effect.runPromise(
        Effect.provide(rule.run, servicesLayer(services, fileFilter)),
      );
      return { violations, failed: false };
    }
    const outcome: ProjectRuleOutcome = await rule.project.run(context);
    if ('violations' in outcome) {
      return {
        violations: [...outcome.violations],
        failed: false,
        ...(outcome.examinedPaths === undefined
          ? {}
          : { examinedPaths: outcome.examinedPaths }),
      };
    }
    return { violations: [...outcome], failed: false };
  } catch (cause) {
    if (throwOnError) throw cause;
    return {
      failed: true,
      violations: [
        {
          rule: rule.id,
          message: `Rule '${rule.id}' threw an unexpected error: ${describeCause(cause)}`,
          path: context.rootDir,
          severity: 'error',
          source: 'core',
          fix: 'Fix the underlying tool or rule so it can run. Pass --throw to surface the full error instead of a violation.',
        },
      ],
    };
  }
}
