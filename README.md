# Gesetz

> **Gesetz** (German for "laws") — a unified code-quality gate that lets you write your own project rules as easily as writing a config file.

## Why Gesetz exists

Every codebase has conventions that no generic linter knows about:

- *"Every module in `src/` must have a `README.md`"*
- *"No file should exceed 400 lines"*
- *"No one should import from `src/legacy/` — we're migrating away"*
- *"Every API endpoint file needs a sibling `.test.ts`"*
- *"Console logs left in production code break our log pipeline"*
- *"Feature A must not import internals from Feature B"*

ESLint, PHPStan, and Vitest are excellent at what they do. But they don't know *your* architecture. Gesetz bridges that gap: **you write project-specific rules in plain TypeScript, and Gesetz runs them alongside your existing tools in a single, scored report.**

**Gesetz does not replace your linters.** It wraps them. You still run ESLint, Vitest, PHPStan — but their output and your custom rules all feed into one unified `Violation` format, one category score, one CLI. Because the rule engine is language-agnostic, the same `gesetz check` covers your TypeScript frontend, your PHP backend, and whatever else lives in the repo.

| Category | What it measures |
|---|---|
| **strictness** | Type safety, `any`, `as`, non-null assertions, floating promises |
| **structure** | Code shape: file/function size, nesting, magic numbers, empty catch blocks |
| **organization** | Monorepo health: cycles, layer violations, import discipline, file pairing |
| **cleanup** | Dead code, AI residue: console logs, trivial comments, debugging files |
| **security** | Secrets, SQL injection, unsafe innerHTML, hardcoded tokens |

Categories are extensible — `category` is just a string, so you can define your own (e.g. `category: 'api-conventions'` or `category: 'react'`).

The goal is simple: **one command, one score, one decision.** Pass or fail.

---

## Write your own project rules in 5 lines

A rule is just a glob + a check. Enforce any convention your team agrees on:

```ts
// rules/coverage.ts — every module needs a test
import { select, requireSibling } from 'gesetz';

export const everyFileNeedsTest = select('src/**/*.ts')
  .exclude('**/*.test.ts', '**/index.ts')
  .label('Every source file needs a test')
  .check(requireSibling('.test.ts'));
```

```ts
// rules/quality.ts — no console.log in production code
import { select, noConsoleLog, noGodFile } from 'gesetz';

export const noConsoleInProduction = select('src/**/*.ts')
  .exclude('**/*.test.ts')
  .label('No console.log in production code')
  .check(noConsoleLog());

export const noGiantFiles = select('src/**/*.{ts,tsx}')
  .label('Files should not exceed 400 lines')
  .check(noGodFile({ maxLines: 400 }));
```

```ts
// rules/migration.ts — ban imports from a deprecated module
import { select, noImportFrom } from 'gesetz';

export const noLegacyImports = select('src/**/*.{ts,tsx}')
  .label('Do not import from the legacy module')
  .check(
    noImportFrom('src/legacy', {
      message: 'This module is being phased out. Use src/lib/utils instead.',
    }),
  );
```

```ts
// rules/docs.ts — every package needs a README
import { select, requireChildren } from 'gesetz';

export const packageNeedsReadme = select('packages/*/')
  .label('Every package must have a README')
  .check(requireChildren(['README.md']));
```

Those are the basics. For deeper architectural control — import boundaries, call-shape validation, export pairs — you can add `@gesetz/typescript` and compose AST-level checks:

```ts
// rules/architecture.ts — feature boundaries
import { select, noImportFrom } from 'gesetz';
import { noCrossModuleImports } from '@gesetz/typescript';

// Feature A must not import internals from Feature B
export const featureIsolation = select('src/features/**/*.{ts,tsx}')
  .label('Features must not deep-import into other feature internals')
  .check(
    noCrossModuleImports({
      modulePattern: /src\/features\/([^/]+)\//,
      message: (from, to) =>
        `Feature '${from}' must not import directly into feature '${to}'. Use the public API.`,
    }),
  );

// UI components must only import from shared lib
export const uiOnlyUsesShared = select('src/components/**/*.tsx')
  .label('UI components must only import from shared utilities')
  .check(
    noImportFrom(/^~\/(?!components\/ui|lib\/)/, {
      message: 'UI components may only depend on other UI primitives and shared lib code.',
    }),
  );
```

