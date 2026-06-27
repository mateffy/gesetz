/**
 * /laravel — Laravel-specific quality rules.
 *
 * Depends on /php for PHP AST analysis and /phpstan for
 * static analysis integration.
 *
 * @example
 * ```ts
 * import { defineConfig } from '@gesetz/core';
 * import { requireStrictTypes, noRawDbQueries, phpstan } from '@gesetz/laravel';
 *
 * export default defineConfig({
 *   rules: [requireStrictTypes, noRawDbQueries, phpstan()],
 * });
 * ```
 */
export {
  requireStrictTypes,
  requirePsrNamespaces,
  noRawDbQueries,
  noEnvOutsideConfig,
  noDebugHelpers,
} from './checks';

// Re-export phpstan() from /phpstan for convenience
export { phpstan } from '@gesetz/phpstan';

/** All Laravel rules as a ready-to-use array. */
import {
  requireStrictTypes,
  requirePsrNamespaces,
  noRawDbQueries,
  noEnvOutsideConfig,
  noDebugHelpers,
} from './checks';
import { phpstan } from '@gesetz/phpstan';

export const allRules = [
  requireStrictTypes,
  requirePsrNamespaces,
  noRawDbQueries,
  noEnvOutsideConfig,
  noDebugHelpers,
  phpstan(),
];
