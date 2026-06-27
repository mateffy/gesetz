/**
 * SDK queryOptions discipline — composition of core primitives.
 *
 * - queryOptions() calls must define queryKey, queryFn, and staleTime
 * - SDK query files must export at least one key factory (xKeys)
 */
import { select } from '@gesetz/core';
import { requireCallShape, requireExportFactories } from '@gesetz/typescript';

export const sdkQueryOptionsShape = select('src/sdk/**/hooks/queries.ts')
  .label('queryOptions() calls must define queryKey, queryFn, and staleTime')
  .check(requireCallShape('queryOptions', ['queryKey', 'queryFn', 'staleTime']));

export const sdkQueryKeyFactories = select('src/sdk/**/hooks/queries.ts')
  .label('SDK query files must export at least one key factory (xKeys)')
  .check(requireExportFactories({ pattern: /Keys$/, minCount: 1 }));
