# Regeln

> **Regeln** (German for "rules") — a unified code-quality gate that orchestrates linting, testing, static analysis, and AST checks into a single, category-scored report.

## Why Regeln exists

Most projects run **five or more separate tools** in CI: ESLint, Prettier, Vitest, TypeScript, phpstan, oxlint… Each emits its own format, its own exit codes, and its own noise. When a build fails you open five different outputs to figure out what went wrong.

Regeln wraps those tools — and adds its own native checks — into **one deterministic report** with a single score per category:

| Category | What it measures |
|---|---|
| **strictness** | Type safety, `any`, `as`, non-null assertions, Effect-TS patterns |
| **structure** | File size, nesting depth, magic numbers, empty catch blocks |
| **organization** | Monorepo health: circular deps, layer violations, import discipline |
| **cleanup** | Dead code, AI residue, console logs, trivial comments |
| **security** | Hardcoded secrets, raw SQL, unsafe innerHTML |
| **effect-ts** | `runPromise` scattered in library code, `throw` in `Effect.gen`, missing `yield*` |
| **react** | Hooks discipline, JSX keys, accessibility, data-fetching |

The goal is simple: **one command, one score, one decision.** Pass or fail.

---

## Quick start

### 1. Initialize a config

```bash
bun add -d regel
bun regel init
```

This creates a `regel.config.ts` at your project root. In a TTY it runs an interactive wizard; in CI or agent mode it auto-detects your framework and installed tools.

### 2. Run checks

```bash
bun regel check
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

### 3. Agent / CI mode

```bash
# JSON output for agents
bun regel check --format=json

# GitHub Actions annotations
bun regel check --format=ci

# Only changed files since main
bun regel check --since main
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
import { select, requireSibling, noConsoleLog } from 'regel';

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
| `.guidance({what,do,dont})` | Agent-facing docs for `regel list` / `regel skill` |
| `.check(...checks)` | Apply checks to every matched file |
| `.forEach(check)` | Sugar for a single check |

### `defineConfig`

```ts
import { defineConfig, select, requireSibling, noImportFrom, vitest, eslint, noHardcodedStrings } from 'regel';

export default defineConfig({
  projectRoot: '.',
  tsConfigPath: 'tsconfig.json',
  rules: [
    // --- Native checks ---
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

    // --- External tool adapters ---
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

### `regel check`

```bash
regel check                          # full scan
regel check --since HEAD~5           # only changed files
regel check --since main             # diff against a branch
regel check --category strictness    # run one category
regel check --format json            # JSON envelope (agents/CI)
regel check --format ci              # GitHub Actions annotations
regel check --threshold 8            # override all thresholds
regel check --files "src/components/**" # subset of files
regel check --project-root ./apps/web # monorepo workspace
```

### `regel list`

```bash
regel list                           # all rules with guidance
regel list --category strictness     # filter by category
regel list --format json             # JSON for agents
```

### `regel init`

```bash
regel init                           # interactive wizard
regel init --preset react            # explicit preset
regel init --preset laravel
regel init --no-interactive          # auto-detect + non-interactive
regel init --no-install              # scaffold only, no packages
regel init --no-qa-script            # skip adding a package.json script
regel init --force                   # overwrite existing config
```

### `regel skill`

```bash
regel skill > .agents/skills/regel/SKILL.md
```

Prints a markdown agent skill file you can pipe directly into your AI agent's skill directory.

---

## Built-in adapters

Regeln ships with adapters for the most common QA tools. Each adapter is a standalone package so you only install what you use.

### TypeScript / JavaScript

| Package | Tool | What it does |
|---|---|---|
| `@regeln/typescript` | ts-morph | AST-level checks (export pairs, call shapes, JSX, i18n) |
| `@regeln/eslint` | ESLint | Runs ESLint programmatically, maps messages to violations |
| `@regeln/oxlint` | oxlint | Fast Rust linter — maps JSON diagnostics to violations |
| `@regeln/oxfmt` | oxfmt | Format check — `--list-different` |
| `@regeln/prettier` | Prettier | Format check — `--list-different` |
| `@regeln/vitest` | Vitest | Runs tests with JSON reporter, maps failures to violations |
| `@regeln/bun-test` | bun:test | JUnit XML bridge via temp file |
| `@regeln/storybook` | test-storybook | Jest JSON bridge for Storybook interaction tests |
| `@regeln/effect-ts` | ts-morph | Effect-TS anti-pattern detection |
| `@regeln/junit` | — | Shared JUnit XML parser (used by bun-test, Pest, PHPUnit) |

### PHP

| Package | Tool | What it does |
|---|---|---|
| `@regeln/phpstan` | PHPStan | Runs `analyse --error-format=json` |
| `@regeln/phpunit` | PHPUnit | JUnit XML bridge |
| `@regeln/pest` | Pest | JUnit XML bridge |
| `@regeln/php` | tree-sitter-php | AST-level checks (strict types, PSR-4, raw queries) |
| `@regeln/laravel` | — | Laravel opinionated presets (strict types, no env outside config, no dd/dump) |

### Usage example

```ts
import { defineConfig, eslint, vitest, oxlint, prettier, phpstan, phpunit } from 'regel';

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

These checks live in `@regeln/core` and work on **any file type** using text analysis or the file system.

### File-system checks

```ts
import { requireSibling, requireChildren, forbidFile, relativeImports } from 'regel';

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
import { noImportFrom, requireImportFrom } from 'regel';

// Components must not use @tanstack/react-query directly
noImportFrom('@tanstack/react-query', {
  message: 'Use SDK hooks instead',
})

// All test files must import vitest
requireImportFrom('vitest')
```

### Pattern checks

