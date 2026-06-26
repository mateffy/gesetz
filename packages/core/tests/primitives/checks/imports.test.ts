import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { noImportFrom, requireImportFrom } from '../../../src/primitives/checks/imports';
import type { File } from '../../../src/engine/rule';

function makeFile(content: string, path = 'src/foo.ts'): File {
  return {
    path,
    absolutePath: `/abs/${path}`,
    name: 'foo.ts',
    stem: 'foo',
    ext: '.ts',
    dir: 'src',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>): Promise<any> =>
  Effect.runPromise(effect as any);

describe('noImportFrom', () => {
  it('passes when the module is not imported', async () => {
    const file = makeFile(`import React from 'react';`);
    const violations = await run(noImportFrom('@tanstack/react-query')(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when the exact module is imported', async () => {
    const file = makeFile(`import { useQuery } from '@tanstack/react-query';`);
    const violations = await run(noImportFrom('@tanstack/react-query')(file));
    expect(violations).toHaveLength(1);
  });

  it('fails for subpath imports', async () => {
    const file = makeFile(`import { something } from '@tanstack/react-query/internals';`);
    const violations = await run(noImportFrom('@tanstack/react-query')(file));
    expect(violations).toHaveLength(1);
  });

  it('uses regex matching', async () => {
    const file = makeFile(`import { x } from 'sdk/generated/types.gen';`);
    const violations = await run(noImportFrom(/sdk\/generated/)(file));
    expect(violations).toHaveLength(1);
  });

  it('uses custom message', async () => {
    const file = makeFile(`import { x } from 'bad-module';`);
    const violations = await run(
      noImportFrom('bad-module', { message: 'Do not use bad-module' })(file),
    );
    expect(violations[0]?.message).toBe('Do not use bad-module');
  });

  it('catches dynamic imports', async () => {
    const file = makeFile(`const m = await import('forbidden-pkg');`);
    const violations = await run(noImportFrom('forbidden-pkg')(file));
    expect(violations).toHaveLength(1);
  });
});

describe('requireImportFrom', () => {
  it('passes when the module is imported', async () => {
    const file = makeFile(`import { describe } from 'vitest';`);
    const violations = await run(requireImportFrom('vitest')(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when the module is not imported', async () => {
    const file = makeFile(`// no imports`);
    const violations = await run(requireImportFrom('vitest')(file));
    expect(violations).toHaveLength(1);
  });
});
