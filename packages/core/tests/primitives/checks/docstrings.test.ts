import { describe, it, expect } from 'vitest';
import { requireDocstrings } from '../../../src/primitives/checks/docstrings';
import { makeFile, makeCheckServices, runCheck } from '../../../src/test-helpers';
import type { StructureItem } from '../../../src/services/syntax-tree';

function svcs(structure: StructureItem[]) {
  return makeCheckServices({ syntax: { structure } });
}

describe('requireDocstrings', () => {
  it('flags items without docstrings (default kinds: function, class, method)', async () => {
    const v = await runCheck(
      requireDocstrings(),
      makeFile('src/foo.ts'),
      svcs([
        {
          kind: 'function',
          name: 'noDoc',
          startLine: 1,
          endLine: 2,
          docstring: null,
          children: [],
        },
        {
          kind: 'function',
          name: 'hasDoc',
          startLine: 3,
          endLine: 4,
          docstring: '/** x */',
          children: [],
        },
        {
          kind: 'class',
          name: 'NoDocCls',
          startLine: 5,
          endLine: 6,
          docstring: null,
          children: [],
        },
      ]),
    );
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.message).join('|')).toContain('noDoc');
    expect(v.map((x) => x.message).join('|')).toContain('NoDocCls');
  });

  it('respects a custom kinds list', async () => {
    const v = await runCheck(
      requireDocstrings({ kinds: ['interface'] }),
      makeFile('src/foo.ts'),
      svcs([
        {
          kind: 'function',
          name: 'noDoc',
          startLine: 1,
          endLine: 2,
          docstring: null,
          children: [],
        },
        {
          kind: 'interface',
          name: 'NoDocIface',
          startLine: 3,
          endLine: 4,
          docstring: null,
          children: [],
        },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('NoDocIface');
  });

  it('recurses into children (methods)', async () => {
    const v = await runCheck(
      requireDocstrings(),
      makeFile('src/foo.ts'),
      svcs([
        {
          kind: 'class',
          name: 'C',
          startLine: 1,
          endLine: 10,
          docstring: '/** class */',
          children: [
            { kind: 'method', name: 'm', startLine: 2, endLine: 3, docstring: null, children: [] },
          ],
        },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(2);
  });

  it('returns [] when canProcess is false', async () => {
    const services = makeCheckServices({ overrides: { syntax: { canProcess: () => false } } });
    const v = await runCheck(requireDocstrings(), makeFile('src/foo.ts'), services);
    expect(v).toHaveLength(0);
  });
});
