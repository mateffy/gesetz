import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noLocalFunctionComponents } from '../src';

const services = (exports: string[] = []) =>
  makeCheckServices({
    syntax: { exports: exports.map((name, i) => ({ name, kind: 'function', line: i + 1 })) },
  });

const run = (source: string, exports: string[] = [], opts = {}) =>
  runCheck(noLocalFunctionComponents(opts), makeFile('src/Foo.tsx', source), services(exports));

describe('noLocalFunctionComponents', () => {
  it('flags a non-exported function that returns JSX', async () => {
    const v = await run('function Inner() { return <p>hi</p>; }');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('accepts an exported component, which is the file main export', async () => {
    const v = await run('export function Outer() { return <p>hi</p>; }', ['Outer']);
    expect(v).toHaveLength(0);
  });

  it('accepts a non-exported function that returns no JSX', async () => {
    expect(await run('function helper() { return 1; }')).toHaveLength(0);
  });

  it('accepts a file that does not parse, without throwing', async () => {
    const v = await run('function Broken() { return <');
    expect(Array.isArray(v)).toBe(true);
  });

  it('accepts a file with no functions', async () => {
    expect(await run('export const x = 1;', ['x'])).toHaveLength(0);
  });
});