```ts
// rules/api-conventions.ts — enforce internal API discipline
import { select } from 'gesetz';
import { requireCallShape, requireExportPairs } from '@gesetz/typescript';

// Every service call must include error handling
export const serviceErrorHandling = select('src/services/**/*.ts')
  .label('Service calls must pass an onError handler')
  .check(requireCallShape('apiCall', ['onError']));

// Related exports must be paired
export const exportPairs = select('src/hooks/**/*.ts')
  .label('Hooks must export useX and useCachedX as a pair')
  .check(
    requireExportPairs(name =>
      name.startsWith('use') ? `useCached${name.slice(3)}` : null,
    ),
  );
```

Wire everything into your config:

```ts
// gesetz.config.ts
import { defineConfig } from 'gesetz';
import { eslint } from '@gesetz/eslint';
import { vitest } from '@gesetz/vitest';
import * as coverage from './rules/coverage';
import * as quality from './rules/quality';
import * as migration from './rules/migration';
import * as docs from './rules/docs';
import * as architecture from './rules/architecture';

export default defineConfig({
  rules: [
    // Your custom rules
    coverage.everyFileNeedsTest,
    quality.noConsoleInProduction,
    quality.noGiantFiles,
    migration.noLegacyImports,
    docs.packageNeedsReadme,
    architecture.featureIsolation,
    architecture.uiOnlyUsesShared,

    // Your existing tools — now unified in the same report
    eslint({ pattern: 'src/**/*.{ts,tsx}' }),
    vitest({ pattern: 'src' }),
  ],
});
```

---

## Quick start

### 1. Install Gesetz and the adapters you need

```bash
# Core + CLI (lightweight — no heavy deps)
bun add -d gesetz

# Adapters for your stack (install only what you use)
bun add -d @gesetz/eslint @gesetz/vitest @gesetz/typescript
```

### 2. Initialize a config

```bash
gesetz init
```

This creates a `gesetz.config.ts` at your project root. In a TTY it runs an interactive wizard; in CI or agent mode it auto-detects your framework and installed tools.

### 3. Run checks

```bash
gesetz check
```

Output (TTY):

```
┌─────────────┬───────┬────────┬─────────┬─────────┐
│ Category    │ Score │ Errors │ Warns   │ Infos   │
├─────────────┼───────┼────────┼─────────┼─────────┤
│ strictness  │ 9.0   │ 0      │ 2       │ 0       │
│ structure   │ 7.5   │ 1      │ 5       │ 0       │
│ cleanup     │ 10.0  │ 0      │ 0       │ 0       │
└─────────────┴───────┴────────┴─────────┴─────────┘
✅ All categories above threshold
```

### 4. Agent / CI mode

```bash
# JSON output for agents
gesetz check --format=json

# GitHub Actions annotations
gesetz check --format=ci

# Only changed files since main
gesetz check --since main
```

---

## Core concepts

### `Rule`

A `Rule` is the top-level unit of work. It has an `id`, a `description`, a `category`, and a `run` function that returns `Effect.Effect<Violation[], never, …>`.

Rules are **self-contained** — they can spawn external processes, read files, or parse ASTs, but they never throw. Errors are absorbed into violations or warnings.

### `Check`

A `Check` is a per-file analysis function. It receives a `File` object (path, content, size, …) and returns violations for just that file.

### `select` — the rule builder

```ts
import { select, requireSibling, noConsoleLog } from 'gesetz';

const rule = select('src/**/*.tsx')
  .exclude('**/*.test.tsx', '**/*.stories.tsx')
  .label('All components need Storybook stories')
  .category('organization')
  .guidance({
    what: 'Components without a story file are invisible to design-system consumers.',
    do: 'Create a Foo.stories.tsx next to every component.',
    dont: 'Skip stories for "simple" components — they all evolve.',
  })
  .check(requireSibling('.stories.tsx'));
```

