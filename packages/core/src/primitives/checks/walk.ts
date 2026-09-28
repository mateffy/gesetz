import type { StructureItem } from '../../services/syntax-tree';

/**
 * Every item in a structure tree, parents before children, as a flat list.
 *
 * Checks that walk structure mostly want to test each item the same way, and a
 * recursive nested walker puts an `if` inside a `for` inside a function inside a
 * `try` — six levels for a three-line rule. Flattening first keeps each check at
 * one level of indentation and reads as a filter over items.
 *
 * Breadth-first, so a parent is always reported before its children.
 */
export function flattenStructure(items: readonly StructureItem[]): StructureItem[] {
  const out: StructureItem[] = [];
  const queue: StructureItem[] = [...items];
  let index = 0;
  while (index < queue.length) {
    const item = queue[index++]!;
    out.push(item);
    queue.push(...item.children);
  }
  return out;
}
