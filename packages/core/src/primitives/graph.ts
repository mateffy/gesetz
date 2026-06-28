import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { FileSystem, ProjectRoot } from '../services/fs';
import { SyntaxTree } from '../services/syntax-tree';
import type { ParsedImport } from '../services/syntax-tree';
import { ImportResolver } from '../services/import-resolver';
import type { File, Rule, Violation } from '../engine/rule';

export interface NoCyclesOptions {
  /** Human-readable label / description. */
  readonly label?: string;
  /** Stable rule id. Default: 'no-cycles'. */
  readonly id?: string;
}

/** Extension/index variants to try when matching a resolved path to a real file. */
function candidatePaths(resolved: string): string[] {
  return [
    nodePath.normalize(resolved),
    nodePath.normalize(resolved + '.ts'),
    nodePath.normalize(resolved + '.tsx'),
    nodePath.normalize(resolved + '.js'),
    nodePath.normalize(resolved + '.jsx'),
    nodePath.normalize(resolved + '.php'),
    nodePath.normalize(nodePath.join(resolved, 'index.ts')),
    nodePath.normalize(nodePath.join(resolved, 'index.tsx')),
    nodePath.normalize(nodePath.join(resolved, 'index.js')),
    nodePath.normalize(nodePath.join(resolved, 'index.php')),
  ];
}

/**
 * Creates a Rule that checks for circular dependencies using the SyntaxTree
 * service (for import extraction) and ImportResolver (for resolving relative
 * specifiers to absolute paths), then a DFS over the dependency graph.
 *
 * Files whose extension has no registered SyntaxBackend are skipped.
 * External (non-resolvable) imports are ignored — only local-file cycles
 * are reported.
 *
 * @example
 * noCycles('src/**\/*.{ts,tsx}', { label: 'No circular dependencies' })
 */
export function noCycles(pattern: string | string[], opts: NoCyclesOptions = {}): Rule {
  const id = opts.id ?? 'no-cycles';
  const description = opts.label ?? 'No circular dependencies';
  const patterns = Array.isArray(pattern) ? pattern : [pattern];

  const run = Effect.gen(function* () {
    const fs = yield* FileSystem;
    const root = yield* ProjectRoot;
    const st = yield* SyntaxTree;
    const resolver = yield* ImportResolver;

    const files = yield* fs.glob(patterns, { cwd: root }).pipe(
      Effect.catchAll(() => Effect.succeed<File[]>([])),
    );
    if (files.length === 0) return [];

    const rel = (absPath: string): string => {
      const r = nodePath.relative(root, absPath);
      return r.startsWith('..') ? absPath : r;
    };

    // Build adjacency map: absolutePath → [absolutePath, ...]
    const fileByAbs = new Map<string, File>();
    for (const file of files) {
      fileByAbs.set(nodePath.normalize(file.absolutePath), file);
    }

    const adjacency = new Map<string, string[]>();
    for (const file of files) {
      const norm = nodePath.normalize(file.absolutePath);
      if (!st.canProcess(file)) continue;
      const result = yield* st.process(file, { imports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );
      const deps: string[] = [];
      for (const imp of result.imports as readonly ParsedImport[]) {
        const resolved = resolver.resolve(file, imp.specifier);
        if (resolved === null) continue;
        for (const candidate of candidatePaths(resolved)) {
          if (fileByAbs.has(candidate)) {
            deps.push(candidate);
            break;
          }
        }
      }
      adjacency.set(norm, deps);
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const violations: Violation[] = [];

    function dfs(node: string, stack: string[]): void {
      if (inStack.has(node)) {
        const cycleStart = stack.indexOf(node);
        const cycle = stack.slice(cycleStart);
        const chain = cycle.map((p) => rel(p)).join(' → ') + ' → ' + rel(node);
        violations.push({
          rule: id,
          message: `Circular dependency: ${chain}`,
          path: rel(stack[stack.length - 1] ?? node),
          severity: 'error',
          source: 'custom',
        });
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      inStack.add(node);
      for (const dep of adjacency.get(node) ?? []) {
        dfs(dep, [...stack, node]);
      }
      inStack.delete(node);
    }

    for (const file of files) {
      dfs(nodePath.normalize(file.absolutePath), []);
    }

    return violations;
  });

  return { id, description, run };
}