```ts
import { noPattern, requirePattern } from 'regel';

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
} from 'regel';

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
import { noCycles } from 'regel';

// Detect circular imports using dependency-cruiser
noCycles('src/**/*.{ts,tsx}', { label: 'No circular dependencies' })
```

---

## TypeScript AST checks (`@regeln/typescript`)

These use ts-morph for precise AST analysis.

### Export discipline

```ts
import { requireExportPairs, requireExportFactories } from 'regel';

// Every useX hook must have a useSuspenseX counterpart
requireExportPairs(name =>
  name.startsWith('use') ? `useSuspense${name.slice(3)}` : null
)

// At least one export named *Keys must exist
requireExportFactories({ pattern: /Keys$/, minCount: 1 })
```

### Call-shape validation

```ts
import { requireCallShape } from 'regel';

// Every createUser() call must pass { name, email }
requireCallShape('createUser', ['name', 'email'])
```

### Function-call bans

```ts
import { noFunctionCalls } from 'regel';

// Ban direct fetch() calls — use the SDK
noFunctionCalls('fetch', {
  message: 'Use apiClient.request() instead of raw fetch',
})
```

### Import boundaries

```ts
import { requireImportBoundary } from 'regel';

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
} from 'regel';

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
import { noHardcodedStrings, DEFAULT_TEXT_ATTRIBUTES } from 'regel';

// Comprehensive: JSX text, string expressions, and known attributes
noHardcodedStrings({
  hasLetterRegex: /[A-Za-z]/,
  textAttributes: [...DEFAULT_TEXT_ATTRIBUTES, 'tooltip', 'hint'],
})
```

### Cross-module imports

```ts
import { noCrossModuleImports } from 'regel';

// Files in src/domains/X can't deep-import into src/domains/Y
noCrossModuleImports({
  modulePattern: /src\/domains\/([^/]+)/,
  allowedPattern: (mod) => [`src/domains/${mod}/`],
})
```

### Directory structure

```ts
import { requireDirectoryStructure } from 'regel';

// Every SDK sub-domain must have these files
requireDirectoryStructure(['interface.ts', 'http.ts', 'memory.ts', 'types.ts'])
```

### Test quality scoring

```ts
import { requireMinTestScore } from 'regel';

// Flag test files below a quality score
requireMinTestScore({
  minScore: 50,
  asyncBonus: 5,
  interactionBonus: 5,
  errorBonus: 5,
})
```

---

## Effect-TS checks (`@regeln/effect-ts`)

Catches the four most common anti-patterns AI agents introduce in Effect-TS code.

```ts
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from 'regel';

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

## PHP checks (`@regeln/php`)

```ts
import { strictTypes, psrNamespace, noInlineQueries } from 'regel';

// Every PHP file must declare strict_types=1
strictTypes()

// Namespace must match PSR-4 directory structure
psrNamespace({ baseNamespace: 'App', basePath: 'app' })

// Ban raw query patterns
noInlineQueries(['DB::statement', 'DB::raw', 'PDO::query'])
```

---

## Laravel presets (`@regeln/laravel`)

Ready-made rules for standard Laravel projects.

```ts
import { defineConfig, allRules } from 'regel';

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
} from 'regel';
```

---

## Architecture rules

Define your monorepo layers in pure TypeScript and enforce import constraints.

```ts
import { defineConfig, defineArchitecture } from 'regel';

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
regel check --threshold 9
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

Regeln is designed for AI agents. Three features make it agent-native:

1. **`regel skill`** — outputs a markdown skill file for your agent framework (Claude Code, Cursor, Devin, etc.)
2. **`--format=json`** — structured output with per-rule guidance for automated fixing
3. **`--no-interactive`** — fully non-interactive init with auto-detection and JSON receipts

```bash
# Agent bootstrap
regel init --no-interactive --format=json

# Agent quality check
regel check --format=json --since HEAD
```

---

## Monorepo setup

Regeln supports per-workspace configs. Run from the workspace root:

```bash
# packages/web/regel.config.ts
regel check --project-root packages/web

# Or from the repo root
regel check --project-root apps/api
```

---

## Packages

| Package | Description |
|---|---|
| `regel` | **The wrapper package — install this.** Re-exports core, TypeScript checks, Effect-TS checks, adapters, and the CLI |
| `@regeln/core` | Types, runner, primitives, `defineConfig`, `select`, `defineArchitecture` |
| `@regeln/cli` | `regel` command-line interface |
| `@regeln/typescript` | ts-morph AST checks |
| `@regeln/effect-ts` | Effect-TS anti-pattern checks |
| `@regeln/eslint` | ESLint adapter |
| `@regeln/oxlint` | oxlint adapter |
| `@regeln/oxfmt` | oxfmt adapter |
| `@regeln/prettier` | Prettier adapter |
| `@regeln/vitest` | Vitest adapter |
| `@regeln/bun-test` | bun:test adapter |
| `@regeln/storybook` | test-storybook adapter |
| `@regeln/junit` | Shared JUnit XML parser |
| `@regeln/phpstan` | PHPStan adapter |
| `@regeln/phpunit` | PHPUnit adapter |
| `@regeln/pest` | Pest adapter |
| `@regeln/php` | PHP AST checks (tree-sitter-php) |
| `@regeln/laravel` | Laravel opinionated presets |

---

## Philosophy

- **One gate** — many tools, one report.
- **Never crash the build** — a broken rule produces a warning, not a fatal error.
- **Agent-native** — JSON output, skill files, guidance metadata.
- **TypeScript-first** — your config is typed, your architecture is typed, your rules are typed.
- **Deterministic** — no global state, no random IDs, no module-level counters. Same code, same score, every time.

---

## License

MIT
