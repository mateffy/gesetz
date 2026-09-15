import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, FileFilter, ProjectRoot, resolveToolBin, resolveToolCwd } from '@gesetz/core';

export interface OxfmtOptions {
  /**
   * File glob(s) or paths to check. Passed to `oxfmt --list-different <paths>`.
   * Default: '.' (current directory)
   */
  pattern?: string | string[];
  /** Working directory. Default: the project root. */
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

  const stdout = await Effect.runPromise(execTool(bin, args, cwd, 'oxfmt'));

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
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  // Resolved at run time against the project root, not at config-evaluation
  // time against `process.cwd()`.
  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return {
      bin: resolveToolBin(opts.bin, cwd, [nodePath.join('node_modules', '.bin', 'oxfmt')], 'oxfmt'),
      cwd,
    };
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const { bin, cwd } = locate(yield* ProjectRoot);

    const patterns = fileFilter.patterns !== null && fileFilter.patterns.length > 0
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
      patterns: opts.pattern !== undefined ? defaultPatterns : ['**/*'],
      run: (ctx) => {
        const { bin, cwd } = locate(ctx.rootDir);
        return executeOxfmt(opts, id, bin, cwd, defaultPatterns);
      },
    },
  };
}