`select` creates a `Selector` that you chain:

| Method | Purpose |
|---|---|
| `.exclude(...globs)` | Remove matching files |
| `.include(...globs)` | Add more patterns |
| `.filter(fn)` | Custom predicate on `File` |
| `.label(string)` | Human description (auto-slugified to `rule.id`) |
| `.category(string)` | Scoring bucket |
| `.guidance({what,do,dont})` | Agent-facing docs for `gesetz list` / `gesetz skill` |
| `.check(...checks)` | Apply checks to every matched file |
| `.forEach(check)` | Sugar for a single check |

### `defineConfig`

```ts
import { defineConfig, select, requireSibling, noConsoleLog } from 'gesetz';
import { eslint } from '@gesetz/eslint';
import { vitest } from '@gesetz/vitest';
import { noHardcodedStrings } from '@gesetz/typescript';

export default defineConfig({
  projectRoot: '.',
  tsConfigPath: 'tsconfig.json',
  rules: [
    // --- Native checks (cross-cutting, language-agnostic) ---
    select('src/**/*.tsx')
      .label('Components need stories')
      .category('organization')
      .check(requireSibling('.stories.tsx')),

    select('src/**/*.ts')
      .label('No console.log in production')
      .category('cleanup')
      .check(noConsoleLog()),

    select('src/**/*.tsx')
      .label('No hardcoded user-facing strings')
      .category('strictness')
      .check(noHardcodedStrings()),

    // --- External tool adapters (language-specific) ---
    vitest({ pattern: 'src', label: 'Unit tests' }),
    eslint({ pattern: 'src/**/*.{ts,tsx}', label: 'ESLint' }),
  ],
  exemptions: [
    // Temporary waiver with expiry
    { path: 'src/legacy/**', reason: 'Migration in progress', until: '2026-08-01' },
  ],
  thresholds: [
    { category: 'strictness', minScore: 8 },
    { category: 'organization', minScore: 7 },
  ],
});
```

---

## CLI commands

### `gesetz check`

```bash
gesetz check                          # full scan
gesetz check --since HEAD~5           # only changed files
gesetz check --since main             # diff against a branch
gesetz check --category strictness    # run one category
gesetz check --format json            # JSON envelope (agents/CI)
gesetz check --format ci              # GitHub Actions annotations
gesetz check --threshold 8            # override all thresholds
gesetz check --files "src/components/**" # subset of files
gesetz check --project-root ./apps/web # monorepo workspace
```

### `gesetz list`

```bash
gesetz list                           # all rules with guidance
gesetz list --category strictness     # filter by category
gesetz list --format json             # JSON for agents
```

### `gesetz init`

```bash
gesetz init                           # interactive wizard
gesetz init --preset react            # explicit preset
gesetz init --preset laravel
gesetz init --no-interactive          # auto-detect + non-interactive
gesetz init --no-install              # scaffold only, no packages
gesetz init --no-qa-script            # skip adding a package.json script
gesetz init --force                   # overwrite existing config
```

### `gesetz skill`

```bash
gesetz skill > .agents/skills/gesetz/SKILL.md
```

Prints a markdown agent skill file you can pipe directly into your AI agent's skill directory.

---

## What belongs in Gesetz vs. your language tools

**Use Gesetz's built-in checks for:**

- File pairing and directory structure (every `Foo.tsx` needs a `Foo.stories.tsx`)
- Import discipline (no cross-domain imports, required imports)
- Cross-cutting patterns (no console logs, no empty catches, no magic numbers)
- Monorepo architecture (layer constraints, circular dependency detection)
- Security hygiene (hardcoded secrets, forbidden file patterns)

**Use adapters to wrap your existing tools for:**

- Deep type-level analysis (ESLint, PHPStan, oxlint)
- Test result mapping (Vitest, PHPUnit, Pest, bun:test)
- Format checking (Prettier, oxfmt)
- AST-level language rules (ts-morph JSX checks, tree-sitter PHP checks)

