import { describe, it, expect } from 'vitest';
import { flattenStructure } from '../../../src/primitives/checks/walk';
import type { StructureItem } from '../../../src/services/syntax-tree';

const item = (name: string, children: StructureItem[] = []): StructureItem => ({
  kind: 'function',
  name,
  startLine: 1,
  endLine: 2,
  docstring: null,
  children,
});

describe('flattenStructure', () => {
  it('returns an empty list for an empty tree', () => {
    expect(flattenStructure([])).toEqual([]);
  });

  it('returns top-level items unchanged when there are no children', () => {
    expect(flattenStructure([item('a'), item('b')]).map((i) => i.name)).toEqual(['a', 'b']);
  });

  it('includes children, parents before children', () => {
    // Checks report a parent before the items nested in it, so order matters.
    const tree = [item('outer', [item('inner', [item('innermost')])]), item('sibling')];
    expect(flattenStructure(tree).map((i) => i.name)).toEqual([
      'outer',
      'sibling',
      'inner',
      'innermost',
    ]);
  });

  it('visits every node exactly once', () => {
    const tree = [item('a', [item('b'), item('c', [item('d')])]), item('e')];
    const names = flattenStructure(tree).map((i) => i.name);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });

  it('does not recurse into a deep tree and blow the stack', () => {
    // The recursive walker this replaced would overflow around this depth.
    let node = item('leaf');
    for (let i = 0; i < 20000; i++) node = item(`n${i}`, [node]);
    let thrown: unknown = null;
    try {
      const flat = flattenStructure([node]);
      expect(flat).toHaveLength(20001);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });

  it('does not mutate the input', () => {
    const child = item('child');
    const parent = item('parent', [child]);
    const snapshot = [parent];
    flattenStructure(snapshot);
    expect(snapshot).toEqual([parent]);
    expect(parent.children).toEqual([child]);
  });
});
