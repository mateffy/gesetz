import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { noObjectProperty } from '../src';

const run = (source: string, varName = 'meta', propName = 'title') =>
  runCheck(
    noObjectProperty(varName, propName),
    makeFile('src/Foo.tsx', source),
    makeCheckServices(),
  );

describe('noObjectProperty', () => {
  it('flags the property when it is set at the top level of the object', async () => {
    const v = await run('const meta = {\n  title: "Hello",\n  component: Foo,\n};');
    expect(v).toHaveLength(1);
    expect(v[0]?.severity).toBe('error');
    expect(v[0]?.message).toContain('title');
  });

  it('accepts the object when the property is nested inside another key', async () => {
    // Only the object's own top level is checked; nested objects are elsewhere.
    const v = await run('const meta = {\n  parameters: {\n    title: "Hello",\n  },\n};');
    expect(v).toHaveLength(0);
  });

  it('accepts an object without the property', async () => {
    expect(await run('const meta = {\n  component: Foo,\n};')).toHaveLength(0);
  });

  it('accepts a file with no such declaration', async () => {
    expect(await run('const other = { title: "x" };')).toHaveLength(0);
  });

  it('accepts an empty file', async () => {
    expect(await run('')).toHaveLength(0);
  });

  it('honours a custom message', async () => {
    const v = await runCheck(
      noObjectProperty('meta', 'title', { message: 'set title in decorators' }),
      makeFile('src/Foo.tsx', 'const meta = {\n  title: "x",\n};'),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe('set title in decorators');
  });
});
