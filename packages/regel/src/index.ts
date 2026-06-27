/**
 * `regel` — unified code-quality gate.
 *
 * This package re-exports everything you need from the Regeln monorepo
 * in one import. Install it and you get:
 *
 *   - Core primitives (select, defineConfig, defineArchitecture, checks)
 *   - TypeScript AST checks (export pairs, call shapes, JSX, i18n)
 *   - Effect-TS anti-pattern checks
 *   - Adapters for popular tools (ESLint, Vitest, Prettier, oxlint, …)
 *   - The `regel` CLI binary
 *

 */

// ─── Core ───────────────────────────────────────────────────────────────────
export * from '@regeln/core';

// ─── TypeScript AST checks ──────────────────────────────────────────────────
export * from '@regeln/typescript';

// ─── Effect-TS anti-patterns ────────────────────────────────────────────────
export * from '@regeln/effect-ts';

// ─── Tool adapters ──────────────────────────────────────────────────────────
export { eslint } from '@regeln/eslint';
export type { EslintOptions } from '@regeln/eslint';

export { oxlint } from '@regeln/oxlint';
export type { OxlintOptions } from '@regeln/oxlint';

export { prettier } from '@regeln/prettier';
export type { PrettierOptions } from '@regeln/prettier';

export { oxfmt } from '@regeln/oxfmt';
export type { OxfmtOptions } from '@regeln/oxfmt';

export { vitest } from '@regeln/vitest';
export type { VitestOptions } from '@regeln/vitest';

export { bunTest } from '@regeln/bun-test';
export type { BunTestOptions } from '@regeln/bun-test';

export { storybook } from '@regeln/storybook';
export type { StorybookOptions } from '@regeln/storybook';

export { phpstan } from '@regeln/phpstan';
export type { PhpstanOptions } from '@regeln/phpstan';

export { phpunit } from '@regeln/phpunit';
export type { PhpunitOptions } from '@regeln/phpunit';

export { pest } from '@regeln/pest';
export type { PestOptions } from '@regeln/pest';

// ─── PHP & Laravel ────────────────────────────────────────────────────────────
export { strictTypes, psrNamespace, noInlineQueries, PhpAdapterLive } from '@regeln/php';

export {
  requireStrictTypes,
  requirePsrNamespaces,
  noRawDbQueries,
  noEnvOutsideConfig,
  noDebugHelpers,
  allRules as laravelAllRules,
} from '@regeln/laravel';
