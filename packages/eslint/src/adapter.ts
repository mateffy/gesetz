import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, Violation } from '@regeln/core';

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

/**
 * Creates a Rule that runs ESLint programmatically and maps output to Violations.
 * Requires `eslint` to be installed as a peer dependency.
 *
 * @example
 * eslint({ pattern: 'src/**\/*.{ts,tsx}', label: 'ESLint' })
 */
export function eslint(opts: EslintOptions = {}): Rule {
  const id = opts.id ?? 'eslint';
  const description = opts.label ?? 'ESLint';
  const cwd = nodePath.resolve(opts.cwd ?? process.cwd());

  const run: Rule['run'] = Effect.gen(function* () {
    const patterns = opts.pattern
      ? Array.isArray(opts.pattern)
        ? opts.pattern
        : [opts.pattern]
      : ['.'];

    const results = yield* Effect.tryPromise({
      try: async () => {
        // @ts-ignore — eslint is an optional peer dep; present in some
        // workspaces, absent in others. Cast to EslintModule for a typed surface.
        const eslintModule = (await import('eslint')) as unknown as EslintModule;
        const ESLint = eslintModule.ESLint;
        const linter = new ESLint({
          cwd,
          ...(opts.overrideConfigFile ? { overrideConfigFile: opts.overrideConfigFile } : {}),
        });
        return linter.lintFiles(patterns);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `[regeln] eslint failed (${String(cause)}) — eslint() produced no violations.`,
          );
          return [] as EslintResult[];
        }),
      ),
    );

    const violations: Violation[] = [];
    for (const result of results) {
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
  });

  return { id, description, run, category: opts.category };
}
