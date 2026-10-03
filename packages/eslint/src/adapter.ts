import * as nodePath from 'node:path';
import { Effect } from 'effect';
import type { Rule, ToolReplacement, Violation } from '@gesetz/core';
import { FileFilter, ProjectRoot, resolveToolCwd, toolScope, toolWatchPatterns } from '@gesetz/core';

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
async function executeEslint(
  opts: EslintOptions,
  id: string,
  cwd: string,
  patterns: readonly string[],
): Promise<Violation[]> {
  const results = await Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        // @ts-ignore — eslint is an optional peer dep; present in some
        // workspaces, absent in others. Cast to EslintModule for a typed surface.
        const eslintModule = (await import('eslint')) as unknown as EslintModule;
        if (typeof eslintModule.ESLint !== 'function') {
          throw new Error('eslint module does not export ESLint class');
        }
        const ESLint = eslintModule.ESLint;
        const linter = new ESLint({
          cwd,
          ...(opts.overrideConfigFile ? { overrideConfigFile: opts.overrideConfigFile } : {}),
        });
        return linter.lintFiles([...patterns]);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.gen(function* () {
          // Nothing was linted. Swallowing this would read as "clean", so it is
          // reported as a failure instead.
          yield* Effect.logError(
            `[gesetz] eslint failed (${String(cause)}) — nothing was checked.`,
          );
          return [
            {
              errorCount: 1,
              warningCount: 0,
              filePath: '.',
              messages: [
                {
                  ruleId: null,
                  severity: 2,
                  message: `eslint failed to run, so nothing was checked: ${String(cause)}. Fix the tool, then re-run.`,
                  line: 1,
                  column: 1,
                },
              ],
            },
          ] as unknown as EslintResult[];
        }),
      ),
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
}

export function eslint(opts: EslintOptions = {}): Rule {
  const id = opts.id ?? 'eslint';

  /**
   * What an agent would otherwise run. `gesetz skill` prints this, generated from
   * the project's configuration so nothing has to be maintained by hand.
   */
  const replaces: ToolReplacement[] = [
    { instead: 'eslint', use: 'gesetz check --rule eslint' },
  ];
  const description = opts.label ?? 'ESLint';
  const defaultPatterns: string[] = opts.pattern
    ? Array.isArray(opts.pattern)
      ? [...opts.pattern]
      : [opts.pattern]
    : ['.'];

  const run: Rule['run'] = Effect.gen(function* () {
    const fileFilter = yield* FileFilter;
    const cwd = resolveToolCwd(opts.cwd, yield* ProjectRoot);

    const patterns: string[] = fileFilter.patterns !== null && fileFilter.patterns.length > 0
      ? [...fileFilter.patterns]
      : defaultPatterns;

    return yield* Effect.promise(() => executeEslint(opts, id, cwd, patterns));
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
        : ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', 'eslint.config.*', '.eslintrc', '.eslintrc.*'],
      run: (ctx) => {
        // A `--files` request narrows what the tool looks at; without one it runs
        // over its own patterns, which is what its cached result is keyed by.
        const scope = toolScope(ctx.requestedPaths, defaultPatterns);
        if (scope === null) return Promise.resolve([]);
        return executeEslint(opts, id, resolveToolCwd(opts.cwd, ctx.rootDir), scope);
      },
    },
  };
}
