import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { requireDocstrings } from '../../../src/primitives/checks/docstrings';
import { makeSyntaxTreeLayer, SyntaxTreeUnavailable } from '../../helpers/syntax-tree';
import type { File } from '../../../src/engine/rule';

function makeFile(name = 'foo.ts'): File {
  return {
    path: `src/${name}`,
    absolutePath: `/abs/src/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: '.' + name.split('.').pop()!,
    dir: 'src',
    content: '',
    size: 0,
    mtimeMs: 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (effect: Effect.Effect<any, any, any>, layer: any): Promise<any> =>
  Effect.provide(effect, layer).pipe(Effect.runPromise as any);

describe('requireDocstrings', () => {
  it('flags items without docstrings (default kinds: function, class, method)', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'noDoc', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'function', name: 'hasDoc', startLine: 3, endLine: 4, docstring: '/** x */', children: [] },
        { kind: 'class', name: 'NoDocCls', startLine: 5, endLine: 6, docstring: null, children: [] },
      ],
    });
    const violations = await run(requireDocstrings()(makeFile()), layer);
    expect(violations).toHaveLength(2);
    expect(violations.map((v: { message: string }) => v.message).join('|')).toContain('noDoc');
    expect(violations.map((v: { message: string }) => v.message).join('|')).toContain('NoDocCls');
  });

  it('respects a custom kinds list', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'noDoc', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'interface', name: 'NoDocIface', startLine: 3, endLine: 4, docstring: null, children: [] },
      ],
    });
    const violations = await run(requireDocstrings({ kinds: ['interface'] })(makeFile()), layer);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('NoDocIface');
  });

  it('recurses into children (methods)', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
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
      ],
    });
    const violations = await run(requireDocstrings()(makeFile()), layer);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('returns [] when canProcess is false', async () => {
    const violations = await run(requireDocstrings()(makeFile()), SyntaxTreeUnavailable);
    expect(violations).toHaveLength(0);
  });
});
