import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { execTool, FileFilter } from '@gesetz/core';

export interface PhpstanOptions {
  /** Glob pattern(s) to analyse. If omitted, phpstan analyses the configured paths. */
  pattern?: string | string[];
  /** Path to phpstan binary. Default: 'vendor/bin/phpstan' */
  bin?: string;
  /** Working directory. Default: process.cwd() */
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
  files: Record<
    string,
    {
      errors: number;
      messages: Array<{ message: string; line: number; ignorable: boolean }>;
    }
  >;
  errors: string[];
}

function parsePhpstanOutput(stdout: string, cwd: string): Violation[] {
  let parsed: PhpstanJsonOutput;
  try {
    parsed = JSON.parse(stdout) as PhpstanJsonOutput;
  } catch {
    return [];
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

  // each violation gets the adapter's rule id; a shallow copy per item is the
  // clearest way to express that, and this runs once per phpstan report
  return parsePhpstanOutput(stdout, cwd).map((violation) => ({ ...violation, rule: id }));
}

export function phpstan(opts: PhpstanOptions = {}): Rule {
  const bin = opts.bin ?? 'vendor/bin/phpstan';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const memoryLimit = opts.memoryLimit ?? '512M';
  const id = opts.id ?? 'phpstan';
  const description = opts.label ?? 'PHPStan static analysis';
  const defaultPatterns: string[] | null = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : null;

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const patterns =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : defaultPatterns;

    return yield* Effect.promise(() => executePhpstan(opts, id, bin, cwd, memoryLimit, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      patterns: defaultPatterns ?? ['**/*.php', 'phpstan.neon', 'phpstan.neon.*'],
      run: () => executePhpstan(opts, id, bin, cwd, memoryLimit, defaultPatterns),
    },
  };
}
