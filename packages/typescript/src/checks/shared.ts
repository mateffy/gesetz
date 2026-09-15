/**
 * Shared ast-grep helpers for TypeScript/JavaScript checks.
 *
 * Replaces the old ts-morph `loadSourceFile` helper. Checks here no longer
 * need ts-morph — ast-grep (via the `ts`/`tsx`/`js`/`jsx` parsers) provides
 * all the syntactic traversal we need, with zero type-checker dependency.
 *
 * For type-checked rules (e.g. no-floating-promises), use `@gesetz/eslint`
 * or `@gesetz/oxlint` — those wrap ESLint/oxlint with `--type-aware`.
 */
import type { SgNode } from '@ast-grep/napi';
import { parseAstGrep } from '../parse-memo';

/**
 * Parse file content into an ast-grep root node, or null on parse failure.
 *
 * Memoized by (extension, content) so the many ast-grep based checks that run
 * against one file share a single parse.
 */
export function parseFile(content: string, filePath: string): SgNode | null {
  const ext = '.' + (filePath.split('.').pop() ?? '');
  return parseAstGrep(content, ext);
}

/** Find all nodes of a given tree-sitter kind, recursively. */
export function findByKind(root: SgNode, kind: string): SgNode[] {
  return root.findAll({ rule: { kind } });
}

/** The text of a node's first child matching a kind, or null. */
export function findChildText(node: SgNode, kind: string): string | null {
  const child = node.find({ rule: { kind } });
  return child ? child.text() : null;
}

/** Returns the actual argument nodes of a call_expression (excludes parens). */
export function getCallArgs(call: SgNode): SgNode[] {
  const args = call.field('arguments');
  if (!args) return [];
  return [...args.children()].filter((n) => n.isNamed());
}

/** 1-indexed start line of a node. */
export function startLine(node: SgNode): number {
  return node.range().start.line + 1;
}

/**
 * Walk descendants of `node` and return those matching a predicate.
 * Use this when you need descendants filtered by something other than kind.
 */
export function walkDescendants(node: SgNode, predicate: (n: SgNode) => boolean): SgNode[] {
  const out: SgNode[] = [];
  function recurse(n: SgNode): void {
    for (const child of n.children()) {
      if (predicate(child)) out.push(child);
      recurse(child);
    }
  }
  recurse(node);
  return out;
}
