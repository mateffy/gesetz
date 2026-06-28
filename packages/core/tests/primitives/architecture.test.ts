import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import { defineArchitecture } from '../../src/architecture';
import { MemoryFileSystem, ProjectRootLive, FileFilterLive } from '../../src/services/fs';
import { SyntaxTreeStub } from '../../src/services/syntax-tree';
import { ImportResolverDefault } from '../../src/services/import-resolver';

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive('/project'),
  FileFilterLive(null),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Effect.provide(effect, TestLayer as any).pipe(Effect.runPromise as any);

describe('defineArchitecture', () => {
  it('returns a single rule with the correct id', () => {
    const rules = defineArchitecture({
      layers: [
        { name: 'a', pattern: 'src/a/**' },
        { name: 'b', pattern: 'src/b/**' },
      ],
    });
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe('architecture-layer-violations');
    expect(rules[0]?.category).toBe('organization');
  });

  it('produces no violations when all imports are allowed', async () => {
    const files = {
      '/project/src/a/index.ts': "import { helper } from '../b/helper';",
      '/project/src/b/helper.ts': 'export const helper = 1;',
    };

    const rules = defineArchitecture({
      layers: [
        { name: 'a', pattern: 'src/a/**', canImportFrom: ['b'] },
        { name: 'b', pattern: 'src/b/**' },
      ],
    });

    const layer = Layer.mergeAll(
      MemoryFileSystem(files),
      SyntaxTreeStub,
      ImportResolverDefault,
      ProjectRootLive('/project'),
      FileFilterLive(null),
    );

    const violations = await Effect.provide(rules[0]!.run, layer).pipe(Effect.runPromise);
    expect(violations).toHaveLength(0);
  });

  it('flags imports from disallowed layers', async () => {
    const files = {
      '/project/src/a/index.ts': "import { secret } from '../b/secret';",
      '/project/src/b/secret.ts': 'export const secret = 1;',
    };

    const rules = defineArchitecture({
      layers: [
        { name: 'a', pattern: 'src/a/**', canImportFrom: [] },
        { name: 'b', pattern: 'src/b/**' },
      ],
    });

    const layer = Layer.mergeAll(
      MemoryFileSystem(files),
      SyntaxTreeStub,
      ImportResolverDefault,
      ProjectRootLive('/project'),
      FileFilterLive(null),
    );

    const violations = await Effect.provide(rules[0]!.run, layer).pipe(Effect.runPromise);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('must not import');
    expect(violations[0]?.message).toContain('b');
  });

  it('flags forbidden pairs', async () => {
    const files = {
      '/project/src/util/helper.ts': "import { cli } from '../cli/main';",
      '/project/src/cli/main.ts': 'export const cli = 1;',
    };

    const rules = defineArchitecture({
      layers: [
        { name: 'util', pattern: 'src/util/**' },
        { name: 'cli', pattern: 'src/cli/**' },
      ],
      forbidden: [
        { from: 'util', to: 'cli', message: 'Utilities must not import from CLI' },
      ],
    });

    const layer = Layer.mergeAll(
      MemoryFileSystem(files),
      SyntaxTreeStub,
      ImportResolverDefault,
      ProjectRootLive('/project'),
      FileFilterLive(null),
    );

    const violations = await Effect.provide(rules[0]!.run, layer).pipe(Effect.runPromise);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe('Utilities must not import from CLI');
  });

  it('flags banned external packages', async () => {
    const files = {
      '/project/src/util/helper.ts': "import React from 'react';",
    };

    const rules = defineArchitecture({
      layers: [
        { name: 'util', pattern: 'src/util/**' },
      ],
      bannedExternals: {
        util: ['react'],
      },
    });

    const layer = Layer.mergeAll(
      MemoryFileSystem(files),
      SyntaxTreeStub,
      ImportResolverDefault,
      ProjectRootLive('/project'),
      FileFilterLive(null),
    );

    const violations = await Effect.provide(rules[0]!.run, layer).pipe(Effect.runPromise);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('react');
  });

  it('allows imports within the same layer', async () => {
    const files = {
      '/project/src/a/one.ts': "import { two } from './two';",
      '/project/src/a/two.ts': 'export const two = 2;',
    };

    const rules = defineArchitecture({
      layers: [
        { name: 'a', pattern: 'src/a/**', canImportFrom: [] },
      ],
    });

    const layer = Layer.mergeAll(
      MemoryFileSystem(files),
      SyntaxTreeStub,
      ImportResolverDefault,
      ProjectRootLive('/project'),
      FileFilterLive(null),
    );

    const violations = await Effect.provide(rules[0]!.run, layer).pipe(Effect.runPromise);
    expect(violations).toHaveLength(0);
  });

  it('returns empty when no files match layer patterns', async () => {
    const rules = defineArchitecture({
      layers: [
        { name: 'a', pattern: 'nonexistent/**' },
      ],
    });

    const violations = await run(rules[0]!.run);
    expect(violations).toHaveLength(0);
  });
});
