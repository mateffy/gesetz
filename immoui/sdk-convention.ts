/**
 * SDK sub-domain layout convention — composition of core primitives.
 *
 * Each sub-domain must have: index.ts, interface.ts, http.ts, memory.ts, types.ts, fakes.ts
 * Each sub-domain's hooks/ must have: index.ts, queries.ts
 */
import { select } from '@regeln/core';
import { requireDirectoryStructure } from '@regeln/typescript';
import { forbidFile } from '@regeln/core';

const REQUIRED_SUBDOMAIN_FILES = ['index.ts', 'interface.ts', 'http.ts', 'memory.ts', 'types.ts', 'fakes.ts'];
const REQUIRED_HOOKS_FILES = ['index.ts', 'queries.ts'];

// Each sub-domain index.ts must have all required siblings
export const sdkSubDomainStructure = select('src/sdk/domains/**/index.ts')
  .label('SDK sub-domains must have required files: index, interface, http, memory, types, fakes')
  .check(requireDirectoryStructure(REQUIRED_SUBDOMAIN_FILES));

// hooks/ directory must have required files
export const sdkHooksStructure = select('src/sdk/**/hooks/index.ts')
  .label('SDK hooks directories must have index.ts and queries.ts')
  .check(requireDirectoryStructure(REQUIRED_HOOKS_FILES));

// No legacy query-keys.ts or query-options.ts
export const sdkNoLegacyHookFiles = select(
  'src/sdk/**/hooks/query-keys.ts',
  'src/sdk/**/hooks/query-options.ts',
  'src/sdk/**/hooks.ts',
)
  .label('SDK hooks must not use legacy file names (query-keys.ts, query-options.ts, hooks.ts)')
  .check(forbidFile({ message: 'This file is a legacy pattern — rename to queries.ts in hooks/' }));