Gesetz's rule runner executes all of these concurrently and merges their violations into one report. You don't give up your tools — you just stop reading five different output formats.

---

## Built-in adapters

Each adapter is a standalone package. Install only the ones you use.

### TypeScript / JavaScript

| Package | Tool | What it does | Install |
|---|---|---|---|
| `@gesetz/typescript` | ts-morph | AST-level checks (export pairs, call shapes, JSX, i18n) | `bun add -d @gesetz/typescript` |
| `@gesetz/eslint` | ESLint | Runs ESLint programmatically, maps messages to violations | `bun add -d @gesetz/eslint` |
| `@gesetz/oxlint` | oxlint | Fast Rust linter — maps JSON diagnostics to violations | `bun add -d @gesetz/oxlint` |
| `@gesetz/oxfmt` | oxfmt | Format check — `--list-different` | `bun add -d @gesetz/oxfmt` |
| `@gesetz/prettier` | Prettier | Format check — `--list-different` | `bun add -d @gesetz/prettier` |
| `@gesetz/vitest` | Vitest | Runs tests with JSON reporter, maps failures to violations | `bun add -d @gesetz/vitest` |
| `@gesetz/bun-test` | bun:test | JUnit XML bridge via temp file | `bun add -d @gesetz/bun-test` |
| `@gesetz/storybook` | test-storybook | Jest JSON bridge for Storybook interaction tests | `bun add -d @gesetz/storybook` |
| `@gesetz/effect-ts` | ts-morph | Effect-TS anti-pattern detection | `bun add -d @gesetz/effect-ts` |
| `@gesetz/junit` | — | Shared JUnit XML parser (used by bun-test, Pest, PHPUnit) | `bun add -d @gesetz/junit` |

### PHP

| Package | Tool | What it does | Install |
|---|---|---|---|
| `@gesetz/phpstan` | PHPStan | Runs `analyse --error-format=json` | `bun add -d @gesetz/phpstan` |
| `@gesetz/phpunit` | PHPUnit | JUnit XML bridge | `bun add -d @gesetz/phpunit` |
| `@gesetz/pest` | Pest | JUnit XML bridge | `bun add -d @gesetz/pest` |
| `@gesetz/php` | tree-sitter-php | AST-level checks (strict types, PSR-4, raw queries) | `bun add -d @gesetz/php` |
| `@gesetz/laravel` | — | Laravel opinionated presets | `bun add -d @gesetz/laravel` |

### Usage example

```ts
import { defineConfig } from 'gesetz';
import { eslint } from '@gesetz/eslint';
import { vitest } from '@gesetz/vitest';
import { oxlint } from '@gesetz/oxlint';
import { prettier } from '@gesetz/prettier';
import { phpstan } from '@gesetz/phpstan';
import { phpunit } from '@gesetz/phpunit';

export default defineConfig({
  rules: [
    oxlint({ pattern: 'src/**/*.{ts,tsx}', label: 'oxlint' }),
    eslint({ pattern: 'src/**/*.{ts,tsx}', label: 'ESLint' }),
    prettier({ pattern: 'src', label: 'Prettier' }),
    vitest({ pattern: 'src', label: 'Vitest' }),
    phpstan({ label: 'PHPStan' }),
    phpunit({ label: 'PHPUnit' }),
  ],
});
```

---

## Core primitives

These checks live in `@gesetz/core` and work on **any file type** using text analysis or the file system. They are the tech-stack independent backbone of Gesetz.

### File-system checks

```ts
import { requireSibling, requireChildren, forbidFile, relativeImports } from 'gesetz';

// Every .tsx needs a .stories.tsx next to it
requireSibling('.stories.tsx')

// Every directory with an index.ts must also have types.ts
requireChildren(['types.ts', 'interface.ts'])

// Ban a file pattern entirely
forbidFile()

// Ensure relative imports resolve to real files
relativeImports()
```

### Import checks

