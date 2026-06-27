
<div>
  <img src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>⚖️</text></svg>" align="left" width="150">
</div>

# `gesetz`

**Gesetz** [*ɡəˈzɛts, German for "law"*] is a unified quality assurance gate that lets you write your own code-quality and architecture rules as easily as writing a config file in a language-agnostic way.

<br>

## Why Gesetz?

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

### `Violation` — the universal report format

Every rule, check, and adapter produces the same shaped object. This is what makes Gesetz "one command, one report":

```ts
interface Violation {
  /** Rule ID that produced this violation */
  rule: string;
  /** Human-readable message */
  message: string;
  /** Repository-relative file path */
  path: string;
  /** 1-based line number (optional) */
  line?: number;
  /** 1-based column number (optional) */
  column?: number;
  /** Severity: error, warn, or info */
  severity: 'error' | 'warn' | 'info';
  /** Optional code snippet or surrounding context */
  context?: string;
  /** Optional suggested fix string */
  fix?: string;
  /** Source of the violation: core, eslint, phpstan, oxlint, custom, … */
  source: 'core' | 'eslint' | 'phpstan' | 'oxlint' | 'custom';
}
```

### `Check` — a single-file analysis

A `Check` receives a `File` object and returns `Effect.Effect<Violation[], never, …>`. It never throws — errors become violations or empty arrays.

```ts
import { Effect } from 'effect';
import type { Check, File, Violation } from 'gesetz';

// A check that forbids TODO comments in production files
const noTodoComments: Check = (file) =>
  Effect.sync(() => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');

    lines.forEach((line, index) => {
      if (/TODO\s*\(urgent\)/i.test(line)) {
        violations.push({
          rule: '',           // filled in by the rule runner
          source: 'custom',
          severity: 'error',
          path: file.path,
          line: index + 1,
          message: `Urgent TODO found: "${line.trim()}"`,
        });
      }
    });

    return violations;
  });

// Use it with select
import { select } from 'gesetz';

export const noUrgentTodos = select('src/**/*.ts')
  .label('No urgent TODOs in production')
  .category('cleanup')
  .check(noTodoComments);
```

A `File` gives you everything you need for text-based analysis:

```ts
interface File {
  path: string;        // e.g. "src/components/Foo.tsx"
  absolutePath: string;  // e.g. "/repo/src/components/Foo.tsx"
  name: string;          // "Foo.tsx"
  stem: string;          // "Foo"
  ext: string;           // ".tsx"
  dir: string;           // "src/components"
  content: string;       // full UTF-8 content
  size: number;          // bytes
  mtimeMs: number;       // last modified timestamp
}
```

### `Rule` — the top-level unit of work

A `Rule` has an `id`, `description`, `category`, and a `run` function that returns `Effect.Effect<Violation[], never, …>`. Rules are self-contained — they can spawn external processes, read files, or parse ASTs, but they never throw. Errors are absorbed into violations or warnings.

**Using `select` (recommended)** — most rules are built by chaining `select()`:

```ts
import { select, requireSibling, noPattern } from 'gesetz';

export const everyComponentNeedsStory = select('src/**/*.tsx')
  .exclude('**/*.test.tsx')
  .label('Every component needs a Storybook story')
  .category('organization')
  .check(requireSibling('.stories.tsx'));
```

**Writing a raw rule** — when you need full control (e.g., running an external tool, scanning the whole project at once):

```ts
import { Effect } from 'effect';
import { FileSystem, ProjectRoot } from 'gesetz';
import type { Rule, Violation } from 'gesetz';

export const noSecretsInEnv: Rule = {
  id: 'no-secrets-in-env',
  description: 'Repo .env files must not contain hardcoded secrets',
  category: 'security',
  run: Effect.gen(function* () {
    const fs = yield* FileSystem;
    const root = yield* ProjectRoot;

    const envFiles = yield* fs.glob(['**/.env', '**/.env.local'], { cwd: root });
    const violations: Violation[] = [];

    for (const file of envFiles) {
      if (/API_KEY\s*=\s*["']?[a-zA-Z0-9]{32}["']?/m.test(file.content)) {
        violations.push({
          rule: 'no-secrets-in-env',
          source: 'custom',
          severity: 'error',
          path: file.path,
          message: 'Possible hardcoded API key in .env file',
        });
      }
    }

    return violations;
  }),
};
```

