/**
 * typescriptSyntaxBackend — SyntaxBackend for TypeScript/JavaScript.
 *
 * Uses two tools, each where it genuinely excels:
 * - `oxc-parser` for imports + exports (returns clean module specifiers
 *   via `staticImports[].moduleRequest.value` and export names via
 *   `staticExports[].entries[].exportName.name`).
 * - `@ast-grep/napi` for calls + structure (function/class/method declarations
 *   and JSDoc via preceding sibling comment nodes).
 *
 * `ts-morph` is NOT used here. No check in this package needs the TypeScript
 * type checker. For type-checked rules like `no-floating-promises`, use
 * `@gesetz/eslint` or `@gesetz/oxlint` with `--type-aware`.
 */
import type {
  SyntaxBackend,
  ParsedImport,
  ParsedCall,
  ParsedExport,
  StructureItem,
} from '@gesetz/core';
import type { SgNode } from '@ast-grep/napi';
import { parseAstGrep, parseOxc } from './parse-memo';

/** oxc-parser returns byte offsets; convert to a 1-indexed line number. */
function byteOffsetToLine(content: string, byteOffset: number): number {
  return content.slice(0, byteOffset).split('\n').length;
}

function extractImports(content: string, filePath: string): ParsedImport[] {
  const result = parseOxc(content, filePath);
  if (result === null) return [];
  return result.module.staticImports.map((imp) => ({
    specifier: imp.moduleRequest.value,
    names: imp.entries
      .map((e) => e.importName?.name ?? '')
      .filter(Boolean),
    line: byteOffsetToLine(content, imp.moduleRequest.start ?? 0),
  }));
}

function extractExports(content: string, filePath: string): ParsedExport[] {
  const result = parseOxc(content, filePath);
  if (result === null) return [];
  const exports: ParsedExport[] = [];
  for (const exp of result.module.staticExports) {
    for (const entry of exp.entries) {
      const name = entry.exportName?.name;
      // Skip `default` exports (name is null) — they have no identifier.
      if (name && name !== 'default') {
        exports.push({
          name,
          kind: 'unknown', // oxc doesn't expose declaration kind here
          line: byteOffsetToLine(content, entry.start ?? 0),
        });
      }
    }
  }
  return exports;
}

function extractCalls(content: string, filePath: string): ParsedCall[] {
  try {
    const ext = '.' + (filePath.split('.').pop() ?? '');
    const root = parseAstGrep(content, ext);
    if (root === null) return [];
    const calls = root.findAll({ rule: { kind: 'call_expression' } });
    return calls
      .map((n) => ({
        name: n.child(0)?.text() ?? '',
        line: n.range().start.line + 1,
      }))
      .filter((c) => c.name !== '');
  } catch {
    return [];
  }
}

/**
 * Find a JSDoc comment attached to a node.
 * - If the node's previous sibling is a `comment`, use it.
 * - Else if the node is wrapped in an `export_statement`, the comment is
 *   the previous sibling of the export_statement.
 */
function findDocstring(node: SgNode): string | null {
  const prev = node.prev();
  if (prev && prev.kind() === 'comment') {
    return prev.text();
  }
  const parent = node.parent();
  if (parent && parent.kind() === 'export_statement') {
    const pprev = parent.prev();
    if (pprev && pprev.kind() === 'comment') {
      return pprev.text();
    }
  }
  return null;
}

function extractStructure(
  content: string,
  filePath: string,
  includeDocstrings: boolean,
): StructureItem[] {
  try {
    const ext = '.' + (filePath.split('.').pop() ?? '');
    const root = parseAstGrep(content, ext);
    if (root === null) return [];
    const items: StructureItem[] = [];

    // Function declarations (exported and non-exported)
    const fnDecls = root.findAll({ rule: { kind: 'function_declaration' } });
    for (const n of fnDecls) {
      const nameNode = n.find({ rule: { kind: 'identifier' } });
      if (!nameNode) continue;
      const r = n.range();
      const docstring = includeDocstrings ? findDocstring(n) : null;
      items.push({
        kind: 'function',
        name: nameNode.text(),
        startLine: r.start.line + 1,
        endLine: r.end.line + 1,
        docstring,
        children: [],
      });
    }

    // Class declarations
    const classDecls = root.findAll({ rule: { kind: 'class_declaration' } });
    for (const n of classDecls) {
      const nameNode = n.find({ rule: { kind: 'type_identifier' } });
      if (!nameNode) continue;
      const r = n.range();
      const docstring = includeDocstrings ? findDocstring(n) : null;
      const methods = n.findAll({ rule: { kind: 'method_definition' } });
      const children: StructureItem[] = methods
        .map((m): StructureItem => {
          const mname = m.find({ rule: { kind: 'property_identifier' } });
          const mr = m.range();
          const mdoc = includeDocstrings ? findDocstring(m) : null;
          return {
            kind: 'method',
            name: mname?.text() ?? '',
            startLine: mr.start.line + 1,
            endLine: mr.end.line + 1,
            docstring: mdoc,
            children: [],
          };
        })
        .filter((m) => m.name !== '');

      items.push({
        kind: 'class',
        name: nameNode.text(),
        startLine: r.start.line + 1,
        endLine: r.end.line + 1,
        docstring,
        children,
      });
    }

    return items;
  } catch {
    return [];
  }
}

export const typescriptSyntaxBackend: SyntaxBackend = {
  extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  extractImports,
  extractCalls,
  extractExports,
  extractStructure,
};