```ts
import { noImportFrom, requireImportFrom } from 'gesetz';

// Components must not use @tanstack/react-query directly
noImportFrom('@tanstack/react-query', {
  message: 'Use SDK hooks instead',
})

// All test files must import vitest
requireImportFrom('vitest')
```

### Pattern checks

```ts
import { noPattern, requirePattern } from 'gesetz';

// No legacy helper calls
noPattern(/legacy_helper\(/, {
  message: 'Use the new helper() instead',
})

// All PHP files must declare strict types
requirePattern(/declare\(strict_types=1\)/, {
  message: 'Missing declare(strict_types=1)',
})
```

### Structure checks

```ts
import {
  noGodFile,
  noDeepNesting,
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  noDebuggingResidueFiles,
  noHardcodedSecret,
} from 'gesetz';

// Flag files over 300 lines
noGodFile({ maxLines: 300 })

// Flag indentation beyond 4 levels
noDeepNesting({ maxLevels: 4 })

// Ban console.log (allow warn/error)
noConsoleLog({ allowWarnError: true })

// Flag empty catch blocks
noEmptyCatch()

// Flag unexplained numeric literals
noMagicNumbers({ ignore: [0, 1, -1, 2] })

// Flag AI narration comments
noTrivialComment()

// Flag debug artefact filenames
noDebuggingResidueFiles()

// Detect hardcoded API keys / tokens
noHardcodedSecret()
```

### Dependency graph

```ts
import { noCycles } from 'gesetz';

// Detect circular imports using dependency-cruiser
noCycles('src/**/*.{ts,tsx}', { label: 'No circular dependencies' })
```

---

## TypeScript AST checks (`@gesetz/typescript`)

Install: `bun add -d @gesetz/typescript`

These use ts-morph for precise AST analysis. Only install this if you need AST-level TypeScript rules — for general linting, use the ESLint or oxlint adapters.

### Export discipline

```ts
import { requireExportPairs, requireExportFactories } from '@gesetz/typescript';

// Every useX hook must have a useSuspenseX counterpart
requireExportPairs(name =>
  name.startsWith('use') ? `useSuspense${name.slice(3)}` : null
)

// At least one export named *Keys must exist
requireExportFactories({ pattern: /Keys$/, minCount: 1 })
```

### Call-shape validation

```ts
import { requireCallShape } from '@gesetz/typescript';

// Every createUser() call must pass { name, email }
requireCallShape('createUser', ['name', 'email'])
```

### Function-call bans

```ts
import { noFunctionCalls } from '@gesetz/typescript';

// Ban direct fetch() calls — use the SDK
noFunctionCalls('fetch', {
  message: 'Use apiClient.request() instead of raw fetch',
})
```

### Import boundaries

```ts
import { requireImportBoundary } from '@gesetz/typescript';

// UI components must only import from ../lib or ../hooks
requireImportBoundary(
  source => source.startsWith('../lib') || source.startsWith('../hooks'),
  {
    message: 'UI components must only import from lib/ or hooks/',
    allowedPatterns: ['src/components/**'],
  }
)
```

### JSX / React checks

```ts
import {
  noLiteralJsxText,
  noLiteralJsxProp,
  noJsxElements,
  noLocalFunctionComponents,
} from '@gesetz/typescript';

// No raw text in JSX (enforce i18n)
noLiteralJsxText({ hasLetterRegex: /[A-Za-zÄÖÜäöüß]/ })

// Specific props must not use string literals
noLiteralJsxProp(['label', 'placeholder', 'title', 'aria-label'])

// Ban raw HTML elements in route components
noJsxElements(['div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'table'])

// No local helper function-components (only the main export)
noLocalFunctionComponents()
```

### i18n / hardcoded strings

```ts
import { noHardcodedStrings, DEFAULT_TEXT_ATTRIBUTES } from '@gesetz/typescript';

// Comprehensive: JSX text, string expressions, and known attributes
noHardcodedStrings({
  hasLetterRegex: /[A-Za-z]/,
  textAttributes: [...DEFAULT_TEXT_ATTRIBUTES, 'tooltip', 'hint'],
})
```

