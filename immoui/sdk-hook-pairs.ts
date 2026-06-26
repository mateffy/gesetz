/**
 * SDK hook pairs rule — composition of core primitives.
 *
 * Every useX query hook must export both useX and useSuspenseX.
 * Mutation hooks (use-create-, use-update-, etc.) must NOT use useSuspenseQuery.
 */
import { select } from '@regeln/core';
import { requireExportPairs, noFunctionCalls } from '@regeln/typescript';

const MUTATION_PREFIXES = [
  'use-create-',
  'use-update-',
  'use-delete-',
  'use-move-',
  'use-duplicate-',
  'use-restore-',
];

/**
 * Query hooks must export both useX and useSuspenseX.
 */
export const sdkQueryHookPairs = select('src/sdk/**/hooks/use-*.ts')
  .exclude(...MUTATION_PREFIXES.map((p) => `**/hooks/${p}*`))
  .label('SDK query hooks must export both useX and useSuspenseX')
  .check(
    requireExportPairs((name) => {
      if (!name.startsWith('use') || name.startsWith('useSuspense')) return null;
      return `useSuspense${name.slice(3)}`;
    }),
  );

/**
 * Mutation hooks must not use useSuspenseQuery directly.
 */
export const sdkMutationNoSuspense = select(
  ...MUTATION_PREFIXES.map((p) => `src/sdk/**/hooks/${p}*.ts`),
)
  .label('SDK mutation hooks must not call useSuspenseQuery')
  .check(noFunctionCalls(['useSuspenseQuery']));
