import { describe, it, expect, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from '../src/checks';
import { TsAdapter, MemoryFileSystem, ProjectRootLive, FileFilterLive, TsAdapterError } from '@gesetz/core';
import { PhpAdapterStub } from '@gesetz/core';

// Helper to create a ts-morph SourceFile from content
function makeTsAdapter(content: string) {
  return Layer.succeed(TsAdapter, {
    getSourceFile: (_path: string, _tsConfigPath: string) =>
      Effect.tryPromise({
        try: async () => {
          const { Project } = await import('ts-morph');
          const project = new Project({ skipAddingFilesFromTsConfig: true });
          const sf = project.createSourceFile('test.ts', content);
          return {
            getFilePath: () => sf.getFilePath(),
            getText: () => sf.getText(),
            _tsMorph: sf as unknown,
          };
        },
        catch: (e) => new TsAdapterError({ cause: String(e) }),
      }),
    isAvailable: () => Effect.succeed(true),
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, never, any>, content: string): Promise<any> =>
  Effect.provide(effect, Layer.mergeAll(
    MemoryFileSystem({ 'test.ts': content }),
    makeTsAdapter(content),
    PhpAdapterStub,
    ProjectRootLive(process.cwd()),
    FileFilterLive(null),
  )).pipe(Effect.runPromise as any);

// Simple file object for the check functions
function file(content: string) {
  return {
    path: 'test.ts',
    absolutePath: '/project/test.ts',
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
    const violations = await run(noRunPromiseScattered()({ ...file(content), absolutePath: '/project/src/lib.ts' }), content);
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
      noRunPromiseScattered({ entryPoints: ['src/main.ts'] })({ ...file(content), path: 'src/main.ts', absolutePath: '/project/src/main.ts' }),
      content,
    );
    expect(violations).toHaveLength(0);
  });

  it('allows Effect.runSync in entry points', async () => {
    const content = `
      import { Effect } from 'effect';
      Effect.runSync(main);
    `;
    const violations = await run(
      noRunPromiseScattered({ entryPoints: ['src/main.ts'] })({ ...file(content), path: 'src/main.ts', absolutePath: '/project/src/main.ts' }),
      content,
    );
    expect(violations).toHaveLength(0);
  });

  it('does not flag non-Effect run* calls', async () => {
    const content = `
      const runner = { runPromise: (x: number) => x };
      runner.runPromise(1);
    `;
    const violations = await run(noRunPromiseScattered()({ ...file(content), absolutePath: '/project/src/lib.ts' }), content);
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
    const violations = await run(noThrowInEffectGen()({ ...file(content), absolutePath: '/project/test.ts' }), content);
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
    const violations = await run(noThrowInEffectGen()({ ...file(content), absolutePath: '/project/test.ts' }), content);
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
    const violations = await run(noThrowInEffectGen()({ ...file(content), absolutePath: '/project/test.ts' }), content);
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
    const violations = await run(noYieldWithoutStar()({ ...file(content), absolutePath: '/project/test.ts' }), content);
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
    const violations = await run(noYieldWithoutStar()({ ...file(content), absolutePath: '/project/test.ts' }), content);
    expect(violations).toHaveLength(0);
  });

  it('ignores yield outside Effect.gen', async () => {
    const content = `
      function* plain() {
        yield 1;
      }
    `;
    const violations = await run(noYieldWithoutStar()({ ...file(content), absolutePath: '/project/test.ts' }), content);
    expect(violations).toHaveLength(0);
  });
});

describe('noUnboundedEffectAll', () => {
  it('flags Effect.all without concurrency option', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)]);
    `;
    const violations = await run(noUnboundedEffectAll()({ ...file(content), absolutePath: '/project/test.ts' }), content);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe('no-unbounded-effect-all');
    expect(violations[0]?.message).toContain('concurrency');
  });

  it('allows Effect.all with concurrency option', async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)], { concurrency: 2 });
    `;
    const violations = await run(noUnboundedEffectAll()({ ...file(content), absolutePath: '/project/test.ts' }), content);
    expect(violations).toHaveLength(0);
  });

  it('does not flag unrelated Effect calls', async () => {
    const content = `
      import { Effect } from 'effect';
      const x = Effect.succeed(1);
    `;
    const violations = await run(noUnboundedEffectAll()({ ...file(content), absolutePath: '/project/test.ts' }), content);
    expect(violations).toHaveLength(0);
  });
});