### Cross-module imports

```ts
import { noCrossModuleImports } from '@gesetz/typescript';

// Files in src/domains/X can't deep-import into src/domains/Y
noCrossModuleImports({
  modulePattern: /src\/domains\/([^/]+)/,
  allowedPattern: (mod) => [`src/domains/${mod}/`],
})
```

### Directory structure

```ts
import { requireDirectoryStructure } from '@gesetz/typescript';

// Every SDK sub-domain must have these files
requireDirectoryStructure(['interface.ts', 'http.ts', 'memory.ts', 'types.ts'])
```

### Test quality scoring

```ts
import { requireMinTestScore } from '@gesetz/typescript';

// Flag test files below a quality score
requireMinTestScore({
  minScore: 50,
  asyncBonus: 5,
  interactionBonus: 5,
  errorBonus: 5,
})
```

---

## Effect-TS checks (`@gesetz/effect-ts`)

Install: `bun add -d @gesetz/effect-ts`

Catches the four most common anti-patterns AI agents introduce in Effect-TS code.

```ts
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from '@gesetz/effect-ts';

export default defineConfig({
  rules: [
    select('src/**/*.ts')
      .exclude('src/main.ts', 'src/index.ts')
      .label('Effect.run* only at entry points')
      .category('effect-ts')
      .check(noRunPromiseScattered({ entryPoints: ['src/main.ts'] })),

    select('src/**/*.ts')
      .label('No throw inside Effect.gen')
      .category('effect-ts')
      .check(noThrowInEffectGen()),

    select('src/**/*.ts')
      .label('yield* (with star) inside Effect.gen')
      .category('effect-ts')
      .check(noYieldWithoutStar()),

    select('src/**/*.ts')
      .label('Effect.all must specify concurrency')
      .category('effect-ts')
      .check(noUnboundedEffectAll()),
  ],
});
```

---

## PHP checks (`@gesetz/php`)

Install: `bun add -d @gesetz/php`

```ts
import { strictTypes, psrNamespace, noInlineQueries } from '@gesetz/php';

// Every PHP file must declare strict_types=1
strictTypes()

// Namespace must match PSR-4 directory structure
psrNamespace({ baseNamespace: 'App', basePath: 'app' })

// Ban raw query patterns
noInlineQueries(['DB::statement', 'DB::raw', 'PDO::query'])
```

---

## Laravel presets (`@gesetz/laravel`)

Install: `bun add -d @gesetz/laravel`

Ready-made rules for standard Laravel projects.

```ts
import { allRules } from '@gesetz/laravel';
import { defineConfig } from 'gesetz';

export default defineConfig({
  rules: allRules,
});
```

Individual rules:

```ts
import {
  requireStrictTypes,
  requirePsrNamespaces,
  noRawDbQueries,
  noEnvOutsideConfig,
  noDebugHelpers,
  phpstan,
} from '@gesetz/laravel';
```

---

## Architecture rules

Define your monorepo layers in pure TypeScript and enforce import constraints.

```ts
import { defineConfig, defineArchitecture } from 'gesetz';

const arch = defineArchitecture({
  layers: [
    { name: 'entry',  pattern: 'src/cli/**',   canImportFrom: ['core', 'util'] },
    { name: 'core',   pattern: 'src/core/**',  canImportFrom: ['util'] },
    { name: 'util',   pattern: 'src/utils/**', canImportFrom: [] },
  ],
  forbidden: [
    { from: 'util', to: 'entry', message: 'Utilities must not import from entry points' },
  ],
  bannedExternals: {
    util: ['react', 'react-dom'],
  },
});

export default defineConfig({
  rules: [
    ...arch,
    // ...other rules
  ],
});
```

---

## Scoring & thresholds

Each category gets a score from **0 to 10**:

```
weighted = errors * 1.0 + warnings * 0.5 + infos * 0.1
score    = max(0, 10 - weighted)
```

A project **passes** when every category with rules is at or above its threshold. Default threshold is **7**.

