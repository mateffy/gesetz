/**
 * Regel config — dogfooding regel on itself.
 *
 * Run: bun run packages/cli/src/main.ts check
 */
import { defineConfig, select, noGodFile, noConsoleLog, noEmptyCatch, noTrivialComment } from '@regeln/core';
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from '@regeln/effect-ts';

export default defineConfig({
  projectRoot: import.meta.dirname,
  rules: [
    // ─── Structure ─────────────────────────────────────────────────────────
    select('packages/*/src/**/*.ts')
      .label('No god files in core (max 600 lines)')
      .category('structure')
      .guidance({
        what: 'Files over 600 lines are hard to review and understand.',
        do: 'Extract distinct concerns into separate modules.',
        dont: 'Add more code to a file that already exceeds the limit.',
      })
      .check(noGodFile({ maxLines: 600 })),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('No console.log in library code')
      .category('cleanup')
      .guidance({
        what: 'Console logging left in production library code.',
        do: 'Use Effect.log() or remove debug logging before committing.',
        dont: 'Leave console.log() calls in committed code.',
      })
      .check(noConsoleLog()),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('No empty catch blocks')
      .category('strictness')
      .guidance({
        what: 'Empty catch blocks silently swallow errors.',
        do: 'Log, rethrow, or return an Effect.fail() with a typed error.',
        dont: 'Leave catch blocks empty to silence type errors.',
      })
      .check(noEmptyCatch()),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('No AI-narration comments')
      .category('cleanup')
      .guidance({
        what: 'Trivial comments that just restate the code (AI slop).',
        do: 'Write comments that explain WHY, not WHAT.',
        dont: 'Leave comments like "// Import the module" or "// Define the function".',
      })
      .check(noTrivialComment()),

    // ─── Effect-TS ─────────────────────────────────────────────────────────
    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .exclude('**/tests/**', '**/*.test.ts')
      .label('Effect.runPromise must only be called at entry points')
      .category('effect-ts')
      .guidance({
        what: 'Effect.run* calls scatter boundary crossings through library code.',
        do: 'Call Effect.runPromise only in CLI entry points and test files.',
        dont: 'Call Effect.runPromise inside services, adapters, or reporters.',
      })
      .check(noRunPromiseScattered({ entryPoints: ['src/main.ts', 'packages/core/src/reporters/test-runner.ts'] })),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('No throw inside Effect.gen()')
      .category('effect-ts')
      .guidance({
        what: '`throw` inside Effect.gen() creates an untyped Defect.',
        do: 'Use `yield* Effect.fail(new MyError())` to keep errors typed.',
        dont: 'throw inside Effect.gen generators.',
      })
      .check(noThrowInEffectGen()),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('No yield without * inside Effect.gen()')
      .category('effect-ts')
      .guidance({
        what: 'Plain `yield` inside Effect.gen() does not unwrap the Effect.',
        do: 'Write `yield* effect` (with asterisk) to get the value.',
        dont: 'Omit the star — it silently produces wrong values.',
      })
      .check(noYieldWithoutStar()),

    select('packages/*/src/**/*.ts', 'packages/cli/src/**/*.ts')
      .label('Effect.all() must specify concurrency')
      .category('effect-ts')
      .guidance({
        what: 'Effect.all without concurrency option is ambiguously sequential.',
        do: 'Add `{ concurrency: N }` or `{ concurrency: "unbounded" }`.',
        dont: 'Leave Effect.all() without an options argument.',
      })
      .check(noUnboundedEffectAll()),
  ],
});