### Consuming the output

**In the CLI** — structured JSON for agents and CI:

```bash
# JSON envelope with every violation, rule result, and category score
$ gesetz check --format=json

# Key fields:
# {
#   "byRule": [
#     { "ruleId": "no-console-in-production", "violations": [...] }
#   ],
#   "byCategory": [
#     { "category": "cleanup", "score": 9.5, "errors": 0, "warnings": 1, "passing": true }
#   ],
#   "passing": true
# }
```

**Programmatically** — import `runAll` and pipe the result:

```ts
import { Effect, Layer } from 'effect';
import { runAll, FileSystemLive, ProjectRootLive } from 'gesetz';
import { defineConfig } from 'gesetz';

const config = defineConfig({
  projectRoot: '.',
  rules: [/* your rules */],
});

const program = Effect.gen(function* () {
  const result = yield* runAll(config, { changedSince: undefined });

  // result.byRule   — per-rule violation lists
  // result.byCategory — scored categories
  // result.passing  — boolean gate

  for (const cat of result.byCategory) {
    console.log(`${cat.category}: ${cat.score}/10 (${cat.errors} errors, ${cat.warnings} warnings)`);
  }

  return result.passing;
}).pipe(
  Effect.provide(Layer.merge(FileSystemLive, ProjectRootLive('.'))),
);

Effect.runPromise(program);
```

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

These checks live in `@gesetz/core` and work on **any file type** using text analysis or the file system. No AST, no type-checker, no language-specific parser. This is what makes them fast and universal.

### File-system checks

#### `requireSibling(suffix, opts?)`

Checks that a sibling file with the given suffix exists next to every matched file. Uses the file system to verify presence.

- **`suffix`** — appended to the matched file's stem. `Foo.tsx` + `.test.ts` → looks for `Foo.test.ts`.
- **`opts.message`** — custom violation message. Default: `"Missing sibling file: Foo.test.ts"`.
- **`opts.severity`** — `"error"` | `"warn"` | `"info"`. Default: `"error"`.

```ts
requireSibling('.test.ts')
requireSibling('.stories.tsx', { message: 'Components need a story file' })
```

#### `requireChildren(requiredPaths, opts?)`

Checks that the directory containing each matched file also contains every file in the list. Good for enforcing directory conventions.

- **`requiredPaths`** — array of filenames that must exist in the same directory.
- **`opts.message(missing)` — callback receiving the missing filename. Default: `"Missing required file: types.ts"`.

```ts
requireChildren(['types.ts', 'interface.ts'])
requireChildren(['README.md'], { message: (m) => `Package missing ${m}` })
```

#### `forbidFile(opts?)`

Marks every matched file as a violation. Use with `select(...)` targeting files that should not exist.

- **`opts.message`** — custom message. Default: `"File should not exist: src/legacy/old.ts"`.
- **`opts.severity`** — default: `"error"`.

```ts
select('src/legacy/**/*').check(forbidFile({
  message: 'Legacy files are being phased out',
}))
```

#### `relativeImports(opts?)`

Checks that every relative `import … from './foo'` in the file resolves to an existing file. Recognizes `.ts`, `.tsx`, `/index.ts`, and `/index.tsx` resolution.

- **`opts.message(imp)`** — callback receiving the unresolved import path. Default: `"Relative import './foo' does not resolve to an existing file"`.

```ts
relativeImports()
relativeImports({ message: (imp) => `Broken import: ${imp}` })
```

