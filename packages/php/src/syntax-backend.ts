/**
 * phpSyntaxBackend -- SyntaxBackend for PHP.
 *
 * Uses @ast-grep/lang-php (a tree-sitter grammar distributed via ast-grep's
 * dynamic-language registration). Replaces the old tree-sitter-php PhpAdapter.
 *
 * Verified ast-grep node kinds for PHP:
 * - namespace_use_declaration: top-level use statement
 * - namespace_use_clause: individual class name inside a use statement
 *   (handles grouped use Foo {A, B} and aliased use Foo\Bar as Baz)
 * - function_call_expression: a function call like dd($x)
 * - class_declaration: a class declaration (.find with kind 'name' for the name)
 * - function_definition: a top-level function declaration
 * - method_declaration: a method inside a class
 * - comment: a // or block comment (preceding sibling for docstrings)
 */
import type {
  SyntaxBackend,
  ParsedImport,
  ParsedCall,
  ParsedExport,
  StructureItem,
} from '@gesetz/core';
import { registerDynamicLanguage, parse } from '@ast-grep/napi';
import type { SgNode } from '@ast-grep/napi';
import { createRequire } from 'node:module';

const moduleRequire = createRequire(import.meta.url);

let phpRegistered = false;

function ensureRegistered(): boolean {
  if (phpRegistered) return true;
  try {
    // `@ast-grep/lang-php` is an optional peer dep -- degrade gracefully.
    const phpLang = moduleRequire('@ast-grep/lang-php');
    registerDynamicLanguage({ php: phpLang });
    phpRegistered = true;
    return true;
  } catch {
    return false; // @ast-grep/lang-php not installed
  }
}

function startLine(node: SgNode): number {
  return node.range().start.line + 1;
}

/** Find a JSDoc/PHPDoc comment attached to a node (its previous sibling). */
function findDocstring(node: SgNode): string | null {
  const prev = node.prev();
  if (prev && prev.kind() === 'comment') {
    return prev.text();
  }
  return null;
}

function extractImports(content: string): ParsedImport[] {
  if (!ensureRegistered()) return [];
  try {
    const root = parse('php', content).root();
    const imports: ParsedImport[] = [];
    for (const decl of root.findAll({ rule: { kind: 'namespace_use_declaration' } })) {
      const line = startLine(decl);
      for (const clause of decl.findAll({ rule: { kind: 'namespace_use_clause' } })) {
        // Text may be "Illuminate\\Database\\Eloquent\\Model" or "HasUuid as Uuid"
        const text = clause.text();
        const specifier = text.split(' as ')[0]?.trim() ?? text;
        imports.push({ specifier, names: [], line });
      }
    }
    return imports;
  } catch {
    return [];
  }
}

function extractCalls(content: string): ParsedCall[] {
  if (!ensureRegistered()) return [];
  try {
    const root = parse('php', content).root();
    return root
      .findAll({ rule: { kind: 'function_call_expression' } })
      .map((n) => ({
        name: n.child(0)?.text() ?? '',
        line: startLine(n),
      }))
      .filter((c) => c.name !== '');
  } catch {
    return [];
  }
}

function extractExports(_content: string): ParsedExport[] {
  // PHP has no explicit export syntax — everything is implicitly available via autoloading.
  return [];
}

function extractStructure(
  content: string,
  _filePath: string,
  includeDocstrings: boolean,
): StructureItem[] {
  if (!ensureRegistered()) return [];
  try {
    const root = parse('php', content).root();
    const items: StructureItem[] = [];

    // Classes
    for (const n of root.findAll({ rule: { kind: 'class_declaration' } })) {
      const nameNode = n.find({ rule: { kind: 'name' } });
      if (!nameNode) continue;
      const docstring = includeDocstrings ? findDocstring(n) : null;
      const children: StructureItem[] = n
        .findAll({ rule: { kind: 'method_declaration' } })
        .map((m): StructureItem => {
          const mname = m.find({ rule: { kind: 'name' } })?.text() ?? '';
          const mdoc = includeDocstrings ? findDocstring(m) : null;
          return {
            kind: 'method',
            name: mname,
            startLine: startLine(m),
            endLine: m.range().end.line + 1,
            docstring: mdoc,
            children: [],
          };
        })
        .filter((m) => m.name !== '');

      items.push({
        kind: 'class',
        name: nameNode.text(),
        startLine: startLine(n),
        endLine: n.range().end.line + 1,
        docstring,
        children,
      });
    }

    // Top-level functions
    for (const n of root.findAll({ rule: { kind: 'function_definition' } })) {
      const nameNode = n.find({ rule: { kind: 'name' } });
      if (!nameNode) continue;
      const docstring = includeDocstrings ? findDocstring(n) : null;
      items.push({
        kind: 'function',
        name: nameNode.text(),
        startLine: startLine(n),
        endLine: n.range().end.line + 1,
        docstring,
        children: [],
      });
    }

    return items;
  } catch {
    return [];
  }
}

export const phpSyntaxBackend: SyntaxBackend = {
  extensions: ['.php'],
  extractImports: (content) => extractImports(content),
  extractCalls: (content) => extractCalls(content),
  extractExports: (content) => extractExports(content),
  extractStructure: (content, filePath, includeDocstrings) =>
    extractStructure(content, filePath, includeDocstrings),
};
