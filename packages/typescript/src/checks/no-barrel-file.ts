import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';
import { parseFile, findByKind } from './shared';

export interface NoBarrelFileOptions {
  /** Maximum number of re-exports allowed before the file is flagged. Default: 5 */
  readonly maxReexports?: number;
  readonly message?: string;
}

/**
 * Flags barrel files (`index.ts`/`index.tsx`) that only re-export from other
 * modules. Barrel files harm tree-shaking and obscure the true source of
 * symbols.
 *
 * A file is considered a barrel when its name is `index.{ts,tsx}` and the
 * number of `export ... from '...'` re-exports exceeds `maxReexports`.
 *
 * Implemented with ast-grep (syntactic).
 *
 * @example
 * select('src/**\/index.{ts,tsx}').check(noBarrelFile())
 */
export function noBarrelFile(opts: NoBarrelFileOptions = {}): Check {
  const maxReexports = opts.maxReexports ?? 5;

  return (file) =>
    Effect.sync(() => {
      // Only consider index files
      if (file.name !== 'index.ts' && file.name !== 'index.tsx') return [];

      const root = parseFile(file.content, file.path);
      if (root === null) return [];

      // Re-exports are `export_statement` nodes that contain a `from` keyword
      // (i.e. `export ... from '...'`). `export { a, b }` without `from` is
      // a local re-export, not a barrel re-export.
      const exportStmts = findByKind(root, 'export_statement');
      const reexports = exportStmts.filter((e) =>
        e.children().some((c) => c.kind() === 'from'),
      );

      if (reexports.length <= maxReexports) return [];

      return [
        {
          rule: '',
          severity: 'warn',
          source: 'core',
          message:
            opts.message ??
            `Barrel file re-exports ${reexports.length} modules (max ${maxReexports}) — import from source files directly`,
          path: file.path,
        },
      ];
    });
}
