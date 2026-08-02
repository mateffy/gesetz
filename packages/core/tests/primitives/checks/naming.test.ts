import { describe, it, expect } from 'vitest';
import { requireNamingConvention, noForbiddenNames } from '../../../src/primitives/checks/naming';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';
import type { StructureItem } from '../../../src/services/syntax-tree';

function svcs(structure: StructureItem[]) {
  return makeCheckServices({ syntax: { structure } });
}

describe('requireNamingConvention', () => {
  it('flags items whose name does not match the pattern', async () => {
    const v = await runCheck(requireNamingConvention({ kinds: ['function'], pattern: /^[a-z][a-zA-Z0-9]*$/ }), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'goodName', startLine: 1, endLine: 2, docstring: null, children: [] },
      { kind: 'function', name: 'BadName', startLine: 3, endLine: 4, docstring: null, children: [] },
      { kind: 'function', name: 'also_bad', startLine: 5, endLine: 6, docstring: null, children: [] },
    ]));
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.message).join('\n')).toContain('BadName');
    expect(v.map((x) => x.message).join('\n')).toContain('also_bad');
  });

  it('checks all kinds when kinds is omitted', async () => {
    const v = await runCheck(requireNamingConvention({ pattern: /^[A-Z]/ }), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'bad_name', startLine: 1, endLine: 2, docstring: null, children: [] },
      { kind: 'class', name: 'BadClass', startLine: 3, endLine: 4, docstring: null, children: [] },
    ]));
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('bad_name');
  });

  it('recurses into children', async () => {
    const v = await runCheck(requireNamingConvention({ kinds: ['method'], pattern: /^[a-z][a-zA-Z0-9]*$/ }), makeFile('src/foo.ts'), svcs([
      {
        kind: 'class', name: 'GoodClass', startLine: 1, endLine: 10, docstring: null,
        children: [{ kind: 'method', name: 'bad_method', startLine: 2, endLine: 3, docstring: null, children: [] }],
      },
    ]));
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });

  it('returns [] when canProcess is false', async () => {
    const services = makeCheckServices({ overrides: { syntax: { canProcess: () => false } } });
    const v = await runCheck(requireNamingConvention({ pattern: /x/ }), makeFile('src/foo.ts'), services);
    expect(v).toHaveLength(0);
  });
});

describe('noForbiddenNames', () => {
  it('flags names in the banned string list', async () => {
    const v = await runCheck(noForbiddenNames(['foo', 'bar']), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
      { kind: 'function', name: 'bar', startLine: 3, endLine: 4, docstring: null, children: [] },
      { kind: 'function', name: 'safe', startLine: 5, endLine: 6, docstring: null, children: [] },
    ]));
    expect(v).toHaveLength(2);
  });

  it('flags names matching a regex', async () => {
    const v = await runCheck(noForbiddenNames(/^tmp_/), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'tmp_1', startLine: 1, endLine: 2, docstring: null, children: [] },
      { kind: 'function', name: 'tmp_2', startLine: 3, endLine: 4, docstring: null, children: [] },
      { kind: 'function', name: 'real', startLine: 5, endLine: 6, docstring: null, children: [] },
    ]));
    expect(v).toHaveLength(2);
  });

  it('respects the kinds filter', async () => {
    const v = await runCheck(noForbiddenNames(['foo'], { kinds: ['function'] }), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
      { kind: 'class', name: 'foo', startLine: 3, endLine: 4, docstring: null, children: [] },
    ]));
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });

  it('uses custom message callback', async () => {
    const v = await runCheck(noForbiddenNames(['foo'], { message: (n) => `banned: ${n}` }), makeFile('src/foo.ts'), svcs([
      { kind: 'function', name: 'foo', startLine: 1, endLine: 2, docstring: null, children: [] },
    ]));
    expect(v[0]?.message).toBe('banned: foo');
  });
});