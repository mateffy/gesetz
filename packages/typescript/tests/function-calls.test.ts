import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noFunctionCalls } from '../src';

const run = (source: string, names: string[], opts = {}) =>
  runCheck(noFunctionCalls(names, opts), makeFile('src/foo.ts', source), makeCheckServices());

describe('noFunctionCalls', () => {
  it('flags a forbidden call', async () => {
    const v = await run('eval("1");', ['eval']);
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('Forbidden function call: eval()');
    expect(v[0]?.line).toBe(1);
  });

  it('flags a member-access call by its full name', async () => {
    expect(await run('console.log(1);', ['console.log'])).toHaveLength(1);
  });

  it('does not flag a call that merely ends with the forbidden name', async () => {
    // `notconsole.log(1)` is a different call, and a naive substring match
    // would report it.
    expect(await run('notconsole.log(1);', ['console.log'])).toHaveLength(0);
  });

  it('flags each occurrence', async () => {
    expect(await run('eval("a"); eval("b");', ['eval'])).toHaveLength(2);
  });

  it('accepts a file with none of the named calls', async () => {
    expect(await run('doThing();', ['eval', 'new Function'])).toHaveLength(0);
  });

  it('accepts an empty file and one it cannot parse', async () => {
    expect(await run('', ['eval'])).toHaveLength(0);
    expect(await run('eval(', ['eval'])).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await run('eval("x");', ['eval'], { message: (n: string) => `no ${n}` });
    expect(v[0]?.message).toBe('no eval');
  });
});
