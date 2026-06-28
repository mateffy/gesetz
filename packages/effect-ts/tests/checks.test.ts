import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from '../src/checks';
import type { File } from '@gesetz/core';

// The migrated checks use ast-grep via Effect.sync — no services required.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, never, any>): Promise<any> =>
  Effect.runPromise(effect as any);

// Simple file object for the check functions
function file(content: string, path = 'test.ts'): File {
  return {
    path,
    absolutePath: `/project/${path}`,
    name: 'test.ts',
    stem: 'test',
    ext: '.ts',
    dir: '.',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

describe('noRunPromiseScattered', () => {
  it('flags Effect.runPromise outside entry points', async () => {
    const content = `
      import { Effect } from 'effect';
      export const program = Effect.runPromise(Effect.succeed(1));
    `;
    const violations = await run(noRunPromiseScattered()(file(content, 'src/lib.ts')));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-run-promise-scattered');
    expect(violations[0]?.message).toContain('runPromise');
  });

  it('allows Effect.runPromise in entry points', async () => {
    const content = `
      import { Effect } from 'effect';
      Effect.runPromise(main);
    `;
    const violations = await run(
      noRunPromiseScattered({ entryPoints: ['src/main.ts'] })(file(content, 'src/main.ts')),
    );
    expect(violations).toHaveLength(0);
  });

  it('allows Effect.runSync in entry points', async () => {
    const content = `
      import { Effect } from 'effect';
      Effect.runSync(main);
    `;
    const violations = await run(
      noRunPromiseScattered({ entryPoints: ['src/main.ts'] })(file(content, 'src/main.ts')),
    );
    expect(violations).toHaveLength(0);
  });

  it('does not flag non-Effect run* calls', async () => {
    const content = `
      const runner = { runPromise: (x: number) => x };
      runner.runPromise(1);
    `;
    const violations = await run(noRunPromiseScattered()(file(content, 'src/lib.ts')));
    expect(violations).toHaveLength(0);
  });
});

describe('noThrowInEffectGen', () => {
  it('flags throw inside Effect.gen', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield* Effect.succeed(1);
        if (x < 0) throw new Error('negative');
        return x;
      });
    `;
    const violations = await run(noThrowInEffectGen()(file(content)));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-throw-in-effect-gen');
    expect(violations[0]?.message).toContain('throw');
  });

  it('ignores throw outside Effect.gen', async () => {
    const content = `
      function plain() {
        if (false) throw new Error('ok');
      }
    `;
    const violations = await run(noThrowInEffectGen()(file(content)));
    expect(violations).toHaveLength(0);
  });

  it('flags throw inside Effect.fn', async () => {
    const content = `
      import { Effect } from 'effect';
      const work = Effect.fn(function* (n: number) {
        if (n < 0) throw new Error('negative');
        return n;
      });
    `;
    const violations = await run(noThrowInEffectGen()(file(content)));
    expect(violations).toHaveLength(1);
  });
});

describe('noYieldWithoutStar', () => {
  it('flags yield without star in Effect.gen', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield Effect.succeed(1);
        return x;
      });
    `;
    const violations = await run(noYieldWithoutStar()(file(content)));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-yield-without-star');
  });

  it('allows yield* with star in Effect.gen', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield* Effect.succeed(1);
        return x;
      });
    `;
    const violations = await run(noYieldWithoutStar()(file(content)));
    expect(violations).toHaveLength(0);
  });

  it('ignores yield outside Effect.gen', async () => {
    const content = `
      function* plain() {
        yield 1;
      }
    `;
    const violations = await run(noYieldWithoutStar()(file(content)));
    expect(violations).toHaveLength(0);
  });
});

describe('noUnboundedEffectAll', () => {
  it('flags Effect.all without concurrency option', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)]);
    `;
    const violations = await run(noUnboundedEffectAll()(file(content)));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-unbounded-effect-all');
    expect(violations[0]?.message).toContain('concurrency');
  });

  it('allows Effect.all with concurrency option', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)], { concurrency: 2 });
    `;
    const violations = await run(noUnboundedEffectAll()(file(content)));
    expect(violations).toHaveLength(0);
  });

  it('does not flag unrelated Effect calls', async () => {
    const content = `
      import { Effect } from 'effect';
      const x = Effect.succeed(1);
    `;
    const violations = await run(noUnboundedEffectAll()(file(content)));
    expect(violations).toHaveLength(0);
  });
});
