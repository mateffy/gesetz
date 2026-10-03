import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, ToolReplacement, Violation } from '@gesetz/core';
import {
  FileFilter,
  ProjectRoot,
  execToolResult,
  resolveToolBin,
  resolveToolCwd,
  scopedPatterns,
  toolWatchPatterns,
} from '@gesetz/core';

export interface TscOptions {
  /** What the checker is responsible for. Default: every TypeScript file. */
  pattern?: string | string[];
  /** The binary to run. Default `tsc`; use `vue-tsc` for Vue projects. */
  bin?: string;
  /**
   * Extra arguments, e.g. `['--project', 'tsconfig.build.json']`.
   *
   * With `--project`/`-p` the rule does **not** append file paths: tsc refuses file
   * arguments alongside a project, so the project decides what is checked. A
   * `--files` request still filters the *report*; it cannot narrow the work.
   */
  args?: string[];
  /** Directory to run in. Default: the project root. */
  cwd?: string;
  label?: string;
  id?: string;
  category?: string;
}

/** The part of a tool run this parser needs. */
export interface TscRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

/** `src/a.ts(12,5): error TS2322: Type 'x' is not assignable to type 'y'.` */
const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

/** A path tsc printed, as a project-root-relative one. */
function toProjectPath(file: string, cwd: string, projectRoot: string): string {
  const absolute = nodePath.isAbsolute(file) ? file : nodePath.resolve(cwd, file);
  return nodePath.relative(projectRoot, absolute).split(nodePath.sep).join('/');
}

function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * Maps a type-checker run to violations.
 *
 * The status is why this takes the whole run rather than just stdout. A checker that
 * ran and found nothing and one that died before it looked both produce no
 * diagnostics, and only the status tells them apart — reporting the second as clean
 * would be a green gate over a project nobody examined, which is the one outcome this
 * codebase refuses everywhere else. A non-zero status *with* diagnostics is normal:
 * that is simply a checker that found something.
 */
export function parseTscOutput(
  run: TscRun,
  context: { readonly cwd: string; readonly projectRoot: string; readonly ruleId: string },
): Violation[] {
  const violations: Violation[] = [];

  for (const raw of run.stdout.split('\n')) {
    const match = DIAGNOSTIC.exec(raw.trim());
    if (match === null) continue;
    const [, file, line, , code, message] = match;
    if (file === undefined || line === undefined || code === undefined || message === undefined) {
      continue;
    }
    violations.push({
      rule: context.ruleId,
      message: `${code}: ${message}`,
      path: toProjectPath(file, context.cwd, context.projectRoot),
      line: Number(line),
      severity: 'error',
      source: 'tsc',
    });
  }

  if (violations.length > 0) return violations;
  if (run.status === 0) return [];

  const detail = firstLine(run.stderr) || firstLine(run.stdout) || 'no output';
  return [
    {
      rule: context.ruleId,
      message:
        `tsc exited with status ${run.status === null ? 'a signal' : run.status} and reported ` +
        `no diagnostic, so nothing was checked: ${detail}. Fix the tool, then re-run.`,
      path: '.',
      severity: 'error',
      source: 'tsc',
    },
  ];
}

const DEFAULT_FILES = ['**/*.{ts,tsx}'];

/** Config a type check reads, so editing it re-runs the check. */
const CONFIG_FILES = ['tsconfig.json', 'tsconfig.*.json', 'jsconfig.json'];

const hasProjectFlag = (args: readonly string[]): boolean =>
  args.some((arg) => arg === '-p' || arg === '--project' || arg.startsWith('--project='));

/**
 * The arguments for one type check.
 *
 * `files` are concrete paths, never globs: tsc does not expand patterns, it opens
 * what it is given. Handing it a pattern fails the whole run with "unsupported
 * extension", which at least fails loudly — but the fix is not to pass patterns.
 *
 * With `--project` the files are dropped: tsc refuses file arguments alongside a
 * project, and the project is the better answer anyway, since it carries the compiler
 * options the files must be checked under.
 */
export function tscArgs(
  extraArgs: readonly string[],
  files: readonly string[] | null,
): string[] {
  const args = ['--noEmit', '--pretty', 'false', ...extraArgs];
  if (files !== null && !hasProjectFlag(extraArgs)) args.push(...files);
  return args;
}

/**
 * Creates a Rule that runs the TypeScript compiler and maps its diagnostics to
 * Violations.
 *
 * A **project** rule, not a per-file one: a type error is usually a fact about a file
 * *and* the files it imports, so a per-file rule would report clean for a file whose
 * types depend on a neighbour that changed.
 *
 * @example
 * tsc({ pattern: 'apps/web', args: ['--project', 'apps/web/tsconfig.json'] })
 */
export function tsc(opts: TscOptions = {}): Rule {
  const id = opts.id ?? 'tsc';

  /**
   * What an agent would otherwise run. `gesetz skill` prints this, generated from
   * the project's configuration so nothing has to be maintained by hand.
   */
  const replaces: ToolReplacement[] = [
    { instead: 'tsc --noEmit', use: 'gesetz check --rule tsc' },
    {
      instead: 'bun run typecheck',
      use: 'gesetz check --rule tsc',
      note: 'when that script runs tsc',
    },
  ];
  const description = opts.label ?? 'TypeScript type check';
  const filePatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : [...DEFAULT_FILES];
  const extraArgs = opts.args ?? [];

  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return { bin: resolveToolBin(opts.bin, cwd, ['tsc'], 'tsc'), cwd };
  };

  const check = async (
    projectRoot: string,
    requestedPaths: readonly string[] | null | undefined,
  ): Promise<Violation[]> => {
    const { bin, cwd } = locate(projectRoot);

    // No request: the project decides what to check, and no file arguments are passed
    // at all, so the checker uses the tsconfig the project wrote for itself.
    // A request: only the requested files this rule covers. A request that covers none
    // of them means there is nothing to do — and skipping is the only honest answer,
    // because a checker handed no paths either errors out or checks everything.
    const files =
      requestedPaths === null || requestedPaths === undefined
        ? null
        : scopedPatterns(requestedPaths, filePatterns);
    if (files === null && requestedPaths !== null && requestedPaths !== undefined) return [];

    const args = tscArgs(extraArgs, files);
    const run = await Effect.runPromise(execToolResult(bin, args, cwd, 'tsc'));
    return parseTscOutput(run, { cwd, projectRoot, ruleId: id });
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const projectRoot = yield* ProjectRoot;
    const requested =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : null;
    return yield* Effect.promise(() => check(projectRoot, requested));
  });

  return {
    id,
    replaces,
    description,
    run,
    category: opts.category,
    project: {
      // Watching the compiler's config matters as much as watching sources: editing
      // `tsconfig.json` changes every answer this rule has.
      patterns: toolWatchPatterns([...filePatterns, ...CONFIG_FILES]),
      run: (ctx) => check(ctx.rootDir, ctx.requestedPaths),
    },
  };
}
