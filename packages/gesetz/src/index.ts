/**
 * gesetz — unified code-quality gate.
 *
 * This package gives you the core primitives and the CLI. Install it and
 * you get select, defineConfig, defineArchitecture, and all built-in checks.
 *
 * Language-specific adapters (ESLint, Vitest, PHPStan, ts-morph checks)
 * are installed as separate @gesetz/* packages so you only pull in what
 * you use.
 */

// ─── Core ───────────────────────────────────────────────────────────────────
export * from '@gesetz/core';
