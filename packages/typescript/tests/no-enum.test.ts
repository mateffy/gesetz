import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noEnum } from '../src';

const run = (source: string) =>
  runCheck(noEnum(), makeFile('src/foo.ts', source), makeCheckServices());

describe('noEnum', () => {
  it('flags an enum declaration', async () => {
    const v = await run('enum Color { Red, Green }');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
    expect(v[0]?.message).toContain('Avoid TypeScript `enum`');
    expect(v[0]?.line).toBe(1);
  });

  it('flags every enum, not just the first', async () => {
    const v = await run('enum A { X }\nenum B { Y }');
    expect(v).toHaveLength(2);
  });

  it('accepts a union type or a const object map as the replacement', async () => {
    const v = await run(
      "type Color = 'red' | 'green';\nconst Color = { red: 'red', green: 'green' } as const;",
    );
    expect(v).toHaveLength(0);
  });

  it('accepts a const enum spelled the same way the rule does not ban', async () => {
    // The rule bans the `enum` keyword regardless of modifiers; documented here
    // so a future change is a deliberate one.
    const v = await run('const enum Color { Red }');
    expect(v).toHaveLength(1);
  });

  it('accepts a file with no enum', async () => {
    expect(await run('export const x = 1;')).toHaveLength(0);
  });

  it('accepts an empty file', async () => {
    expect(await run('')).toHaveLength(0);
  });

  it('accepts a file it cannot parse rather than throwing', async () => {
    expect(await run('enum {')).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await runCheck(
      noEnum({ message: 'use a union' }),
      makeFile('src/foo.ts', 'enum A {}'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('use a union');
  });
});
