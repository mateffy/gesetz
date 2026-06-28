import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import * as nodePath from 'node:path';
import {
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  relativeImports,
} from '../src';
import { MemoryFileSystem } from '@gesetz/core';
import type { File } from '@gesetz/core';

function makeFile(content: string, path = 'src/foo.ts', name = 'foo.ts'): File {
  const ext = nodePath.extname(name);
  return {
    path,
    absolutePath: nodePath.resolve(process.cwd(), path),
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext,
    dir: nodePath.dirname(path),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

// For checks that require services via a Layer.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runWith = (effect: Effect.Effect<any, any, any>, layer: Layer.Layer<any>): Promise<any> =>
  Effect.provide(effect as any, layer as any).pipe(Effect.runPromise as any);

describe('noConsoleLog (moved from core)', () => {
  it('flags console.log', async () => {
    const v = await run(noConsoleLog()(makeFile('console.log("hello");')));
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-console-log');
  });

  it('flags warn and error by default', async () => {
    const v = await run(noConsoleLog()(makeFile('console.warn("w");\nconsole.error("e");')));
    expect(v).toHaveLength(2);
  });

  it('allows warn and error when allowWarnError is true', async () => {
    const v = await run(
      noConsoleLog({ allowWarnError: true })(makeFile('console.warn("w");\nconsole.error("e");')),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noEmptyCatch (moved from core)', () => {
  it('flags empty catch block', async () => {
    const v = await run(noEmptyCatch()(makeFile('try { x(); } catch { \n }')));
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('no-empty-catch');
  });

  it('passes when catch has a body', async () => {
    const v = await run(
      noEmptyCatch()(makeFile('try {\n  x();\n} catch (e) {\n  log(e);\n}')),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noMagicNumbers (moved from core)', () => {
  it('flags unexplained numeric literals', async () => {
    const v = await run(noMagicNumbers()(makeFile('const r = value * 42;')));
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('42');
  });

  it('ignores named constants and the default ignore list', async () => {
    const v = await run(
      noMagicNumbers()(makeFile('const MAX_RETRIES = 3;\nreturn x === 0 || x === 1;')),
    );
    expect(v).toHaveLength(0);
  });
});

describe('noTrivialComment (moved from core)', () => {
  it('flags narrative comments', async () => {
    const v = await run(noTrivialComment()(makeFile('// Import the module\n// Define the component')));
    expect(v).toHaveLength(2);
    expect(v[0]?.rule).toBe('no-trivial-comment');
  });

  it('ignores meaningful comments', async () => {
    const v = await run(noTrivialComment()(makeFile('// This explains why we retry on ECONNRESET')));
    expect(v).toHaveLength(0);
  });
});

describe('relativeImports (moved from core)', () => {
  const CWD = process.cwd();

  it('passes when all relative imports resolve', async () => {
    const file = makeFile(
      `import { x } from './bar';\nimport { y } from './baz/index';`,
      'src/foo.ts',
    );
    const barAbs = nodePath.resolve(CWD, 'src/bar.ts');
    const bazAbs = nodePath.resolve(CWD, 'src/baz/index.ts');
    const layer = Layer.mergeAll(MemoryFileSystem({ [barAbs]: '', [bazAbs]: '' }));
    const v = await runWith(relativeImports()(file), layer);
    expect(v).toHaveLength(0);
  });

  it('fails when a relative import does not resolve', async () => {
    const file = makeFile(`import { x } from './missing';`, 'src/foo.ts');
    const layer = Layer.mergeAll(MemoryFileSystem({}));
    const v = await runWith(relativeImports()(file), layer);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('./missing');
  });

  it('ignores non-relative imports', async () => {
    const file = makeFile(`import React from 'react';\nimport { z } from 'zod';`, 'src/foo.ts');
    const layer = Layer.mergeAll(MemoryFileSystem({}));
    const v = await runWith(relativeImports()(file), layer);
    expect(v).toHaveLength(0);
  });

  it('resolves .tsx extensions', async () => {
    const file = makeFile(`import { Comp } from './Comp';`, 'src/foo.ts');
    const compAbs = nodePath.resolve(CWD, 'src/Comp.tsx');
    const layer = Layer.mergeAll(MemoryFileSystem({ [compAbs]: '' }));
    const v = await runWith(relativeImports()(file), layer);
    expect(v).toHaveLength(0);
  });
});