---

### Import checks

#### `noImportFrom(module, opts?)`

Checks that the file does not import from a given module. Matches static imports, dynamic imports, and `require()`.

- **`module`** — string (exact match or prefix match with `/`) or `RegExp`.
- **`opts.message`** — custom message. Default: `"Forbidden import from 'foo'"`.
- **`opts.severity`** — default: `"error"`.

```ts
noImportFrom('lodash')
noImportFrom('@tanstack/react-query', { message: 'Use SDK hooks instead' })
noImportFrom(/^~\/legacy\//, { severity: 'warn' })
```

#### `requireImportFrom(module, opts?)`

Opposite of `noImportFrom` — checks that the file imports from the given module at least once.

- **`module`** — string or `RegExp`. Same matching rules as `noImportFrom`.
- **`opts.message`** — custom message. Default: `"Missing required import from 'foo'"`.
- **`opts.severity`** — default: `"error"`.

```ts
requireImportFrom('vitest')
requireImportFrom(/^~\/lib\/utils/, { message: 'Utils must be imported from lib/utils' })
```

---

### Pattern checks

#### `noPattern(regex, opts?)`

Checks that the file does not contain a regex match.

- **`regex`** — the forbidden pattern.
- **`opts.fullFile`** — when `true`, matches against the entire file as one string. When `false` (default), matches line-by-line and reports the line number.
- **`opts.message`** — custom message. Default: `"Forbidden pattern: <regex source>"`.
- **`opts.severity`** — default: `"error"`.

```ts
noPattern(/debugger;/)
noPattern(/legacy_helper\(/, { message: 'Use the new helper() instead' })
noPattern(/TODO\(urgent\)/, { fullFile: true, severity: 'warn' })
```

#### `requirePattern(regex, opts?)`

Opposite of `noPattern` — checks that the file contains the pattern at least once.

- **`regex`** — the required pattern.
- **`opts.message`** — custom message. Default: `"File must match pattern: <regex source>"`.
- **`opts.severity`** — default: `"error"`.

```ts
requirePattern(/declare\(strict_types=1\)/)
requirePattern(/use strict;/, { message: 'Missing use strict directive' })
```

---

### Structure checks

All structure checks use simple text analysis (regex + line splitting). They work on any language.

#### `noGodFile(opts?)`

Flags files that exceed a line-count threshold.

- **`opts.maxLines`** — default: `400`.
- **`opts.message`** — custom message. Default: `"File has 523 lines (max: 400). Split into smaller modules."`.
- Severity is always `"warn"`.

```ts
noGodFile()
noGodFile({ maxLines: 300 })
```

#### `noDeepNesting(opts?)`

Flags lines whose indentation exceeds a threshold, using a heuristic for brace/control-flow nesting. Counts leading spaces (2-space indent) or tabs.

- **`opts.maxLevels`** — default: `4`.
- **`opts.message`** — custom message. Default: `"Nesting level 6 exceeds maximum (4)"`.
- Severity is always `"warn"`. Capped at 10 violations per file to avoid noise.

```ts
noDeepNesting()
noDeepNesting({ maxLevels: 3 })
```

#### `noConsoleLog(opts?)`

Bans `console.log` and friends in production files. Line-by-line regex scan.

- **`opts.allowWarnError`** — when `true`, only bans `console.log`, `console.debug`, and `console.info`. `console.warn` and `console.error` are allowed. Default: `false` (ban everything).
- **`opts.message`** — custom message. Default: `"Remove console logging from production code"`.
- Severity is always `"warn"`.

```ts
noConsoleLog()
noConsoleLog({ allowWarnError: true })
```

#### `noEmptyCatch(opts?)`

Flags empty or comment-only catch blocks that swallow errors. Checks the 3 lines after `catch {` for real content.

- **`opts.message`** — custom message. Default: `"Empty catch block swallows errors"`.
- Severity is always `"error"`.

