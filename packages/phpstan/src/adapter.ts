import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, FileFilter, ProjectRoot, resolveToolBin, resolveToolCwd, toolScope } from '@gesetz/core';

export interface PhpstanOptions {
  /** Glob pattern(s) to analyse. If omitted, phpstan analyses the configured paths. */
  pattern?: string | string[];
  /** Path to phpstan binary. Default: 'vendor/bin/phpstan' */
  bin?: string;
  /** Working directory. Default: the project root. */
  cwd?: string;
  /** phpstan config file path */
  configFile?: string;
  /** Memory limit for phpstan. Default: '512M' */
  memoryLimit?: string;
  /** Rule label for the violation output */
  label?: string;
  /** Rule id override */
  id?: string;
  /** Category for scoring. */
  category?: string;
}

interface PhpstanJsonOutput {
  totals: { errors: number; file_errors: number };
  files: Record<string, {
    errors: number;
    messages: Array<{ message: string; line: number; ignorable: boolean }>;
  }>;
  errors: string[];
}

function parsePhpstanOutput(stdout: string, cwd: string, ruleId: string): Violation[] {
  let parsed: PhpstanJsonOutput;
  try {
    parsed = JSON.parse(stdout) as PhpstanJsonOutput;
  } catch (cause) {
    // Nothing was analysed. Reporting no violations here would read as "clean".
    return [
      {
        rule: ruleId,
        message: `phpstan produced output that is not a JSON report, so nothing was checked: ${String(cause)}. Fix the tool, then re-run.`,
        path: '.',
        severity: 'error',
        source: 'custom',
      },
    ];
  }

  const violations: Violation[] = [];

  for (const [absPath, fileResult] of Object.entries(parsed.files)) {
    const relativePath = nodePath.relative(cwd, absPath);
    for (const msg of fileResult.messages) {
      violations.push({
        rule: '',
        message: msg.message,
        path: relativePath,
        line: msg.line,
        severity: 'error',
        source: 'phpstan',
      });
    }
  }

  // Top-level errors (not file-specific)
  for (const err of parsed.errors ?? []) {
    violations.push({
      rule: '',
      message: err,
      path: cwd,
      severity: 'error',
      source: 'phpstan',
    });
  }

  return violations;
}

/**
 * Creates a Rule that runs phpstan and maps its output to Violations.
 *
 * @example
 * phpstan({ memoryLimit: '1G', label: 'phpstan' })
 */
async function executePhpstan(
  opts: PhpstanOptions,
  id: string,
  bin: string,
  cwd: string,
  memoryLimit: string,
  patterns: readonly string[] | null,
): Promise<Violation[]> {
  const args = [
    'analyse',
    '--error-format=json',
    '--no-progress',
    '--no-interaction',
    `--memory-limit=${memoryLimit}`,
  ];

  if (opts.configFile) args.push(`--configuration=${opts.configFile}`);
  if (patterns) args.push(...patterns);

  const stdout = await Effect.runPromise(execTool(bin, args, cwd, 'phpstan'));

  const violations = parsePhpstanOutput(stdout, cwd, id);
  return violations.map((v) => ({ ...v, rule: id }));
}

export function phpstan(opts: PhpstanOptions = {}): Rule {
  const memoryLimit = opts.memoryLimit ?? '512M';
  const id = opts.id ?? 'phpstan';
  const description = opts.label ?? 'PHPStan static analysis';
  const defaultPatterns: string[] | null = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : null;

  // PHP tools live in `vendor/bin`; the fallback keeps the historical default.
  const locate = (projectRoot: string): { bin: string; cwd: string } => {
    const cwd = resolveToolCwd(opts.cwd, projectRoot);
    return { bin: resolveToolBin(opts.bin, cwd, ['vendor/bin/phpstan'], 'vendor/bin/phpstan'), cwd };
  };

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const { bin, cwd } = locate(yield* ProjectRoot);
    const patterns = fileFilter.patterns !== null && fileFilter.patterns.length > 0
      ? [...fileFilter.patterns]
      : defaultPatterns;

    return yield* Effect.promise(() => executePhpstan(opts, id, bin, cwd, memoryLimit, patterns));
  });

  // PHPStan analyses files or directories; the fallback is the whole project and
  // its config, so editing phpstan.neon re-runs the analysis.
  const projectPatterns: string[] =
    defaultPatterns ?? ['**/*.php', 'phpstan.neon', 'phpstan.neon.*'];

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      patterns: projectPatterns,
      run: (ctx) => {
        const { bin, cwd } = locate(ctx.rootDir);
        // A `--files` request narrows what the tool looks at; without one it runs
        // over its own patterns, which is what its cached result is keyed by.
        const scope = toolScope(ctx.requestedPaths, projectPatterns);
        if (scope === null) return Promise.resolve([]);
        return executePhpstan(opts, id, bin, cwd, memoryLimit, scope);
      },
    },
  };
}
