import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@gesetz/core';
import { FileFilter, scopedPatterns, toolWatchPatterns } from '@gesetz/core';

export interface EslintOptions {
  pattern?: string | string[];
  cwd?: string;
  overrideConfigFile?: string;
  label?: string;
  id?: string;
  category?: string;
}

/**
 * Subset of ESLint's `Linter.LintResult` that we read.
 * Defined locally so the adapter compiles without `eslint` installed (it is an
 * optional peer dep); the single documented cast happens at the import site.
 */
interface EslintResult {
  readonly filePath: string;
  readonly messages: ReadonlyArray<{
    readonly ruleId: string | null;
    readonly message: string;
    readonly line: number;
    readonly column: number;
    /** ESLint severity: 1 = warning, 2 = error */
    readonly severity: 1 | 2;
  }>;
}

/** Minimal typed view of the ESLint module's default export. */
interface EslintModule {
  readonly ESLint: new (options: {
    readonly cwd: string;
    readonly overrideConfigFile?: string;
  }) => {
    readonly lintFiles: (patterns: string[]) => Promise<EslintResult[]>;
  };
}

/** True when the dynamic import has the ESLint constructor this adapter needs. */
function isEslintModule(value: unknown): value is EslintModule {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { ESLint?: unknown }).ESLint === 'function';
}

/**
 * Creates a Rule that runs ESLint programmatically and maps output to Violations.
 * Requires `eslint` to be installed as a peer dependency.
 *
 * @example
 * eslint({ pattern: 'src/**\/*.{ts,tsx}', label: 'ESLint' })
 */
async function executeEslint(
  opts: EslintOptions,
  id: string,
  cwd: string,
  patterns: readonly string[],
): Promise<Violation[]> {
  const outcome = await Effect.runPromise(
    Effect.either(
      Effect.tryPromise({
        try: async (): Promise<EslintResult[]> => {
          const eslintModule: unknown = await import('eslint');
          if (!isEslintModule(eslintModule)) {
            throw new Error('the eslint module does not export an ESLint class');
          }
          const linter = new eslintModule.ESLint({
            cwd,
            ...(opts.overrideConfigFile ? { overrideConfigFile: opts.overrideConfigFile } : {}),
          });
          return linter.lintFiles([...patterns]);
        },
        catch: (cause) => cause,
      }),
    ),
  );

  // A broken ESLint used to log a warning and return no violations, which read
  // as a clean lint. A check that cannot run must fail.
  if (outcome._tag === 'Left') {
    return [
      {
        rule: id,
        message: `eslint could not run, so nothing was checked: ${String(outcome.left)}. Fix the tool, then re-run.`,
        path: '.',
        severity: 'error',
        source: 'eslint',
      },
    ];
  }

  const violations: Violation[] = [];
  for (const result of outcome.right) {
    for (const msg of result.messages) {
      violations.push({
        rule: id,
        message: `[${msg.ruleId ?? 'unknown'}] ${msg.message}`,
        path: result.filePath,
        line: msg.line,
        column: msg.column,
        severity: msg.severity === 2 ? 'error' : 'warn',
        source: 'eslint',
      });
    }
  }

  return violations;
}

export function eslint(opts: EslintOptions = {}): Rule {
  const id = opts.id ?? 'eslint';
  const description = opts.label ?? 'ESLint';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;

    const patterns: string[] =
      fileFilter.patterns !== null && fileFilter.patterns.length > 0
        ? [...fileFilter.patterns]
        : defaultPatterns;

    return yield* Effect.promise(() => executeEslint(opts, id, cwd, patterns));
  });

  return {
    id,
    description,
    run,
    category: opts.category,
    project: {
      patterns: toolWatchPatterns([
        ...defaultPatterns,
        'eslint.config.*',
        '.eslintrc',
        '.eslintrc.*',
      ]),
      run: (ctx) => {
        // A linter's answer for a file depends only on that file, so only the files
        // this scan reprocessed need answering; reporting `examinedPaths` is what
        // keeps the marks for untouched files instead of clearing them unexamined.
        const scoped = scopedPatterns(ctx.changedFiles, defaultPatterns);
        if (scoped === null) return Promise.resolve({ violations: [], examinedPaths: [] });
        return executeEslint(opts, id, cwd, scoped).then((violations) => ({
          violations,
          examinedPaths: scoped,
        }));
      },
    },
  };
}
