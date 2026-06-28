import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { requireMinStructureCount } from '../../../src/primitives/checks/structure-count';
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

describe('requireMinStructureCount', () => {
  it('passes when count of kind >= minCount', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'a', startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: 'function', name: 'b', startLine: 3, endLine: 4, docstring: null, children: [] },
      ],
    });
    const violations = await run(requireMinStructureCount('function', 2)(makeFile()), layer);
    expect(violations).toHaveLength(0);
  });

  it('fails when count of kind < minCount', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        { kind: 'function', name: 'a', startLine: 1, endLine: 2, docstring: null, children: [] },
      ],
    });
    const violations = await run(requireMinStructureCount('function', 2)(makeFile()), layer);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('found 1');
  });

  it('counts nested children recursively', async () => {
    const layer = makeSyntaxTreeLayer({
      structure: [
        {
          kind: 'class',
          name: 'C',
          startLine: 1,
          endLine: 10,
          docstring: null,
          children: [
            { kind: 'method', name: 'm1', startLine: 2, endLine: 3, docstring: null, children: [] },
            {
              kind: 'method',
              name: 'm2',
              startLine: 4,
              endLine: 9,
              docstring: null,
              children: [
                { kind: 'method', name: 'nested', startLine: 5, endLine: 6, docstring: null, children: [] },
              ],
            },
          ],
        },
      ],
    });
    const violations = await run(requireMinStructureCount('method', 3)(makeFile()), layer);
    expect(violations).toHaveLength(0); // m1 + m2 + nested = 3
  });

  it('returns [] when canProcess is false', async () => {
    const violations = await run(
      requireMinStructureCount('function', 1)(makeFile()),
      SyntaxTreeUnavailable,
    );
    expect(violations).toHaveLength(0);
  });
});
