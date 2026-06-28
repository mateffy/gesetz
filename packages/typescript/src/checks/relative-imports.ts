import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { FileSystem } from '@gesetz/core';
import type { Check, Violation } from '@gesetz/core';

/**
 * Checks that all relative imports in the file resolve to existing files.
 *
 * Recognizes `.ts`, `.tsx`, `/index.ts`, and `/index.tsx` resolution.
 *
 * Moved from `@gesetz/core` — this is a TypeScript/JavaScript-specific check.
 *
 * @example
 * select('src/**\/*.{ts,tsx}').label('Relative imports must resolve').check(relativeImports())
 */
export function relativeImports(opts: { message?: (imp: string) => string } = {}): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      // Match ES import/export from relative paths
      const matches = [...file.content.matchAll(/from\s+['"](\.[./][^'"]*)['"]/g)];
      const violations: Violation[] = [];

      for (const match of matches) {
        const imp = match[1];
        if (imp === undefined) continue;

        const base = nodePath.resolve(nodePath.dirname(file.absolutePath), imp);
        const cleanBase = base.replace(/\.[jt]sx?$/, '');

        const candidates = [
          cleanBase + '.ts',
          cleanBase + '.tsx',
          cleanBase + '/index.ts',
          cleanBase + '/index.tsx',
          base, // bare path (rare)
        ];

        let found = false;
        for (const candidate of candidates) {
          const exists = yield* fs.exists(candidate);
          if (exists) {
            found = true;
            break;
          }
        }

        if (!found) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(imp) ??
              `Relative import '${imp}' does not resolve to an existing file`,
            path: file.path,
          });
        }
      }

      return violations;
    });
}
