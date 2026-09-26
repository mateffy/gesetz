import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noBarrelFile } from '../src';

const reexports = (n: number) =>
  Array.from({ length: n }, (_, i) => `export { thing${i} } from './mod${i}';`).join('\n');

const run = (name: string, source: string, opts = {}) =>
  runCheck(noBarrelFile(opts), makeFile(`src/${name}`, source), makeCheckServices());

describe('noBarrelFile', () => {
  it('flags an index file with more re-exports than the budget', async () => {
    const v = await run('index.ts', reexports(6));
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
    expect(v[0]?.message).toContain('re-exports 6 modules (max 5)');
  });

  it('accepts an index file at the budget', async () => {
    expect(await run('index.ts', reexports(5))).toHaveLength(0);
  });

  it('honours a custom budget', async () => {
    expect(await run('index.ts', reexports(2), { maxReexports: 2 })).toHaveLength(0);
    expect(await run('index.ts', reexports(3), { maxReexports: 2 })).toHaveLength(1);
  });

  it('ignores files that are not index files', async () => {
    // A module with many re-exports is only a barrel if it is an entry point.
    expect(await run('barrel.ts', reexports(20))).toHaveLength(0);
  });

  it('counts only re-exports that use `from`, not local re-exports', async () => {
    const local = 'const a = 1;\nexport { a };';
    expect(await run('index.ts', local + '\n' + reexports(6))).toHaveLength(1);
    expect(await run('index.ts', local)).toHaveLength(0);
  });

  it('accepts an index.tsx too', async () => {
    expect(await run('index.tsx', reexports(1))).toHaveLength(0);
  });

  it('accepts an empty index file', async () => {
    expect(await run('index.ts', '')).toHaveLength(0);
  });
});
