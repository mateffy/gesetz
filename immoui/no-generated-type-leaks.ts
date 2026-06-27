/**
 * No generated type leaks — composition of core primitives.
 *
 * Generated OpenAPI types (types.gen.ts) must only be imported inside src/sdk/.
 */
import { select } from '@gesetz/core';
import { requireImportBoundary } from '@gesetz/typescript';

export const noGeneratedTypeLeaks = select('src/**/*.{ts,tsx}')
  .exclude('src/sdk/**')
  .label('Generated API types must not leak outside src/sdk/')
  .check(
    requireImportBoundary({
      source: /types\.gen/,
      allowedIn: 'src/sdk/**',
    }),
  );
