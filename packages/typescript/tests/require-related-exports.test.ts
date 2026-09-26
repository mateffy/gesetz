import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
import { requireRelatedExports, requireExportsMatching } from '../src';

const pairs: Record<string, string[]> = { Foo: ['FooProps'], Bar: ['BarProps'] };
const getRelated = (name: string) => pairs[name] ?? null;

/** `syntax.process` is stubbed, so exports come from the fixture rather than a parse. */
const services = (exports: string[]) =>
  makeCheckServices({
    syntax: { exports: exports.map((name, i) => ({ name, kind: 'function', line: i + 1 })) },
  });

const run = (exports: string[], opts = {}) =>
  runCheck(requireRelatedExports(getRelated, opts), makeFile('src/foo.ts'), services(exports));

describe('requireRelatedExports', () => {
  it('flags an export whose related export is missing', async () => {
    const v = await run(['Foo']);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('FooProps');
  });

  it('accepts an export that has its related export', async () => {
    expect(await run(['Foo', 'FooProps'])).toHaveLength(0);
  });

  it('ignores exports the getRelated function does not know about', async () => {
    expect(await run(['Unrelated'])).toHaveLength(0);
  });

  it('flags each export with a missing counterpart', async () => {
    expect(await run(['Foo', 'Bar'])).toHaveLength(2);
  });

  it('reports the line of the export when the backend provides one', async () => {
    const v = await run(['Foo', 'FooProps', 'Bar']);
    expect(v[0]?.line).toBe(3);
  });

  it('accepts a file with no exports', async () => {
    expect(await run([])).toHaveLength(0);
  });
});

describe('requireExportsMatching', () => {
  const matching = (exports: string[], pattern: RegExp, minCount = 1) =>
    runCheck(requireExportsMatching(pattern, minCount), makeFile('src/foo.ts'), services(exports));

  it('accepts when enough exports match', async () => {
    expect(await matching(['useFoo', 'useBar'], /^use[A-Z]/)).toHaveLength(0);
  });

  it('flags when too few exports match', async () => {
    const v = await matching(['foo', 'bar'], /^use[A-Z]/);
    expect(v).toHaveLength(1);
  });

  it('honours the minimum count', async () => {
    expect(await matching(['useFoo'], /^use[A-Z]/, 2)).toHaveLength(1);
    expect(await matching(['useFoo', 'useBar'], /^use[A-Z]/, 2)).toHaveLength(0);
  });
});
