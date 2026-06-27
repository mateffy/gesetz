/**
 * Relative imports — uses the relativeImports core primitive.
 *
 * All relative imports in component files must resolve to existing files.
 */
import { select } from '@gesetz/core';
import { relativeImports } from '@gesetz/core';

export const relativeImportsRule = select('src/components/**/*.{ts,tsx}')
  .exclude('**/*.test.ts', '**/*.test.tsx')
  .label('All relative imports must resolve to existing files')
  .check(relativeImports());