```ts
noEmptyCatch()
```

#### `noMagicNumbers(opts?)`

Flags unexplained numeric literals in non-constant positions. Skips lines that declare `const UPPER_SNAKE = N` and skips comment lines.

- **`opts.ignore`** — array of numbers that are always allowed. Default: `[0, 1, -1, 2, 100]`.
- **`opts.message`** — custom message. Default: `"Magic number 42. Extract to a named constant"`.
- Severity is always `"warn"`. Capped at 20 violations per file.

```ts
noMagicNumbers()
noMagicNumbers({ ignore: [0, 1, 2, 10, 100, 1000] })
```

#### `noTrivialComment(opts?)`

Flags AI-generated narration comments (`// Import React`, `// Define the component`) and decorative dividers (`// ======`).

- **`opts.message`** — custom message. Default: `"Trivial or narrative comment"`.
- Severity is always `"info"`.

```ts
noTrivialComment()
```

#### `noDebuggingResidueFiles(opts?)`

Flags files whose names look like debugging artefacts: `*_v2.ts`, `*_backup.ts`, `*_fixed.ts`, `*_copy.ts`, `*_old.ts`, `*_new.ts`, `*_temp.ts`, `*_wip.ts`, `*_draft.ts`, `*delete_me*`.

- **`opts.extraPatterns`** — additional `RegExp[]` to apply after built-in patterns.
- **`opts.message`** — custom message. Default: `"File name looks like a debugging artefact"`.
- Severity is always `"error"`.

```ts
noDebuggingResidueFiles()
noDebuggingResidueFiles({ extraPatterns: [/\_draft\./i] })
```

#### `noHardcodedSecret(opts?)`

Detects common hardcoded secret patterns: `api_key = "…"`, `token: "…"`, `password = "…"`, `bearer "…"`, etc. Uses a regex heuristic — not a replacement for proper secret scanning (GitLeaks, TruffleHog).

- **`opts.message`** — custom message. Default: `"Possible hardcoded secret detected"`.
- Severity is always `"error"`.

```ts
noHardcodedSecret()
```

---

### Dependency graph

#### `noCycles(pattern, opts?)`

Detects circular dependencies using `dependency-cruiser` (optional peer dependency). If `dependency-cruiser` is not installed, the rule logs a warning and produces no violations — it does not break the build.

- **`pattern`** — glob or array of globs to analyse. Passed to dependency-cruiser.
- **`opts.label`** — human description. Default: `"No circular dependencies"`.
- **`opts.id`** — rule ID override. Default: `"no-cycles"`.
- **`opts.cwd`** — working directory. Default: `process.cwd()`.
- **`opts.tsConfigPath`** — path to `tsconfig.json` for TypeScript resolution.

```ts
noCycles('src/**/*.{ts,tsx}')
noCycles(['src/**/*.ts', 'apps/**/*.ts'], { tsConfigPath: 'tsconfig.json' })
```

---

## TypeScript AST checks (`@gesetz/typescript`)

Install: `bun add -d @gesetz/typescript`

These use ts-morph for precise AST analysis. They parse each file into a real TypeScript AST, so they can reason about exports, function calls, JSX elements, and object shapes. Only install this if you need AST-level TypeScript rules — for general linting, use the ESLint or oxlint adapters.

### Export discipline

#### `requireExportPairs(getCounterpart, opts?)`

Scans every exported identifier in the file. For each export whose name passes your `getCounterpart` callback, checks that the returned counterpart name is also exported from the same file. Return `null` to skip an export.

- **`getCounterpart(name)`** — callback receiving each export name. Return the expected counterpart name, or `null` to skip.
- **`opts.tsConfigPath`** — path to `tsconfig.json` for ts-morph project context.
- **`opts.message(name, counterpart)`** — custom message callback.

