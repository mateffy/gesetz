import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noDefaultExport } from '../src';

const run = (source: string) =>
  runCheck(noDefaultExport(), makeFile('src/foo.ts', source), makeCheckServices());

describe('noDefaultExport', () => {
  it('flags a default export', async () => {
    const v = await run('export default function foo() {}');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
    expect(v[0]?.message).toContain('Avoid `export default`');
  });

  it('flags a default export of a value, not just a function', async () => {
    expect(await run('const x = 1;\nexport default x;')).toHaveLength(1);
  });

  it('accepts a named export', async () => {
    expect(await run('export function foo() {}')).toHaveLength(0);
  });

  it('accepts a re-export', async () => {
    expect(await run("export { foo } from './foo';")).toHaveLength(0);
  });

  it('accepts a file with no exports', async () => {
    expect(await run('const x = 1;')).toHaveLength(0);
  });

  it('accepts an empty file', async () => {
    expect(await run('')).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await runCheck(
      noDefaultExport({ message: 'named only' }),
      makeFile('src/foo.ts', 'export default 1;'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('named only');
  });
});
