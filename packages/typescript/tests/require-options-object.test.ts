import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { requireOptionsObject } from '../src';

const run = (source: string, opts = { argIndex: 0, requiredKeys: [] as string[] }) =>
  runCheck(
    requireOptionsObject('doThing', opts as never),
    makeFile('src/foo.ts', source),
    makeCheckServices(),
  );

describe('requireOptionsObject', () => {
  it('flags a call whose argument is not an object literal', async () => {
    const v = await run('doThing(1);');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
  });

  it('flags a call with no argument at all', async () => {
    expect(await run('doThing();')).toHaveLength(1);
  });

  it('accepts a call with an object literal and no required keys', async () => {
    expect(await run('doThing({ a: 1 });')).toHaveLength(0);
  });

  it('flags an object literal missing a required key', async () => {
    const v = await run('doThing({ a: 1 });', { argIndex: 0, requiredKeys: ['b'] });
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('b');
  });

  it('accepts an object literal carrying the required key', async () => {
    expect(await run('doThing({ a: 1, b: 2 });', { argIndex: 0, requiredKeys: ['b'] })).toHaveLength(0);
  });

  it('checks the argument at argIndex, not always the first', async () => {
    expect(await run('doThing(1, { a: 1 });', { argIndex: 1, requiredKeys: [] })).toHaveLength(0);
    expect(await run('doThing(1, 2);', { argIndex: 1, requiredKeys: [] })).toHaveLength(1);
  });

  it('ignores calls to other functions', async () => {
    expect(await run('other(1);')).toHaveLength(0);
  });

  it('flags only the call that violates the rule', async () => {
    expect(await run('doThing({ a: 1 });\ndoThing(2);')).toHaveLength(1);
  });

  it('accepts an empty file and one it cannot parse', async () => {
    expect(await run('')).toHaveLength(0);
    expect(await run('doThing(')).toHaveLength(0);
  });
});