```ts
// Every useX hook must have a useSuspenseX counterpart
requireExportPairs(name =>
  name.startsWith('use') && !name.startsWith('useSuspense')
    ? `useSuspense${name.slice(3)}`
    : null
)

// Every action type must have a matching reducer
requireExportPairs(
  name => name.endsWith('Action') ? `${name.slice(0, -6)}Reducer` : null,
  { message: (a, b) => `Action ${a} needs matching reducer ${b}` }
)
```

#### `requireExportFactories(opts)`

Checks that the file exports at least `minCount` identifiers whose names match the given pattern.

- **`opts.pattern`** — `RegExp` that export names must match.
- **`opts.minCount`** — minimum number of matching exports. Default: `1`.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message`** — custom message. Default: `"Expected at least 1 export(s) matching /Keys$/, found 0"`.

```ts
// At least one export named *Keys must exist
requireExportFactories({ pattern: /Keys$/, minCount: 1 })
```

---

### Call-shape validation

#### `requireCallShape(fnName, requiredKeys, opts?)`

Finds every call to `fnName()` in the file and checks that the first object-literal argument contains all `requiredKeys`.

- **`fnName`** — the function name to look for.
- **`requiredKeys`** — array of property names that must be present in the object argument.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message(missing)`** — callback receiving the array of missing keys.

```ts
// Every createUser() call must pass { name, email }
requireCallShape('createUser', ['name', 'email'])

// Every mutation must implement the full lifecycle
requireCallShape('useMutation', ['onMutate', 'onError', 'onSettled'])
```

---

### Function-call bans

#### `noFunctionCalls(callNames, opts?)`

Checks that none of the listed function names are called in the file. Uses the ts-morph AST, so it catches direct calls (`useQuery(...)`) but not property-access calls (`obj.useQuery(...)`).

- **`callNames`** — array of function names to ban.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message(name)`** — callback receiving the matched function name.

```ts
// Ban direct fetch() calls — use the SDK
noFunctionCalls(['fetch'])

// Ban useSuspenseQuery in mutation hooks
noFunctionCalls(['useSuspenseQuery'], {
  message: (name) => `Mutations must not call ${name}()`,
})
```

---

### Import boundaries

#### `requireImportBoundary(opts)`

Checks that imports matching `source` are only allowed in files matching `allowedIn`. Violations are reported in the *importing* file.

- **`opts.source`** — string or `RegExp` matching the module specifier (the `from '…'` part).
- **`opts.allowedIn`** — glob or array of globs describing which files are allowed to import the source.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message`** — custom message. Default: `"Import from 'foo' is not allowed outside of 'src/sdk/**'"`.

```ts
// Generated types can only be imported inside src/sdk/
requireImportBoundary({
  source: /types\.gen/,
  allowedIn: 'src/sdk/**',
})

// Internal utilities must not leak outside components/
requireImportBoundary({
  source: '~components/internal',
  allowedIn: 'src/components/**',
  message: 'Internal utilities must not leak outside the component layer',
})
```

---

### JSX / React checks

#### `noLiteralJsxText(opts?)`

Flags JSX text nodes that contain letters (e.g. `<div>Hello world</div>`). Use this to enforce i18n.

- **`opts.hasLetterRegex`** — regex to detect user-facing text. Default: `/[A-Za-zÄÖÜäöüß]/`.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message`** — custom message. Default: `"Raw text in JSX is not allowed — use a translation API"`.

```ts
noLiteralJsxText()
noLiteralJsxText({ hasLetterRegex: /[A-Za-z]/ })
```

#### `noLiteralJsxProp(translatableProps, opts?)`

Flags JSX attributes whose names are in `translatableProps` and whose values are string literals.

- **`translatableProps`** — array of attribute names to check (e.g. `['label', 'placeholder']`).
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message(propName)`** — callback receiving the prop name.

```ts
noLiteralJsxProp(['label', 'placeholder', 'title', 'aria-label'])
```

#### `noJsxElements(elements, opts?)`

Flags JSX elements with the given tag names.

