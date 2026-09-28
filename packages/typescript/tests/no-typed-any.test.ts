import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noTypedAny } from '../src';

const run = (source: string) =>
  runCheck(noTypedAny(), makeFile('src/foo.ts', source), makeCheckServices());

describe('noTypedAny', () => {
  it('flags an `any` annotation', async () => {
    const v = await run('function f(x: any): void {}');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('Unexpected `any`');
  });

  it('flags `any` in a return type', async () => {
    expect(await run('function f(): any { return 1; }')).toHaveLength(1);
  });

  it('flags each occurrence', async () => {
    expect(await run('function f(a: any, b: any): void {}')).toHaveLength(2);
  });

  it('accepts `unknown`, which is the suggested replacement', async () => {
    expect(await run('function f(x: unknown): void {}')).toHaveLength(0);
  });

  it('does not flag the word "any" in an identifier or a string', async () => {
    expect(await run('const anybody = 1; const s = "any";')).toHaveLength(0);
  });

  it('accepts an empty file', async () => {
    expect(await run('')).toHaveLength(0);
  });

  it('does not throw on malformed input', async () => {
    // oxc-parser recovers from syntax errors rather than returning null, so this
    // still reports the `any` it can see. The contract being checked is that a
    // broken file never throws out of the check.
    const v = await run('function f(x: any');
    expect(Array.isArray(v)).toBe(true);
  });
});
