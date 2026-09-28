import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noAsUnknownAs } from '../src';

const run = (source: string) =>
  runCheck(noAsUnknownAs(), makeFile('src/foo.ts', source), makeCheckServices());

describe('noAsUnknownAs', () => {
  it('flags an `as unknown as X` double cast', async () => {
    const v = await run('const x = value as unknown as User;');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('Double cast');
  });

  it('flags `as any as X` too', async () => {
    expect(await run('const x = value as any as User;')).toHaveLength(1);
  });

  it('accepts a single cast', async () => {
    expect(await run('const x = value as User;')).toHaveLength(0);
  });

  it('accepts a cast to unknown, which widens rather than bypasses', async () => {
    expect(await run('const x = value as unknown;')).toHaveLength(0);
  });

  it('accepts the type guard the message recommends', async () => {
    expect(await run('function isUser(v: unknown): v is User { return true; }')).toHaveLength(0);
  });

  it('accepts an empty file and one it cannot parse', async () => {
    expect(await run('')).toHaveLength(0);
    expect(await run('const x = value as unknown as')).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await runCheck(
      noAsUnknownAs({ message: 'use a guard' }),
      makeFile('src/foo.ts', 'const x = v as unknown as User;'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('use a guard');
  });
});
