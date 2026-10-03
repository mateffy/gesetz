import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, ToolReplacement, Violation } from '@gesetz/core';
import { FileFilter, ProjectRoot, execTool, resolveToolBin, resolveToolCwd, toolScope, toolWatchPatterns } from '@gesetz/core';

export interface PrettierOptions {
  /**
   * File glob(s) to check. Passed to `prettier --list-different <pattern>`.
   * Default: '.' (all files prettier can handle)
   */
  pattern?: string | string[];
  /** Working directory. Default: the project root. */
  cwd?: string;
  /** Path to the prettier binary. Default: 'node_modules/.bin/prettier' */
  bin?: string;
  /** Path to a prettier config file. Passed as `--config <path>`. */
  configFile?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override. Default: 'prettier' */
  id?: string;
  /** Category for scoring. */
  category?: string;
}

/**
 * Creates a Rule that runs `prettier --list-different` and maps unformatted
 * files to Violations.
 *
 * `--list-different` prints the path of every file whose formatting differs
 * from prettier's output, one per line, and exits 1 when any are found.
 * Each unformatted file becomes a warning-level violation.
 *
 * Requires `prettier` to be installed in the target project.
 *
 * @example
 * prettier({ pattern: 'src', label: 'Prettier' })
 */
async function executePrettier(
  opts: PrettierOptions,
  id: string,
  bin: string,
  cwd: string,
  patterns: readonly string[],
): Promise<Violation[]> {
  const args = ['--list-different', ...patterns];
  if (opts.configFile) args.push('--config', opts.configFile);

  const stdout = await Effect.runPromise(execTool(bin, args, cwd, 'prettier'));

  if (!stdout) return [];

  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((filePath): Violation => ({
      rule: id,
      message: 'File is not formatted — run prettier --write to fix',
      path: nodePath.isAbsolute(filePath) ? nodePath.relative(cwd, filePath) : filePath,
      severity: 'warn',
      source: 'custom',
    }));
}

export function prettier(opts: PrettierOptions = {}): Rule {
  const id = opts.id ?? 'prettier';

  /**
   * What an agent would otherwise run. `gesetz skill` prints this, generated from
   * the project's configuration so nothing has to be maintained by hand.
   */
  const replaces: ToolReplacement[] = [
    { instead: 'prettier --list-different .', use: 'gesetz check --rule prettier' },
  ];
  const description = opts.label ?? 'Prettier formatting';
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return {
      bin: resolveToolBin(
        opts.bin,
        cwd,
        [nodePath.join('node_modules', '.bin', 'prettier')],
        'prettier',
      ),
      cwd,
    };
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const { bin, cwd } = locate(yield* ProjectRoot);

    const patterns: string[] = fileFilter.patterns !== null && fileFilter.patterns.length > 0
      ? [...fileFilter.patterns]
      : defaultPatterns;

    return yield* Effect.promise(() => executePrettier(opts, id, bin, cwd, patterns));
  });

  return {
    id,
    replaces,
    description,
    run,
    category: opts.category,
    project: {
      // The engine matches these against file paths, so a directory has to become a
      // glob: a raw `immoui/src/` matches nothing, and a rule that covers nothing
      // cannot be cached at all.
      patterns: opts.pattern !== undefined
        ? toolWatchPatterns(defaultPatterns)
        : ['**/*', '.prettierrc', '.prettierrc.*', 'prettier.config.*'],
      run: (ctx) => {
        const { bin, cwd } = locate(ctx.rootDir);
        // A `--files` request narrows what the tool looks at; without one it runs
        // over its own patterns, which is what its cached result is keyed by.
        const scope = toolScope(ctx.requestedPaths, defaultPatterns);
        if (scope === null) return Promise.resolve([]);
        return executePrettier(opts, id, bin, cwd, scope);
      },
    },
  };
}