```ts
// Custom thresholds
defineConfig({
  thresholds: [
    { category: 'strictness', minScore: 8 },
    { category: 'security',   minScore: 9 },
  ],
})
```

Override from CLI:

```bash
gesetz check --threshold 9
```

---

## Exemptions

Suppress violations with expiring waivers.

```ts
defineConfig({
  exemptions: [
    // Suppress all rules for legacy code
    { path: 'src/legacy/**', reason: 'Migration in progress', ticket: 'PROJ-123', until: '2026-08-01' },

    // Suppress only one rule for a specific file
    { path: 'src/generated/**', rule: 'no-god-file', reason: 'Auto-generated schemas are large by design' },
  ],
})
```

Expired exemptions automatically stop suppressing — violations surface again.

---

## Agent integration

Gesetz is designed for AI agents. Three features make it agent-native:

1. **`gesetz skill`** — outputs a markdown skill file for your agent framework (Claude Code, Cursor, Devin, etc.)
2. **`--format=json`** — structured output with per-rule guidance for automated fixing
3. **`--no-interactive`** — fully non-interactive init with auto-detection and JSON receipts

```bash
# Agent bootstrap
gesetz init --no-interactive --format=json

# Agent quality check
gesetz check --format=json --since HEAD
```

---

## Monorepo setup

Gesetz supports per-workspace configs. Run from the workspace root:

```bash
# packages/web/gesetz.config.ts
gesetz check --project-root packages/web

# Or from the repo root
gesetz check --project-root apps/api
```

---

## Packages

| Package | Description | When to install |
|---|---|---|
| `gesetz` | **Start here.** Core primitives, rule runner, `defineConfig`, `select`, `defineArchitecture`, and the CLI. No heavy dependencies. | Always |
| `@gesetz/cli` | `gesetz` command-line interface (included by `gesetz`) | — |
| `@gesetz/core` | Types, runner, primitives, file-system checks, pattern checks, architecture rules (included by `gesetz`) | — |
| `@gesetz/typescript` | ts-morph AST checks: export pairs, call shapes, JSX, i18n | TypeScript projects needing AST rules |
| `@gesetz/effect-ts` | Effect-TS anti-pattern detection | Effect-TS codebases |
| `@gesetz/eslint` | ESLint adapter | Any JS/TS project using ESLint |
| `@gesetz/oxlint` | oxlint adapter | Projects using oxlint |
| `@gesetz/oxfmt` | oxfmt adapter | Projects using oxfmt |
| `@gesetz/prettier` | Prettier adapter | Projects using Prettier |
| `@gesetz/vitest` | Vitest adapter | Projects using Vitest |
| `@gesetz/bun-test` | bun:test adapter | Projects using Bun tests |
| `@gesetz/storybook` | test-storybook adapter | Projects with Storybook |
| `@gesetz/junit` | Shared JUnit XML parser | Usually pulled in automatically by bun-test / PHPUnit / Pest |
| `@gesetz/phpstan` | PHPStan adapter | PHP projects |
| `@gesetz/phpunit` | PHPUnit adapter | PHP projects |
| `@gesetz/pest` | Pest adapter | PHP projects |
| `@gesetz/php` | PHP AST checks (tree-sitter-php) | PHP projects needing AST rules |
| `@gesetz/laravel` | Laravel opinionated presets | Laravel projects |

---

## Philosophy

- **One gate** — many tools, one report.
- **Wrap, don't replace** — ESLint knows JS better than we do. PHPStan knows PHP better than we do. Gesetz wraps them so you read one output.
- **Cross-cutting first** — Gesetz's built-in checks focus on file structure, import discipline, and conventions that span every language. Language-specific depth is delegated.
- **Never crash the build** — a broken rule produces a warning, not a fatal error.
- **Agent-native** — JSON output, skill files, guidance metadata.
- **TypeScript-first** — your config is typed, your architecture is typed, your rules are typed.
- **Deterministic** — no global state, no random IDs, no module-level counters. Same code, same score, every time.

---

## License

MIT
