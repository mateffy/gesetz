import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';
import { ExecError } from '@regeln/core';

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
  files: Record<string, {
    errors: number;
    messages: Array<{ message: string; line: number; ignorable: boolean }>;
  }>;
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
export function phpstan(opts: PhpstanOptions = {}): Rule {
  const bin = opts.bin ?? 'vendor/bin/phpstan';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const memoryLimit = opts.memoryLimit ?? '512M';
  const id = opts.id ?? 'phpstan';
  const description = opts.label ?? 'PHPStan static analysis';

  const run: Rule['run'] = (Effect.gen(function* () {
    const args = [
      'analyse',
      '--error-format=json',
      '--no-progress',
      '--no-interaction',
      `--memory-limit=${memoryLimit}`,
    ];

    if (opts.configFile) args.push(`--configuration=${opts.configFile}`);
    if (opts.pattern) {
      const patterns = Array.isArray(opts.pattern) ? opts.pattern : [opts.pattern];
      args.push(...patterns);
    }

    const stdout = yield* Effect.try({
      try: () => {
        try {
          return childProcess
            .execFileSync(bin, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
            .toString();
        } catch (e: unknown) {
          // phpstan exits 1 when there are errors — that's expected.
          // The JSON output is in stdout regardless of exit code.
          const execError = e as { stdout?: Buffer | string; status?: number };
          const out = execError.stdout;
          if (out) return typeof out === 'string' ? out : out.toString();
          throw e;
        }
      },
      catch: (cause) => new ExecError({ command: bin, cause }),
    });

    const violations = parsePhpstanOutput(stdout, cwd);
    return violations.map((v) => ({ ...v, rule: id }));
  }) as Effect.Effect<Violation[], ExecError, never>).pipe(
    Effect.catchAll((cause: unknown) =>
      Effect.succeed<Violation[]>([
        {
          rule: id,
          message: `phpstan failed to run: ${cause instanceof Error ? cause.message : String(cause)}`,
          path: cwd,
          severity: 'error' as const,
          source: 'phpstan' as const,
        },
      ]),
    ),
  );

  return { id, description, run, category: opts.category };
}
