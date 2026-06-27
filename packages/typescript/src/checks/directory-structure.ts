import type { Check } from '@gesetz/core';
import { requireChildren } from '@gesetz/core';

/**
 * Checks that each matched directory contains all required file names.
 * The file this check runs on is treated as a "directory index" (e.g., index.ts).
 *
 * @example
 * // Every SDK sub-domain must have index.ts, interface.ts, http.ts, memory.ts, types.ts
 * requireDirectoryStructure(['interface.ts', 'http.ts', 'memory.ts', 'types.ts'])
 */
export const requireDirectoryStructure: (requiredFiles: string[]) => Check = requireChildren;
