/**
 * Architecture rules — composition of core primitives.
 *
 * - No deep cross-domain imports
 * - Domain folders must have index.ts
 */
import { select } from '@regeln/core';
import { requireChildren } from '@regeln/core';
import { noCrossModuleImports } from '@regeln/typescript';

// Each domain component directory must have an index.ts barrel
export const domainIndexRequired = select('src/components/domains/*/')
  .label('Domain component directories must have an index.ts barrel')
  .check(requireChildren(['index.ts']));

// No deep imports into other domains (e.g., from domains/A into domains/B internals)
export const noDomainCrossImports = select('src/components/domains/**/*.{ts,tsx}')
  .label('Components must not deep-import into other domain internals')
  .check(
    noCrossModuleImports({
      modulePattern: /src\/components\/domains\/([^/]+)\//,
      message: (from, to) =>
        `Domain '${from}' must not import directly into domain '${to}' internals. ` +
        `Import from the domain's index.ts instead.`,
    }),
  );
