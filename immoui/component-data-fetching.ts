/**
 * Component data fetching discipline — composition of core primitives.
 *
 * Components must not import from @tanstack/react-query directly.
 * They must use named SDK hooks instead.
 */
import { select } from '@gesetz/core';
import { noImportFrom } from '@gesetz/core';
import { noFunctionCalls } from '@gesetz/typescript';

const ALLOWED_PATTERNS = [
  'src/sdk/**',
  'src/router.tsx',
  'src/**/__tests__/**',
  'src/**/*.stories.tsx',
  'src/**/*.test.tsx',
];

export const noDirectTanstackImport = select('src/**/*.{ts,tsx}')
  .exclude(...ALLOWED_PATTERNS)
  .label('Components must not import from @tanstack/react-query directly')
  .check(
    noImportFrom('@tanstack/react-query', {
      message:
        'Use SDK hooks instead of importing from @tanstack/react-query directly. ' +
        'Only src/sdk/ files may use TanStack Query primitives.',
    }),
  );

export const noDirectQueryHooks = select('src/components/**/*.{ts,tsx}')
  .exclude('**/*.stories.tsx', '**/*.test.tsx')
  .label('Components must not call useQuery or useSuspenseQuery directly')
  .check(
    noFunctionCalls(['useQuery', 'useSuspenseQuery'], {
      message: (name) =>
        `Do not call ${name}() directly. Use named SDK hooks like useSuspenseEstate(id) instead.`,
    }),
  );
