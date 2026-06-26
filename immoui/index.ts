/**
 * immoui quality rules — all rules composed from quality-assurance core primitives.
 *
 * This is NOT part of the quality-assurance package.
 * It is a reference implementation showing how the primitives compose into
 * project-specific rules.
 *
 * Usage in a Vitest test file:
 * ```ts
 * import { defineQualityTestsVitest } from '@regeln/core/reporters';
 * import { defineConfig } from '@regeln/core';
 * import { allRules } from './index';
 *
 * const config = defineConfig({ projectRoot: '../../immoui', rules: allRules });
 * defineQualityTestsVitest(config);
 * ```
 */
export { sdkQueryHookPairs, sdkMutationNoSuspense } from './sdk-hook-pairs';
export { sdkQueryOptionsShape, sdkQueryKeyFactories } from './sdk-query-options';
export { sdkMutationDiscipline } from './sdk-mutation-discipline';
export { sdkSubDomainStructure, sdkHooksStructure, sdkNoLegacyHookFiles } from './sdk-convention';
export { noRawJsxText, noRawJsxProps } from './no-raw-i18n-strings';
export { noGeneratedTypeLeaks } from './no-generated-type-leaks';
export { noDirectTanstackImport, noDirectQueryHooks } from './component-data-fetching';
export { noUiPrimitiveImports, noLocalComponentsInRoutes, noUseStateInRoutes } from './route-discipline';
export { storybookNoExplicitTitle } from './storybook-grouping';
export { testQualityScore } from './test-quality';
export { componentStories, componentTests } from './component-coverage';
export { domainIndexRequired, noDomainCrossImports } from './architecture';
export { relativeImportsRule } from './relative-imports';

import { sdkQueryHookPairs, sdkMutationNoSuspense } from './sdk-hook-pairs';
import { sdkQueryOptionsShape, sdkQueryKeyFactories } from './sdk-query-options';
import { sdkMutationDiscipline } from './sdk-mutation-discipline';
import { sdkSubDomainStructure, sdkHooksStructure, sdkNoLegacyHookFiles } from './sdk-convention';
import { noRawJsxText, noRawJsxProps } from './no-raw-i18n-strings';
import { noGeneratedTypeLeaks } from './no-generated-type-leaks';
import { noDirectTanstackImport, noDirectQueryHooks } from './component-data-fetching';
import { noUiPrimitiveImports, noLocalComponentsInRoutes, noUseStateInRoutes } from './route-discipline';
import { storybookNoExplicitTitle } from './storybook-grouping';
import { testQualityScore } from './test-quality';
import { componentStories, componentTests } from './component-coverage';
import { domainIndexRequired, noDomainCrossImports } from './architecture';
import { relativeImportsRule } from './relative-imports';

/** All immoui quality rules. Pass to defineConfig({ rules: allRules }). */
export const allRules = [
  // SDK conventions
  sdkQueryHookPairs,
  sdkMutationNoSuspense,
  sdkQueryOptionsShape,
  sdkQueryKeyFactories,
  sdkMutationDiscipline,
  sdkSubDomainStructure,
  sdkHooksStructure,
  sdkNoLegacyHookFiles,
  // i18n
  noRawJsxText,
  noRawJsxProps,
  // Type boundaries
  noGeneratedTypeLeaks,
  // Data fetching
  noDirectTanstackImport,
  noDirectQueryHooks,
  // Route discipline
  noUiPrimitiveImports,
  noLocalComponentsInRoutes,
  noUseStateInRoutes,
  // Storybook
  storybookNoExplicitTitle,
  // Test quality
  testQualityScore,
  // Component coverage
  componentStories,
  componentTests,
  // Architecture
  domainIndexRequired,
  noDomainCrossImports,
  relativeImportsRule,
];
