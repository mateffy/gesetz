import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { requireExplicitReturnType } from '../src';

const run = (source: string, opts = {}) =>
  runCheck(requireExplicitReturnType(opts), makeFile('src/foo.ts', source), makeCheckServices());

describe('requireExplicitReturnType', () => {
  it('flags a function without a return type', async () => {
    const v = await run('function f() { return 1; }');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('warn');
    expect(v[0]?.message).toContain("Function 'f' must declare an explicit return type");
  });

  it('accepts a function with an explicit return type', async () => {
    expect(await run('function f(): number { return 1; }')).toHaveLength(0);
  });

  it('does not cover an arrow function assigned to a const', async () => {
    // Documented limit rather than an accident: the check walks
    // `function_declaration` and `method_definition` only. Asserting it here so
    // widening the rule is a deliberate change with a test to update.
    expect(await run('const f = () => 1;')).toHaveLength(0);
  });

  it('flags each declaration', async () => {
    expect(await run('function a() {}\nfunction b() {}')).toHaveLength(2);
  });

  it('honours the ignore pattern', async () => {
    expect(await run('function f() {}', { ignore: /^f$/ })).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await runCheck(
      requireExplicitReturnType({ message: 'add a return type' }),
      makeFile('src/foo.ts', 'function f() {}'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('add a return type');
  });

  it('accepts an empty file and one it cannot parse', async () => {
    expect(await run('')).toHaveLength(0);
    expect(await run('function f(')).toHaveLength(0);
  });
});
