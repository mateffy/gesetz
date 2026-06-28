import { Effect, Layer } from 'effect';
import { Reporter } from './reporter';
import { ReporterError } from '../engine/errors';
import type { RunResult } from '../engine/runner';
import type { FileSystem, ProjectRoot, FileFilter } from '../services/fs';
import type { SyntaxTree } from '../services/syntax-tree';
import type { ImportResolver } from '../services/import-resolver';

/**
 * Minimal interface required from a test runner.
 * Compatible with Vitest, bun:test, Jest, and any runner with this surface.
 */
export interface TestRunnerAPI {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => void | Promise<void>): void;
  expect(actual: unknown): {
    toEqual(expected: unknown): void;
  };
}

/**
 * Creates a Reporter layer that uses a test runner to output violations.
 *
 * One `it()` per rule. Violations cause the test to fail with a descriptive message.
 *
 * Works with any runner that has `describe`, `it`, and `expect`:
 *
 * @example
 * // Vitest
 * import { describe, it, expect } from 'vitest';
 * TestRunnerReporter({ describe, it, expect })
 */
export function TestRunnerReporter(runner: TestRunnerAPI): Layer.Layer<Reporter> {
  return Layer.succeed(Reporter, {
    report: (result: RunResult): Effect.Effect<void, ReporterError> =>
      Effect.sync(() => {
        const { describe, it, expect } = runner;

        describe('Quality Assurance', () => {
          for (const { ruleId, description, violations } of result.byRule) {
            it(description || ruleId, () => {
              const messages = violations.map(
                (v) => `${v.path}:${v.line ?? '?'} \u2014 ${v.message}`,
              );
              expect(messages).toEqual([]);
            });
          }
        });
      }),
  });
}

/**
 * The services a QA run needs: FileSystem plus the language adapters.
 * Callers provide a merged layer built from the live implementations of the
 * packages they depend on (e.g. @gesetz/typescript, @gesetz/php) — @gesetz/core
 * ships only stubs and must not know about concrete adapters.
 */
type ServicesLayer = Layer.Layer<
  FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter,
  never,
  never
>;

/**
 * Runs the QA config and reports results through the given test runner.
 *
 * This is the single boundary where `Effect.runPromise` is called — it composes
 * `runAll` and the reporter report into one Effect program and runs it once.
 * Language adapters are injected via `servicesLayer` so core stays decoupled.
 *
 * @example
 * // quality.test.ts (Vitest)
 * import { describe, it, expect } from 'vitest';
 * import { defineConfig, FileSystemLive, SyntaxTreeLive, ImportResolverDefault } from '@gesetz/core';
 * import { typescriptSyntaxBackend } from '@gesetz/typescript';
 * import { defineQualityTests } from '@gesetz/core/reporters';
 * import { Layer } from 'effect';
 *
 * const config = defineConfig({ adapters: [typescriptSyntaxBackend], rules: [...] });
 * const services = Layer.mergeAll(FileSystemLive, SyntaxTreeLive(config.adapters), ImportResolverDefault);
 * await defineQualityTests(config, { describe, it, expect }, services);
 */
export async function defineQualityTests(
  config: import('../engine/config').ResolvedConfig,
  runner: TestRunnerAPI,
  servicesLayer: ServicesLayer,
): Promise<void> {
  const { runAll } = await import('../engine/runner');
  const { ProjectRootLive, FileFilterLive } = await import('../services/fs');

  const program = Effect.gen(function* () {
    const result = yield* runAll(config);
    const reporter = yield* Reporter;
    yield* reporter.report(result);
  });

  await program.pipe(
    Effect.provide(servicesLayer),
    Effect.provide(ProjectRootLive(config.projectRoot)),
    Effect.provide(FileFilterLive(null)),
    Effect.provide(TestRunnerReporter(runner)),
    Effect.runPromise,
  );
}

/**
 * Convenience: builds a Vitest test suite. Lazily imports `vitest`.
 *
 * @example
 * // quality.test.ts
 * import { defineConfig, FileSystemLive, SyntaxTreeLive, ImportResolverDefault } from '@gesetz/core';
 * import { typescriptSyntaxBackend } from '@gesetz/typescript';
 * import { defineQualityTestsVitest } from '@gesetz/core/reporters';
 * import { Layer } from 'effect';
 *
 * const config = defineConfig({ adapters: [typescriptSyntaxBackend], rules: [...] });
 * const services = Layer.mergeAll(FileSystemLive, SyntaxTreeLive(config.adapters), ImportResolverDefault);
 * await defineQualityTestsVitest(config, services);
 */
export async function defineQualityTestsVitest(
  config: import('../engine/config').ResolvedConfig,
  servicesLayer: ServicesLayer,
): Promise<void> {
  const { describe, it, expect } = await import('vitest');
  await defineQualityTests(config, { describe, it, expect }, servicesLayer);
}

/**
 * Convenience: builds a bun:test suite. Lazily imports `bun:test`.
 * Throws synchronously if run outside Bun.
 *
 * @example
 * // quality.test.ts (bun:test)
 * import { defineConfig, FileSystemLive } from '@gesetz/core';
 * import { defineQualityTestsBunTest } from '@gesetz/core/reporters';
 *
 * const config = defineConfig({ rules: [...] });
 * await defineQualityTestsBunTest(config, services);
 */
export async function defineQualityTestsBunTest(
  config: import('../engine/config').ResolvedConfig,
  servicesLayer: ServicesLayer,
): Promise<void> {
  // @ts-expect-error — bun:test is only available in the Bun runtime; the
  // module is untyped in non-Bun environments. The catch below handles absence.
  const bunTest: typeof import('bun:test') | null = await import('bun:test').catch(
    () => null,
  );
  if (bunTest === null) {
    return Promise.reject(new Error('bun:test is not available — run this file with Bun'));
  }
  const { describe, it, expect } = bunTest;
  await defineQualityTests(config, { describe, it, expect }, servicesLayer);
}
