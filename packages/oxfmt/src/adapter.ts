import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { FileFilter, execTool, scopedPatterns, toolWatchPatterns } from '@gesetz/core';

export interface OxfmtOptions {
  /**
   * File glob(s) or paths to check. Passed to `oxfmt --list-different <paths>`.
   * Default: '.' (current directory)
   */
  pattern?: string | string[];
  /** Working directory. Default: process.cwd() */
  cwd?: string;
  /** Path to the oxfmt binary. Default: 'node_modules/.bin/oxfmt' */
  bin?: string;
  /** Path to an oxfmt config file. Passed as `-c <path>`. */
  configFile?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'oxfmt' */
  id?: string;
  /** Category for scoring. */
  category?: string;
}

/**
 * Creates a Rule that runs `oxfmt --list-different` and maps unformatted
 * files to Violations.
 *
 * `--list-different` prints the path of every file whose formatting differs
 * from oxfmt's output, one per line (no trailing newline), and exits 1 when
 * any are found. Each unformatted file becomes a warning-level violation.
 *
 * Requires `oxfmt` to be installed in the target project.
 *
 * @example
 * oxfmt({ pattern: 'src', label: 'oxfmt' })
 */
async function executeOxfmt(
  opts: OxfmtOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[],
): Promise<Violation[]> {
  const args = ['--list-different', ...patterns];
  if (opts.configFile) args.push('-c', opts.configFile);

  const stdout = await Effect.runPromise(
    execTool(bin, args, cwd, 'oxfmt', { requireStdout: true }),
  );

  if (!stdout) return [];

  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((filePath): Violation => ({
      rule: id,
      message: 'File is not formatted — run oxfmt --write to fix',
      path: nodePath.isAbsolute(filePath) ? nodePath.relative(cwd, filePath) : filePath,
      severity: 'warn',
      source: 'custom',
    }));
}

export function oxfmt(opts: OxfmtOptions = {}): Rule {
  const id = opts.id ?? 'oxfmt';
  const description = opts.label ?? 'oxfmt formatting';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? nodePath.join('node_modules', '.bin', 'oxfmt');
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;

    const patterns =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : defaultPatterns;

    return yield* Effect.promise(() => executeOxfmt(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      patterns: toolWatchPatterns(defaultPatterns),
      run: (ctx) => {
        // A formatter's answer for a file depends only on that file, so only the
        // files this scan reprocessed need answering. Reporting `examinedPaths` is
        // what lets the marks for untouched files stand: without it the store
        // would clear them and a violation would vanish unexamined.
        const scoped = scopedPatterns(ctx.changedFiles, defaultPatterns);
        if (scoped === null) return Promise.resolve({ violations: [], examinedPaths: [] });
        return executeOxfmt(opts, id, bin, cwd, scoped).then((violations) => ({
          violations,
          examinedPaths: scoped,
        }));
      },
    },
  };
}
