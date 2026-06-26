import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { FileSystem } from '../../services/fs';
import type { Check, File, Violation } from '../../engine/rule';

/**
 * Checks that a sibling file with the given suffix exists.
 *
 * @example
 * // Every Foo.tsx must have a sibling Foo.stories.tsx
 * requireSibling('.stories.tsx')
 */
export function requireSibling(
  suffix: string,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const siblingPath = nodePath.join(
        nodePath.dirname(file.absolutePath),
        file.stem + suffix,
      );
      const exists = yield* fs.exists(siblingPath);
      if (exists) {
        return [];
      }
      return [
        {
          rule: '',
          severity: opts.severity ?? 'error',
          source: 'core' as const,
          message:
            opts.message ??
            `Missing sibling file: ${file.stem}${suffix}`,
          path: file.path,
        },
      ];
    });
}

/**
 * Checks that each matched directory contains all the required child file names.
 * Applied to files — uses the file's directory.
 *
 * @example
 * // Every directory with an index.ts must also have a types.ts
 * requireChildren(['types.ts', 'interface.ts'])
 */
export function requireChildren(
  requiredPaths: string[],
  opts: { message?: (missing: string) => string } = {},
): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const dir = nodePath.dirname(file.absolutePath);
      const violations: Violation[] = [];

      for (const required of requiredPaths) {
        const childPath = nodePath.join(dir, required);
        const exists = yield* fs.exists(childPath);
        if (!exists) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message:
              opts.message?.(required) ??
              `Missing required file: ${required}`,
            path: file.path,
          });
        }
      }

      return violations;
    });
}

/**
 * A check that marks any matched file as a violation.
 * Useful for enforcing that certain files do not exist.
 *
 * @example
 * select('src/**\/node_modules/**').label('No node_modules in src').check(forbidFile())
 */
export function forbidFile(
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return (file) =>
    Effect.succeed([
      {
        rule: '',
        severity: opts.severity ?? 'error',
        source: 'core' as const,
        message: opts.message ?? `File should not exist: ${file.path}`,
        path: file.path,
      },
    ]);
}

/**
 * Checks that all relative imports in the file resolve to existing files.
 *
 * Recognizes `.ts`, `.tsx`, `/index.ts`, and `/index.tsx` resolution.
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