- **`elements`** — array of forbidden tag names (e.g. `['div', 'span']`).
- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message(tagName)`** — callback receiving the matched tag.

```ts
// Route components must not render raw HTML elements
noJsxElements(['div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'table'])
```

#### `noLocalFunctionComponents(opts?)`

Flags non-exported function declarations that contain JSX — i.e. local helper components defined inside a file.

- **`opts.tsConfigPath`** — path to `tsconfig.json`.
- **`opts.message(name)`** — callback receiving the function name.
- **`opts.excludeExportedNames`** — when `true`, only flag non-exported components. Default: `false`.

```ts
noLocalFunctionComponents()
noLocalFunctionComponents({ excludeExportedNames: true })
```

---

### i18n / hardcoded strings

#### `noHardcodedStrings(opts?)`

The comprehensive i18n check. Flags three cases in one pass:

1. **JSX text nodes** — `<div>Hello world</div>`
2. **String literals in JSX expressions** — `<div>{"Hello world"}</div>`
3. **Known text-bearing attributes** — `<input placeholder="Search" />`

- **`opts.textAttributes`** — array of attribute names to check. Default: `DEFAULT_TEXT_ATTRIBUTES` (35 common attributes like `label`, `placeholder`, `title`, `alt`, `aria-label`, etc.).
- **`opts.attributeSeverity`** — severity for attribute violations. Default: `"warn"` (attributes are edge-case-prone; warnings avoid false positives on `alt="logo"`).
- **`opts.textSeverity`** — severity for text-node and expression violations. Default: `"error"`.
- **`opts.hasLetterRegex`** — regex to detect user-facing text. Default: `/[A-Za-zÄÖÜäöüßÀ-ÿ]/`.
- **`opts.tsConfigPath`** — path to `tsconfig.json`.

```ts
noHardcodedStrings()                               // defaults
noHardcodedStrings({ attributeSeverity: 'error' }) // strict
noHardcodedStrings({ textAttributes: ['label', 'placeholder'] })
```

Export `DEFAULT_TEXT_ATTRIBUTES` to see the full built-in list.

---

### Cross-module imports

#### `noCrossModuleImports(opts)`

Text-based (not AST-based) check. Extracts import specifiers with a regex and checks that files within a module do not import from other modules' internals.

- **`opts.modulePattern`** — `RegExp` with a capture group that extracts the module name from the file path. Must have exactly one capture group.
- **`opts.allowedPattern(module)`** — callback receiving the current module name. Return an array of path prefixes that are allowed to import from.
- **`opts.message(from, to)`** — callback receiving the source and target module names.

```ts
// Files in src/features/X can't deep-import into src/features/Y
noCrossModuleImports({
  modulePattern: /src\/features\/([^/]+)\//,
  allowedPattern: (mod) => [`src/features/${mod}/`],
  message: (from, to) =>
    `Feature '${from}' must not import directly into feature '${to}'. Use the public API.`,
})
```

---

### Object property checks

#### `noObjectProperty(varName, propName, opts?)`

Text-based check. Finds `const varName = { … }` and checks that the object does not define `propName`. Uses brace-counting to navigate nested objects.

- **`varName`** — the variable name to look for.
- **`propName`** — the property name that must not exist.
- **`opts.message`** — custom message. Default: `"'meta' object must not define property 'title'"`.

```ts
// Storybook meta objects must not define an explicit title
noObjectProperty('meta', 'title')
```

---

### Directory structure

#### `requireDirectoryStructure(requiredFiles)`

Exactly `requireChildren` from `@gesetz/core` — re-exported here for discoverability. Checks that the directory containing each matched file also contains every file in the list.

```ts
requireDirectoryStructure(['interface.ts', 'http.ts', 'memory.ts', 'types.ts'])
```

---

### Test quality scoring

#### `requireMinTestScore(scoring)`

Scores a test file based on quality signals and returns a violation if the score is below `minScore`. Uses text analysis (string counting), not AST.

**Scoring formula:**
- Base score: `40` (for having any tests)
- +`assertionBonus` for each assertion threshold crossed
- +`testCountBonus` for each test-count threshold crossed
- +`asyncBonus` if async indicators are found
- +`interactionBonus` if interaction methods are found
- +`errorBonus` if error-path indicators are found
- +`varietyBonus` if ≥3 different assertion types are used
- +`trivialPenalty` if only trivial assertions are found

Parameters (all optional except `minScore`):

| Parameter | Default | Description |
|---|---|---|
| `minScore` | *required* | Minimum score to pass |
| `assertionThresholds` | `[1, 3, 5, 8]` | Assertion-count milestones |
| `assertionBonus` | `5` | Points per milestone crossed |
| `testCountThresholds` | `[2, 4, 6]` | Test-count milestones |
| `testCountBonus` | `5` | Points per milestone crossed |
| `assertionNames` | `['expect(']` | Strings counted as assertions |
| `trivialAssertions` | `['toBeTrue(', 'toBeTruthy(', 'toBeDefined(']` | Patterns that penalise trivial tests |
| `trivialPenalty` | `-20` | Penalty for trivial-only tests |
| `asyncIndicators` | `['waitFor(', 'act(']` | Strings that signal async tests |
| `interactionMethods` | `['userEvent.', 'fireEvent.']` | Strings that signal interaction tests |
| `errorIndicators` | `['.toThrow(', '.rejects.', 'toThrow(']` | Strings that signal error-path tests |
| `asyncBonus` | `5` | Bonus for async tests |
| `interactionBonus` | `5` | Bonus for interaction tests |
| `errorBonus` | `5` | Bonus for error-path tests |
| `varietyBonus` | `5` | Bonus for varied assertion types |

```ts
requireMinTestScore({ minScore: 50 })
requireMinTestScore({
  minScore: 60,
  assertionThresholds: [1, 5, 10],
  assertionBonus: 10,
  trivialPenalty: -30,
})
```

---

## Effect-TS checks (`@gesetz/effect-ts`)

Install: `bun add -d @gesetz/effect-ts`

Catches the four most common anti-patterns AI agents introduce in Effect-TS code. All four use ts-morph AST analysis.

#### `noRunPromiseScattered(opts?)`

Flags `Effect.runPromise`, `runSync`, `runFork`, `runCallback`, and `runPromiseExit` calls outside designated entry-point files. These methods should only be called at your program's boundary (`main.ts` / `index.ts`).

- **`opts.entryPoints`** — array of file paths (or suffixes) that are allowed to call `Effect.run*`. Default: `[]` (no files allowed).
- **`opts.tsConfigPath`** — default: `'tsconfig.json'`.
- **`opts.message`** — custom message. Default: `"Effect.runPromise() should only be called at program entry points"`.

```ts
noRunPromiseScattered()
noRunPromiseScattered({ entryPoints: ['src/main.ts', 'src/index.ts'] })
```

#### `noThrowInEffectGen(opts?)`

Flags `throw` statements inside `Effect.gen()`, `Effect.fn()`, and `Effect.fnUntraced()` bodies. `throw` converts typed failures into untyped Defects.

- **`opts.tsConfigPath`** — default: `'tsconfig.json'`.
- **`opts.message`** — custom message. Default: `"`throw` inside Effect.gen() creates an untyped Defect"`.

```ts
noThrowInEffectGen()
```

#### `noYieldWithoutStar(opts?)`

Flags plain `yield expr` (no asterisk) inside Effect generators. `yield` returns the raw channel output; `yield*` unwraps the Effect's value.

- **`opts.tsConfigPath`** — default: `'tsconfig.json'`.
- **`opts.message`** — custom message. Default: `"`yield` inside Effect.gen() does not unwrap the Effect. Write `yield*` instead"`.

```ts
noYieldWithoutStar()
```

#### `noUnboundedEffectAll(opts?)`

Flags `Effect.all([...])` calls with fewer than 2 arguments — meaning no `concurrency` option was passed. Effect.all defaults to sequential execution when concurrency is unspecified.

- **`opts.tsConfigPath`** — default: `'tsconfig.json'`.
- **`opts.message`** — custom message. Default: `"Effect.all() is missing a concurrency option"`.

```ts
noUnboundedEffectAll()
```

---

## PHP checks (`@gesetz/php`)

Install: `bun add -d @gesetz/php`

These are text-based checks (regex over file content) that work on any PHP file. No tree-sitter required unless you need the AST-level `@gesetz/php` adapter for deeper analysis.

#### `strictTypes(opts?)`

Checks that the file contains `declare(strict_types=1)`.

- **`opts.message`** — custom message. Default: `"Missing declare(strict_types=1)"`.

```ts
strictTypes()
```

#### `psrNamespace(opts)`

Extracts the `namespace …;` declaration from the file and compares it to the expected PSR-4 namespace derived from the file path.

- **`opts.baseNamespace`** — the root namespace (e.g. `'App'`).
- **`opts.basePath`** — the directory that maps to `baseNamespace` (e.g. `'app'`).
- **`opts.message`** — custom message. Default: `"Namespace 'App\Foo' does not match expected 'App\Foo\Bar'"`.

Files outside `basePath` are silently skipped.

```ts
psrNamespace({ baseNamespace: 'App', basePath: 'app' })
psrNamespace({ baseNamespace: 'Acme', basePath: 'src' })
```

#### `noInlineQueries(patterns, opts?)`

Line-by-line text scan. Flags any line that contains one of the provided call patterns.

- **`patterns`** — array of strings to search for in each line (e.g. `['DB::raw', 'DB::statement']`).
- **`opts.message`** — custom message. Default: `"Forbidden call pattern: DB::raw"`.
- **`opts.severity`** — default: `"error"`.

```ts
// Laravel: ban raw DB queries
noInlineQueries(['DB::raw', 'DB::statement', 'DB::unprepared'])

// WordPress: ban raw wpdb queries
noInlineQueries(['$wpdb->query', '$wpdb->get_results'])

// Generic PHP: ban raw PDO/mysqli
noInlineQueries(['PDO::query', 'mysqli_query'])
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

#### `defineArchitecture(config)`

Defines monorepo layers as file-glob patterns and enforces import constraints between them. Returns a `Rule[]` ready to pass to `defineConfig({ rules: [...] })`.

**How it works:**
1. Scans all files matching all layer patterns.
2. Builds a map: `filePath → layerName` using micromatch.
3. Extracts imports from each file using regex (static imports, `require()`, dynamic `import()`).
4. For each import:
   - If it's an **external npm package**, checks `bannedExternals` for the source layer.
   - If it's a **relative import**, resolves it to a target file, looks up the target's layer, then checks:
     - `canImportFrom` allowlist (if the source layer has one)
     - `forbidden` explicit denials

**`config.layers`** — array of layers. Each layer:

| Property | Type | Description |
|---|---|---|
| `name` | `string` | Layer identifier used in messages and cross-references |
| `pattern` | `string \| string[]` | Glob(s) matching files that belong to this layer |
| `canImportFrom` | `string[] \| undefined` | Layers this layer is allowed to import from. Omit to allow all. |

**`config.forbidden`** — array of explicit denials beyond `canImportFrom`:

| Property | Type | Description |
|---|---|---|
| `from` | `string` | Source layer name |
| `to` | `string` | Target layer name |
| `message` | `string \| undefined` | Custom violation message |

**`config.bannedExternals`** — `Record<layerName, packageName[]>`:

Prevents specific layers from importing specific npm packages. Supports scoped packages (`@org/pkg`).

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

export default defineConfig({ rules: [...arch] });
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
