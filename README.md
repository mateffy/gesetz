
<div>
  <img src="./resources/icon.svg" align="left" width="175">
</div>

# `gesetz`

**Gesetz** [*ɡəˈzɛts, German for "law"*] is a unified quality assurance gate that lets you write your own code-quality and architecture rules as easily as writing a config file — and runs them alongside your existing linters and test runners in a single, scored report.

<br>

## Why Gesetz?

Every codebase has conventions that no generic linter knows about:

- *"Every module in `src/` must have a `README.md`"*
- *"No file should exceed 400 lines"*
- *"No one should import from `src/legacy/` — we're migrating away"*
- *"Every API endpoint file needs a sibling `.test.ts`"*
- *"Console logs left in production code break our log pipeline"*
- *"Feature A must not import internals from Feature B"*

ESLint, PHPStan, and Vitest are excellent at what they do. But they don't know *your* architecture. Gesetz bridges that gap: **you write project-specific rules in plain TypeScript, and Gesetz runs them alongside your existing tools in one unified `Violation` format, one category score, one CLI.**

**Gesetz does not replace your linters.** It wraps them. You still run ESLint, Vitest, PHPStan — but their output and your custom rules all feed into the same report. Because the rule engine is polyglot, the same `gesetz check` covers your TypeScript frontend, your PHP backend, and whatever else lives in the repo.

| Category | What it measures |
|---|---|
| **strictness** | Type discipline: `any`, double casts, missing return types, enums, default exports |
| **structure** | Code shape: file/function size, nesting, magic numbers, empty catch blocks |
| **organization** | Monorepo health: cycles, layer violations, import discipline, file pairing |
| **cleanup** | Dead code, AI residue: console logs, trivial comments, debugging files |
| **security** | Secrets, SQL injection, unsafe innerHTML, hardcoded tokens |

Categories are extensible — `category` is just a string, so you can define your own (e.g. `category: 'api-conventions'` or `category: 'react'`).

The goal is simple: **one command, one score, one decision.** Pass or fail.

## Quick start

### 1. Install Gesetz and the adapters you need

```bash
# Core + CLI (lightweight — no heavy deps)
bun add -d gesetz

# Language adapters for your stack (install only what you use)
bun add -d @gesetz/typescript      # TS/JS: oxc-parser + ast-grep
bun add -d @gesetz/php            # PHP: @ast-grep/lang-php (optional peer dep)

# Tool adapters for the linters/test runners you already use
bun add -d @gesetz/eslint @gesetz/vitest
```

### 2. Initialize a config

```bash
gesetz init
```

This creates a `gesetz.config.ts` at your project root. In a TTY it runs an interactive wizard; in CI or agent mode it auto-detects your framework and installed tools.

### 3. Run checks

```bash
gesetz check                          # everything
gesetz check --files "src/**"         # only these paths: less work, not just less output
gesetz check --rule tsc               # only these rules (globs allowed, repeatable)
gesetz check --category strictness    # only this category
```

`--files` and `--rule` are **scopes**. A rule that cannot match the request does not
run, and the external tools are given only those paths — so a scoped check is cheap,
and a scoped result says nothing about what it left out. A `--rule` that matches no
rule at all is refused with the list of rules that do exist, rather than reporting a
silent pass.

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

### 5. Caching & watch mode

Gesetz stores every detected violation in a shared cache (SQLite at
`${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`, using Node's built-in
`node:sqlite`). Files are fingerprinted by content hash, so repeat runs only
re-check the files you actually edited — unchanged files are served from the
cache:

```bash
gesetz check          # first run: full scan
gesetz check          # second run: near-instant, only changed files re-checked
gesetz check --full   # bypass the cache (no persistence)
gesetz check --watch  # re-run incrementally on every file change
```

- **Nothing to gitignore.** The cache lives in one shared file outside your
  repository — `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db` — with every project's
  entries namespaced by project root, so projects never see each other's
  results. Clear it with `rm -rf ~/.cache/gesetz`. Entries untouched for 30 days
  are swept automatically.
- The cache location is resolved in this order: `--full` or `GESETZ_DB=off`
  disables it; `storage: { kind: 'memory' }` in `gesetz.config.ts` disables it;
  `GESETZ_DB=<path>` sets the file; `storage: { kind: 'sqlite', path }` sets it;
  otherwise the shared cache. If the shared location is not writable (read-only
  `$HOME`, some containers) gesetz falls back to `<project>/.gesetz/cache.db`.
- Editing `gesetz.config.ts` invalidates the cache automatically (rule
  fingerprints); exemptions, thresholds, `--files`, and `--since` are
  aggregation-time filters and never trigger a rescan. Adding or removing a file
  also invalidates the per-file results, because checks such as `requireSibling`
  inspect other files — editing a file only re-checks that file.
- Persistence needs a SQLite driver. The built-in `node:sqlite` covers Node
  ≥ 23.4 (or ≥ 22.5 with `--experimental-sqlite`). On other runtimes — Bun,
  older Node — gesetz prints one notice and runs **without a cache**. To enable
  caching there, install the optional compat package and import it from your
  config:

  ```bash
  pnpm add -D @gesetz/sqlite-compat
  ```

  ```ts
  // gesetz.config.ts
  import '@gesetz/sqlite-compat';
  ```

- Discovery honours `.gitignore` — gesetz asks git for the file list. Outside a
  git repository it walks the directory tree instead, and cannot honour
  `.gitignore`.

### 6. When a tool cannot run

A rule backed by an external tool (ESLint, oxlint, Vitest, PHPStan, …) that
cannot be started — missing binary, killed process — is reported as a **critical
violation**, not as a silent pass. Other rules still run, so you get a partial
report plus a clear signal that it is partial:

```
gesetz: fail (12 violations)
  1 rule(s) could not run: oxlint — results are incomplete
```

The JSON envelope carries the same information as `failedRules`, and a run with
any failed rule never passes, regardless of category scores. Fix the tool, or
remove its rule from the config. If you would rather abort immediately with the
full error, pass `--throw`:

```bash
gesetz check --throw
```

Note that a tool exiting **non-zero is normal**: linters exit non-zero when they
find violations, and file-reporting tools (PHPUnit, Storybook) exit non-zero
while writing their report to a file. Only a tool that could not run at all is
treated as a failure.

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

Selectors are immutable, so a shared preset removes the repeated preamble:

```ts
// rules/presets.ts
export const SRC = select('src/**/*.ts').exclude('**/*.test.ts');

// rules/quality.ts — `select(glob, options)` is shorthand for the chained calls
export const noAny = select('src/**/*.ts', {
  exclude: ['**/*.test.ts'],
  label: 'No `any` types',
  category: 'strictness',
}).check(noTypedAny());
```

Categories can also be applied to a whole list of rules, which keeps the
gesetz config free of repeated `.category(...)` calls and comment headers:

```ts
import { defineConfig, group } from 'gesetz';
import * as quality from './rules/quality';

export default defineConfig({
  rules: [
    ...group('organization', [quality.everyFileNeedsTest, quality.noBarrelFiles]),
    ...group('strictness', [quality.noAny, quality.noEnums, quality.noEmptyCatches]),
    ...group('cleanup', [quality.noConsole, quality.noTrivialComments]),
  ],
});
```

```ts
// rules/quality.ts — no god files, no hardcoded secrets
import { select, noGodFile, noHardcodedSecret, noDebugLogging } from 'gesetz';

export const noGiantFiles = select('src/**/*.{ts,tsx,php,py}')
  .label('Files should not exceed 400 lines')
  .check(noGodFile({ maxLines: 400 }));

export const noSecrets = select('src/**/*')
  .label('No hardcoded secrets')
  .check(noHardcodedSecret());

// noDebugLogging is extension-aware: flags console.* in TS, var_dump/dd in PHP,
// print in Python, fmt.Println in Go, println! in Rust, puts in Ruby — one rule.
export const noDebug = select('src/**/*')
  .label('No debug logging left in code')
  .check(noDebugLogging());
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

For deeper structural checks — AST-level call detection, naming conventions, export pairs, call-shape validation — add `@gesetz/typescript` and register its backend:

```ts
// rules/architecture.ts — feature boundaries + AST checks
import { select, defineArchitecture } from 'gesetz';
import {
  typescriptSyntaxBackend,
  noFunctionCalls,
  requireOptionsObject,
  noTypedAny,
} from '@gesetz/typescript';

// Feature A must not import internals from Feature B
const arch = defineArchitecture({
  layers: [
    { name: 'features', pattern: 'src/features/**', canImportFrom: ['shared'] },
    { name: 'shared',   pattern: 'src/shared/**',   canImportFrom: [] },
  ],
});

export const featureIsolation = select('src/features/**/*.{ts,tsx}')
  .label('Features must not call fetch directly')
  .check(noFunctionCalls(['fetch']));

export const queryOptionsShape = select('src/api/**/*.ts')
  .label('queryOptions() must define queryKey and queryFn')
  .check(requireOptionsObject('queryOptions', { requiredKeys: ['queryKey', 'queryFn'] }));

export const noAny = select('src/**/*.ts').check(noTypedAny());

export default [featureIsolation, queryOptionsShape, noAny, ...arch];
```

Wire everything into your config:

```ts
// gesetz.config.ts
import { defineConfig } from 'gesetz';
import { typescriptSyntaxBackend } from '@gesetz/typescript';
import { eslint } from '@gesetz/eslint';
import { vitest } from '@gesetz/vitest';
import * as coverage from './rules/coverage';
import * as quality from './rules/quality';
import * as migration from './rules/migration';
import * as architecture from './rules/architecture';

export default defineConfig({
  adapters: [typescriptSyntaxBackend],   // enables AST checks + accurate imports
  rules: [
    // Your custom rules
    coverage.everyFileNeedsTest,
    quality.noGiantFiles,
    quality.noSecrets,
    quality.noDebug,
    migration.noLegacyImports,
    ...architecture.default,              // the arch array exported above

    // Your existing tools — now unified in the same report
    eslint({ pattern: 'src/**/*.{ts,tsx}' }),
    vitest({ pattern: 'src' }),
  ],
});
```

---

## Core concepts

### `Violation` — the universal report format

Every rule, check, and adapter produces the same shaped object. This is what makes Gesetz "one command, one report":

```ts
interface Violation {
  rule: string;               // rule ID that produced this violation
  message: string;            // human-readable message
  path: string;               // repository-relative file path
  line?: number;              // 1-based line number (optional)
  column?: number;            // 1-based column number (optional)
  severity: 'error' | 'warn' | 'info';
  context?: string;           // optional surrounding code snippet
  fix?: string;               // optional suggested fix
  source: 'core' | 'eslint' | 'phpstan' | 'oxlint' | 'custom';
}
```

### `Check` — a single-file analysis

A `Check` receives a `File` and a services bag. It returns a `Promise<Violation[]>`. It never throws — errors become violations or empty arrays.

```ts
import type { Check, File, Violation } from 'gesetz';

// A check that forbids urgent TODO comments
const noTodoComments: Check = async (file) => {
  const violations: Violation[] = [];
  file.content.split('\n').forEach((line, index) => {
    if (/TODO\s*\(urgent\)/i.test(line)) {
      violations.push({
        source: 'custom', severity: 'error',
        path: file.path, line: index + 1,
        message: `Urgent TODO found: "${line.trim()}"`,
      });
    }
  });
  return violations;
};

import { select } from 'gesetz';
export const noUrgentTodos = select('src/**/*.ts')
  .label('No urgent TODOs in production')
  .category('cleanup')
  .check(noTodoComments);
```

A `File` gives you everything you need for text-based analysis:

```ts
interface File {
  path: string;          // e.g. "src/components/Foo.tsx"
  absolutePath: string;  // e.g. "/repo/src/components/Foo.tsx"
  name: string;          // "Foo.tsx"
  stem: string;          // "Foo"
  ext: string;           // ".tsx"
  dir: string;           // "src/components"
  content: string;       // full UTF-8 content (read lazily on first access)
  size: number;          // bytes
  mtimeMs: number;       // last modified timestamp
}
```

### `Rule` — the top-level unit of work

A `Rule` has an `id`, `description`, `category`, and a `run` Effect that returns violations. Rules are self-contained — they can spawn external processes, read files, or call `SyntaxTree` — but they never throw.

**Using `select` (recommended)** — most rules are built by chaining:

```ts
import { select, requireSibling } from 'gesetz';

export const everyComponentNeedsStory = select('src/**/*.tsx')
  .exclude('**/*.test.tsx')
  .label('Every component needs a Storybook story')
  .category('organization')
  .check(requireSibling('.stories.tsx'));
```

**Writing a raw rule** — when you need full control (running an external tool, scanning the whole project at once). Raw rules use the project-level API, which receives a network context for globbing and file access:

```ts
import type { Rule, Violation } from 'gesetz';

export const noSecretsInEnv: Rule = {
  id: 'no-secrets-in-env',
  description: 'Repo .env files must not contain hardcoded secrets',
  category: 'security',
  project: {
    patterns: ['**/.env', '**/.env.local'],
    run: async (ctx) => {
      const files = await ctx.network.glob('**/.env*');
      const violations: Violation[] = [];
      for (const file of files) {
        const content = await file.content();
        if (/API_KEY\s*=\s*["']?[a-zA-Z0-9]{32}["']?/m.test(content)) {
          violations.push({
            rule: 'no-secrets-in-env', source: 'custom', severity: 'error',
            path: file.path, message: 'Possible hardcoded API key in .env file',
          });
        }
      }
      return violations;
    },
  },
};
```

### Consuming the output

**CLI** — structured JSON for agents and CI:

```bash
$ gesetz check --format=json
# {
#   "byRule":     [ { "ruleId": "...", "violations": [...] } ],
#   "byCategory": [ { "category": "cleanup", "score": 9.5, "passing": true } ],
#   "passing": true
# }
```

**Programmatically** — import `runAll` and call it directly. No Effect service layers are required — `runAll` manages its own backend:

```ts
import { runAll, defineConfig } from 'gesetz';
import { typescriptSyntaxBackend } from '@gesetz/typescript';

const config = defineConfig({
  adapters: [typescriptSyntaxBackend],
  rules: [/* ... */],
});

const result = await Effect.runPromise(runAll(config));
for (const cat of result.byCategory) {
  console.log(`${cat.category}: ${cat.score}/10 (${cat.errors}e ${cat.warnings}w)`);
}
```

### `select` — the rule builder

```ts
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
import { defineConfig, select, noGodFile, noHardcodedSecret } from 'gesetz';
import { typescriptSyntaxBackend, noConsoleLog, noHardcodedStrings } from '@gesetz/typescript';
import { eslint } from '@gesetz/eslint';
import { vitest } from '@gesetz/vitest';

export default defineConfig({
  projectRoot: '.',
  tsConfigPath: 'tsconfig.json',
  adapters: [typescriptSyntaxBackend],     // enables AST checks + accurate imports
  rules: [
    select('src/**/*.tsx').label('Components need stories').category('organization')
      .check(requireSibling('.stories.tsx')),
    select('src/**/*.ts').label('No console.log').category('cleanup').check(noConsoleLog()),
    select('src/**/*.tsx').label('No hardcoded user-facing strings').category('strictness')
      .check(noHardcodedStrings()),
    vitest({ pattern: 'src', label: 'Unit tests' }),
    eslint({ pattern: 'src/**/*.{ts,tsx}', label: 'ESLint' }),
  ],
  exemptions: [
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
gesetz check                              # full scan
gesetz check --since HEAD~5               # only changed files
gesetz check --since main                 # diff against a branch
gesetz check --category strictness        # run one category
gesetz check --format json                # JSON envelope (agents/CI)
gesetz check --format ci                  # GitHub Actions annotations
gesetz check --threshold 8                # override all thresholds
gesetz check --files "src/components/**"  # subset of files
gesetz check --project-root ./apps/web    # monorepo workspace
```

### `gesetz list`

```bash
gesetz list                       # all rules with guidance
gesetz list --category strictness # filter by category
gesetz list --format json         # JSON for agents
```

### `gesetz init`

```bash
gesetz init                       # interactive wizard
gesetz init --preset react        # explicit preset
gesetz init --preset laravel
gesetz init --no-interactive      # auto-detect + non-interactive
gesetz init --no-install          # scaffold only, no packages
gesetz init --no-qa-script        # skip adding a package.json script
gesetz init --force               # overwrite existing config
```

### `gesetz skill`

```bash
gesetz skill > .agents/skills/gesetz/SKILL.md
```

Prints a markdown agent skill file you can pipe directly into your AI agent's skill directory.

---

## The check catalog

Checks are grouped by **what they need to run** — the thing you actually have to know when composing a config.

> **Deprecated checks.** Gesetz writes a rule only when nothing better exists. For
> rules that oxlint already implements — and maintains, from the AST rather than
> from text — the gesetz version is deprecated and marked as such below. It still
> works and is still supported for now; it will be removed in a future major
> version. Prefer the oxlint rule, which keeps its score contribution either way
> because `@gesetz/oxlint` feeds oxlint's findings into the same report:
>
> | Deprecated here | Use instead |
> |---|---|
> | `noDeepNesting` | `max-depth`, `max-nested-callbacks` |
> | `noGodFile` | `max-lines` |
> | `noConsoleLog` | `no-console` |
> | `noEmptyCatch` | `no-empty` |
> | `noMagicNumbers` | `no-magic-numbers` |
> | `noTypedAny` | `typescript/no-explicit-any` |
> | `noDefaultExport` | `import/no-default-export` (enable the `import` plugin) |
> | `noBarrelFile` | `oxc/no-barrel-file` |
> | `requireExplicitReturnType` | `typescript/explicit-function-return-type` |
>
> ```jsonc
> // .oxlintrc.json
> {
>   "plugins": ["import"],
>   "rules": {
>     "max-depth": ["error", { "max": 4 }],
>     "max-nested-callbacks": ["error", { "max": 3 }],
>     "max-lines": ["error", { "max": 400 }],
>     "no-console": "error",
>     "no-empty": "error",
>     "no-magic-numbers": ["error", { "ignore": [0, 1, 2, 100] }],
>     "typescript/no-explicit-any": "error",
>     "typescript/explicit-function-return-type": "error",
>     "import/no-default-export": "error",
>     "oxc/no-barrel-file": "error"
>   }
> }
> ```
>
> The rest of the catalog is unaffected: file-pairing rules (`requireSibling`,
> `requireChildren`, `forbidFile`), architecture layers, pattern rules, secret
> scanning, the Effect rules, and every PHP/Laravel rule have no oxlint
> equivalent. oxlint only covers JavaScript and TypeScript.

### A. Universal text/regex checks (core, any file, no backend)

These live in `@gesetz/core` and work on any file using text analysis or the file system. No AST, no type-checker, no language-specific parser. Fast and universal.

#### File-system checks

**`requireSibling(suffix, opts?)`** — checks that a sibling file with the given suffix exists. `Foo.tsx` + `.test.ts` → looks for `Foo.test.ts`.

```ts
requireSibling('.test.ts')
requireSibling('.stories.tsx', { message: 'Components need a story file' })
```

**`requireChildren(requiredPaths, opts?)`** — checks that the directory containing each matched file also contains every file in the list.

```ts
requireChildren(['types.ts', 'interface.ts'])
requireChildren(['README.md'], { message: (m) => `Package missing ${m}` })
```

**`forbidFile(opts?)`** — marks every matched file as a violation. Use with `select(...)` targeting files that should not exist.

```ts
select('src/legacy/**/*').check(forbidFile({ message: 'Legacy files are being phased out' }))
```

#### Pattern checks

**`noPattern(regex, opts?)`** — the file must not contain a regex match. `opts.fullFile: true` matches against the whole file as one string (default: line-by-line with line numbers).

```ts
noPattern(/debugger;/)
noPattern(/TODO\(urgent\)/, { fullFile: true, severity: 'warn' })
```

**`requirePattern(regex, opts?)`** — the file must contain the pattern at least once.

```ts
requirePattern(/declare\(strict_types=1\)/)
```

#### Structure checks

**`noGodFile({ maxLines?, message? })`** — flags files exceeding a line-count threshold. Default `maxLines: 400`, severity `warn`. **Deprecated** — use oxlint's `max-lines`.

```ts
noGodFile({ maxLines: 300 })
```

**`noDeepNesting({ maxLevels?, message? })`** — flags lines whose indentation exceeds a threshold (2-space or tab). Default `maxLevels: 4`, severity `warn`, capped at 10 violations/file.

> **Deprecated for TypeScript/JavaScript.** It measures *indentation*, not
> control-flow depth — a callback passed to `.pipe(...)` counts as a level exactly
> as a nested `if` does — so it reports formatting as nesting. Use oxlint's
> `eslint/max-depth` (and `eslint/max-nested-callbacks` for callback depth)
> instead; oxlint is what Gesetz recommends for TS/JS and its rules measure real
> nesting from the AST:
>
> ```jsonc
> // .oxlintrc.json
> {
>   "rules": {
>     "max-depth": ["error", { "max": 4 }],
>     "max-nested-callbacks": ["error", { "max": 3 }]
>   }
> }
> ```
>
> This check remains for languages oxlint does not cover and for projects without
> it, and is expected to be removed in a future major version.

```ts
noDeepNesting({ maxLevels: 3 })
```

**`noDebuggingResidueFiles({ extraPatterns?, message? })`** — flags files whose names look like debugging artefacts (`*_v2`, `*_backup`, `*_fixed`, `*_copy`, `*_old`, `*_new`, `*_temp`, `*_wip`, `*_draft`, `*delete_me*`).

```ts
noDebuggingResidueFiles({ extraPatterns: [/\.draft\./i] })
```

**`noHardcodedSecret({ message? })`** — regex heuristic for `api_key = "…"`, `token: "…"`, `password = "…"`, `bearer "…"`, etc. Not a replacement for proper secret scanning (GitLeaks, TruffleHog). Severity `error`.

```ts
noHardcodedSecret()
```

#### `noDebugLogging(opts?)` — polyglot debug-logging detector

Regex-based, **extension-aware**. Maps file extensions to known debug function names and scans line by line. No `SyntaxTree` dependency — works on any file with a known extension.

| Extension | Flags |
|---|---|
| `.ts` `.tsx` `.js` `.jsx` `.mjs` `.cjs` | `console.log/debug/info/warn/error/dir/table/trace` |
| `.py` | `print`, `pprint`, `breakpoint` |
| `.php` | `var_dump`, `print_r`, `dd`, `dump`, `debug` |
| `.go` | `fmt.Println`, `fmt.Printf`, `log.Println`, `log.Printf` |
| `.rs` | `println!`, `eprintln!`, `dbg!` |
| `.rb` | `puts`, `p`, `pp` |

Files with extensions not in this map are silently skipped (not an error).

```ts
noDebugLogging()
noDebugLogging({ extraNames: ['myDebugFn'], severity: 'error', message: 'No logging!' })
```

- **`opts.extraNames`** — additional function names to ban (applied to all extensions).
- **`opts.severity`** — default `warn`.
- **`opts.message`** — default `Remove debug logging: <name>`.

For more precise, AST-level banning of specific function calls, use [`noDirectCalls`](#b-syntaxtree-backed-structural-checks-core-need-adapters) (requires a backend).

### B. SyntaxTree-backed structural checks (core, need `adapters`)

These live in `@gesetz/core` but require a `SyntaxBackend` to be registered for the file's extension (via `defineConfig({ adapters })`). If no backend matches the file's extension, the check silently returns no violations — it does not crash.

**`noDirectCalls(names, opts?)`** — bans specific function calls by exact name (member access supported: `console.log`, `fmt.Println`). Unlike `noDebugLogging` (regex, broad), this is precise and user-specified.

```ts
noDirectCalls(['eval', 'execSync'])
noDirectCalls(['console.log'], { message: (n) => `do not call ${n}!`, severity: 'warn' })
```

**`requireNamingConvention({ kinds?, pattern, message?, severity? })`** — every structural item of the given kinds must match the regex. `kinds` defaults to all (`'function'`, `'class'`, `'method'`, …).

```ts
requireNamingConvention({ kinds: ['function', 'class'], pattern: /^[a-z][a-zA-Z0-9]*$/ })
```

**`noForbiddenNames(names | RegExp, { kinds?, message?, severity? })`** — bans specific names (string list or regex) on structural items.

```ts
noForbiddenNames(['foo', 'bar'])
noForbiddenNames(/^tmp_/, { kinds: ['function'] })
```

**`requireDocstrings({ kinds?, message?, severity? })`** — structural items must have an attached docstring. Default `kinds: ['function', 'class', 'method']`.

```ts
requireDocstrings({ kinds: ['class'] })
```

**`requireExportsMatching(pattern, minCount?, opts?)`** — the file must export at least `minCount` identifiers matching the regex. Default `minCount: 1`.

```ts
requireExportsMatching(/Keys$/, 1)
```

**`requireRelatedExports(getRelated, opts?)`** — for every export `X`, all counterparts returned by `getRelated(X)` must also be exported. Return `null` to skip an export. *(N-ary: returns `string[]`, not one string.)*

```ts
// Every useX must have both useSuspenseX and useCachedX
requireRelatedExports(name => {
  if (!name.startsWith('use')) return null;
  const base = name.slice(3);
  return [`useSuspense${base}`, `useCached${base}`];
})
```

**`requireMinStructureCount(kind, minCount, opts?)`** — the file must declare at least `minCount` structural items of the given kind (counted recursively, including nested children).

```ts
requireMinStructureCount('function', 1)
```

### C. Architecture & import graph (core; accurate with `adapters`)

**`noImportFrom(module, opts?)`** — the file must not import from the given module (string exact/prefix match, or `RegExp`). Matches static imports, dynamic imports, and `require()`. Uses `SyntaxTree` for accurate specifiers when a backend is registered; falls back to a JS/TS regex otherwise.

```ts
noImportFrom('lodash')
noImportFrom('@tanstack/react-query', { message: 'Use SDK hooks instead' })
noImportFrom(/^~\/legacy\//, { severity: 'warn' })
```

**`requireImportFrom(module, opts?)`** — opposite of `noImportFrom`. The file must import from the module at least once.

```ts
requireImportFrom('vitest')
```

**`defineArchitecture(config)`** — declares monorepo layers as file-glob patterns and enforces import constraints between them. Returns `Rule[]` (one batched rule, not O(n²) per-pair rules). Import extraction uses `SyntaxTree` when a backend is registered (oxc-parser for TS/JS, `@ast-grep/lang-php` for PHP); relative specifiers are resolved to file paths via `ImportResolver`; falls back to a JS/TS regex when no backend is registered.

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
    util: ['react', 'react-dom'],   // util layer may not import React
  },
});

export default defineConfig({ adapters: [typescriptSyntaxBackend], rules: [...arch] });
```

| Config field | Type | Description |
|---|---|---|
| `layers[].name` | `string` | Layer identifier used in messages and cross-references |
| `layers[].pattern` | `string \| string[]` | Glob(s) matching files in this layer |
| `layers[].canImportFrom` | `string[] \| undefined` | Layers this layer may import from. Omit to allow all. |
| `forbidden[].from` / `.to` | `string` | Explicit denial of a source → target layer pair |
| `forbidden[].message` | `string \| undefined` | Custom message |
| `bannedExternals` | `Record<layer, packageName[]>` | Per-layer banned npm packages (scoped supported) |

**`noCycles(pattern, opts?)`** — detects circular dependencies via `SyntaxTree` (import extraction) + `ImportResolver` (path resolution) + DFS over the dependency graph. **No `dependency-cruiser`** — it's been removed. Files whose extension has no registered backend are skipped; external (non-resolvable) imports are ignored.

```ts
noCycles('src/**/*.{ts,tsx}')
noCycles(['src/**/*.ts', 'apps/**/*.ts'], { label: 'No circular dependencies' })
```

### D. TypeScript / JavaScript checks (`@gesetz/typescript`)

Install: `bun add -d @gesetz/typescript`

This package exports `typescriptSyntaxBackend` (oxc-parser for imports/exports + `@ast-grep/napi` for calls/structure; handles `.ts .tsx .js .jsx .mjs .cjs`). Register it via `adapters: [typescriptSyntaxBackend]` to enable all checks below.

> **No `ts-morph`** — every check here is syntactic (AST traversal via ast-grep/oxc-parser). For type-checked rules like `no-floating-promises`, use `@gesetz/eslint` or `@gesetz/oxlint` with `--type-aware` (both ship the type-checked version).

#### Moved from `@gesetz/core` (TS/JS-specific)

These used to live in core; they were moved because they're TypeScript/JavaScript-specific:

- **`noConsoleLog({ allowWarnError?, message? })`** — bans `console.*`. `allowWarnError: true` allows `console.warn`/`console.error`. **Deprecated** — use oxlint's `no-console`.
- **`noEmptyCatch({ message? })`** — flags empty or comment-only catch blocks. Severity `error`. **Deprecated** — use oxlint's `no-empty`.
- **`noMagicNumbers({ ignore?, message? })`** — flags unexplained numeric literals (skips `const UPPER_SNAKE = N` and the default ignore list `[0, 1, -1, 2, 100]`). Capped at 20/file. **Deprecated** — use oxlint's `no-magic-numbers`.
- **`noTrivialComment({ message? })`** — flags AI-narration comments (`// Import the module`) and decorative dividers (`// ======`). Severity `info`.
- **`relativeImports({ message? })`** — every relative `import … from './foo'` must resolve to an existing file (`.ts`, `.tsx`, `/index.ts`, `/index.tsx`).

#### AST checks (call + export + shape)

**`noFunctionCalls(callNames, opts?)`** — bans direct calls to the listed function names.

```ts
noFunctionCalls(['fetch', 'useSuspenseQuery'])
```

**`requireRelatedExports(getRelated, opts?)`** *(TS version)* — same semantics as the core one, but uses oxc-parser exports (handles re-exports, type exports).

**`requireExportsMatching(pattern, minCount?, opts?)`** *(TS version)* — same as core, oxc-parser exports.

**`requireOptionsObject(fnName, { argIndex?, requiredKeys })`** — every call to `fnName()` must pass an object literal at argument position `argIndex` (default 0) containing all `requiredKeys`. *(Renamed from `requireCallShape`; now supports `argIndex`.)*

```ts
requireOptionsObject('queryOptions', { requiredKeys: ['queryKey', 'queryFn'] })
requireOptionsObject('useMutation', { argIndex: 1, requiredKeys: ['onMutate', 'onError', 'onSettled'] })
```

#### TypeScript strictness (new, ast-grep based)

**`noTypedAny({ message? })`** — bans `any` type annotations (`: any`, `as any`, `<any>`). **Deprecated** — use oxlint's `typescript/no-explicit-any`.

**`noAsUnknownAs({ message? })`** — bans double casts `as unknown as X` (and `as any as X`). Use a type guard instead.

**`noDefaultExport({ message? })`** — bans `export default`. Named exports improve refactorability and IDE auto-import. **Deprecated** — use oxlint's `import/no-default-export`.

**`noEnum({ message? })`** — bans TypeScript `enum`. Prefer union types or `as const` object maps.

**`noBarrelFile({ maxReexports?, message? })`** — flags `index.{ts,tsx}` files that re-export more than `maxReexports` (default 5) modules. Barrel files harm tree-shaking. **Deprecated** — use oxlint's `oxc/no-barrel-file`.

**`requireExplicitReturnType({ kinds?, ignore?, message? })`** — public functions and methods must declare an explicit return type. `kinds` default `['function', 'method']`. **Deprecated** — use oxlint's `typescript/explicit-function-return-type`.

```ts
requireExplicitReturnType({ ignore: /^test[A-Z]/ })  // ignore test functions
```

#### JSX / React checks

**`noLiteralJsxText({ hasLetterRegex?, message? })`** — flags JSX text nodes containing letters (`<div>Hello</div>`). Enforce i18n.

**`noLiteralJsxProp(translatableProps, opts?)`** — flags listed JSX attributes with string-literal values.

```ts
noLiteralJsxProp(['label', 'placeholder', 'title', 'aria-label'])
```

**`noJsxElements(elements, opts?)`** — flags JSX elements with the given tag names.

```ts
noJsxElements(['div', 'span', 'h1', 'h2', 'p', 'ul', 'li', 'table'])
```

**`noLocalFunctionComponents({ excludeExportedNames?, message? })`** — flags non-exported function declarations that contain JSX (local helper components).

#### i18n / hardcoded strings

**`noHardcodedStrings(opts?)`** — the comprehensive i18n check. Flags three cases in one pass: JSX text nodes, string literals inside JSX expressions (`{"Hello"}`), and known text-bearing attributes (`<input placeholder="Search" />`).

```ts
noHardcodedStrings()                                          // defaults
noHardcodedStrings({ attributeSeverity: 'error' })            // strict on attributes
noHardcodedStrings({ textAttributes: ['label', 'placeholder'] })
```

- `textAttributes` — default `DEFAULT_TEXT_ATTRIBUTES` (35 common attributes: `label`, `placeholder`, `title`, `alt`, `aria-label`, …).
- `attributeSeverity` — default `warn` (edge-case-prone; `alt="logo"`).
- `textSeverity` — default `error`.
- `hasLetterRegex` — default `/[A-Za-zÄÖÜäöüßÀ-ÿ]/`.

#### Object property

**`noObjectProperty(varName, propName, opts?)`** — text-based: finds `const varName = { … }` and checks it doesn't define `propName`. Uses brace-counting for nested objects.

```ts
noObjectProperty('meta', 'title')   // Storybook meta must not define explicit title
```

#### Directory & test quality

**`requireDirectoryStructure(requiredFiles)`** — re-export of core's `requireChildren`, for discoverability.

**`requireMinTestScore(scoring)`** — scores a test file by quality signals (assertion count, async tests, interaction coverage, error paths, assertion variety, trivial-assertion penalty) and returns a violation if below `minScore`. Text-based.

```ts
requireMinTestScore({ minScore: 50 })
requireMinTestScore({ minScore: 60, assertionThresholds: [1, 5, 10], trivialPenalty: -30 })
```

Key params (all optional except `minScore`): `assertionThresholds` (default `[1,3,5,8]`), `assertionBonus` (`5`), `testCountThresholds` (`[2,4,6]`), `testCountBonus` (`5`), `assertionNames` (`['expect(']`), `trivialAssertions` (`['toBeTrue(','toBeTruthy(','toBeDefined(']`), `trivialPenalty` (`-20`), `asyncIndicators` (`['waitFor(','act(']`), `interactionMethods` (`['userEvent.','fireEvent.']`), `errorIndicators` (`['.toThrow(','.rejects.']`), `asyncBonus`/`interactionBonus`/`errorBonus`/`varietyBonus` (all `5`).

### E. PHP checks (`@gesetz/php`)

Install: `bun add -d @gesetz/php`

Exports `phpSyntaxBackend` (uses `@ast-grep/lang-php`, an **optional peer dep** — run `bun pm trust @ast-grep/lang-php` once after install to place its prebuilt binary). Handles `.php`. Extracts `use` statements (including grouped `use Foo\{A, B}` and aliased `use Foo\Bar as Baz`), function calls, classes/methods, and docstrings.

**Generic PHP checks** (text-based unless noted):

- **`strictTypes({ message? })`** — file must contain `declare(strict_types=1)`.
- **`psrNamespace({ baseNamespace, basePath, message? })`** — namespace must match PSR-4 directory structure. Files outside `basePath` are skipped.
- **`noInlineQueries(patterns, opts?)`** — line-by-line ban on caller-provided call patterns (Laravel `DB::raw`, WordPress `$wpdb->query`, generic `PDO::query`, …).
- **`requireTypeHints({ message? })`** — function parameters must have type hints.
- **`requireReturnType({ message? })`** — functions must have return type declarations (`: string`, `: void`).
- **`requireNamespace({ message? })`** — file must declare a `namespace`.
- **`noDieOrExit({ message? })`** — bans `die()` and `exit()`.
- **`noEval({ message? })`** — bans `eval()`.
- **`requireFinalClasses({ message? })`** — classes must be declared `final` (skips abstract and anonymous classes).

### F. Laravel presets (`@gesetz/laravel`)

Install: `bun add -d @gesetz/laravel`

Ready-made rules for standard Laravel projects.

```ts
import { allRules } from '@gesetz/laravel';
import { defineConfig } from 'gesetz';

export default defineConfig({ rules: allRules });
```

Or pick individual rules:

```ts
import {
  requireStrictTypes, requirePsrNamespaces, noRawDbQueries,
  noEnvOutsideConfig, noDebugHelpers, phpstan,
  noDd, noFacades,
} from '@gesetz/laravel';
```

- **`requireStrictTypes`**, **`requirePsrNamespaces`**, **`noRawDbQueries`**, **`noEnvOutsideConfig`**, **`noDebugHelpers`** — pre-built `Rule`s with Laravel path defaults.
- **`noDd({ message?, severity? })`** — standalone `Check` banning `dd()`, `ddd()`, `dump()`, `debug()`. More precise than `noDebugHelpers` (which is a pre-built select rule); use inside `select().check()` for custom targeting.
- **`noFacades({ facades?, message?, severity? })`** — bans Laravel Facades (`Auth::`, `DB::`, `Cache::`, …) in favor of dependency injection. `facades` defaults to a list of common facades.

### G. Effect-TS checks (`@gesetz/effect-ts`)

Install: `bun add -d @gesetz/effect-ts`

Catches the four most common anti-patterns AI agents introduce in Effect-TS code. All four use **ast-grep** (no `ts-morph`).

**`noRunPromiseScattered({ entryPoints?, message? })`** — flags `Effect.runPromise` / `runSync` / `runFork` / `runCallback` / `runPromiseExit` outside designated entry-point files.

```ts
noRunPromiseScattered({ entryPoints: ['src/main.ts', 'src/index.ts'] })
```

**`noThrowInEffectGen({ message? })`** — flags `throw` inside `Effect.gen()` / `Effect.fn()` / `Effect.fnUntraced()`. `throw` converts typed failures into untyped Defects — use `yield* Effect.fail(new MyError())`.

**`noYieldWithoutStar({ message? })`** — flags plain `yield expr` (no `*`) inside Effect generators. `yield` returns the raw channel; `yield*` unwraps the Effect.

**`noUnboundedEffectAll({ message? })`** — flags `Effect.all([...])` calls with fewer than 2 arguments (i.e. no `{ concurrency }` option). Forces explicit concurrency intent.

---

## Tool adapters

Tool adapters **wrap external CLI tools** and normalize their output into the same `Violation[]` shape. Install only the ones for tools you already use.

### TypeScript / JavaScript

| Package | Tool | What it does | Install |
|---|---|---|---|
| `@gesetz/eslint` | ESLint | Runs ESLint programmatically, maps messages to violations. Use for type-checked rules like `@typescript-eslint/no-floating-promises`. | `bun add -d @gesetz/eslint` |
| `@gesetz/oxlint` | oxlint | Fast Rust linter — maps JSON diagnostics to violations. Use with `--type-aware` + `tsgolint` for `typescript/no-floating-promises`. | `bun add -d @gesetz/oxlint` |
| `@gesetz/oxfmt` | oxfmt | Format check — `--list-different` | `bun add -d @gesetz/oxfmt` |
| `@gesetz/prettier` | Prettier | Format check — `--list-different` | `bun add -d @gesetz/prettier` |
| `@gesetz/vitest` | Vitest | Runs tests with JSON reporter, maps failures to violations | `bun add -d @gesetz/vitest` |
| `@gesetz/bun-test` | bun:test | JUnit XML bridge via temp file | `bun add -d @gesetz/bun-test` |
| `@gesetz/storybook` | test-storybook | Jest JSON bridge for Storybook interaction tests | `bun add -d @gesetz/storybook` |
| `@gesetz/junit` | — | Shared JUnit XML parser (used by bun-test, Pest, PHPUnit) | `bun add -d @gesetz/junit` |

### PHP

| Package | Tool | What it does | Install |
|---|---|---|---|
| `@gesetz/phpstan` | PHPStan | Runs `analyse --error-format=json` | `bun add -d @gesetz/phpstan` |
| `@gesetz/phpunit` | PHPUnit | JUnit XML bridge | `bun add -d @gesetz/phpunit` |
| `@gesetz/pest` | Pest | JUnit XML bridge | `bun add -d @gesetz/pest` |

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

## What belongs in Gesetz vs. your language tools

**Use Gesetz's built-in checks for:**

- File pairing and directory structure (every `Foo.tsx` needs a `Foo.stories.tsx`)
- Import discipline (no cross-domain imports, required imports, layer constraints)
- Cross-cutting patterns (no console logs, no empty catches, no magic numbers, no debug logging)
- Monorepo architecture (layer constraints, circular dependency detection)
- Security hygiene (hardcoded secrets, forbidden file patterns)
- Structural conventions (naming, docstrings, export pairs, explicit return types)

**Use adapters to wrap your existing tools for:**

- Deep type-level analysis (ESLint with `@typescript-eslint`, PHPStan, oxlint with `--type-aware`) — including type-checked rules like `no-floating-promises` that Gesetz intentionally does not reimplement.
- Test result mapping (Vitest, PHPUnit, Pest, bun:test)
- Format checking (Prettier, oxfmt)
- Storybook interaction tests

Gesetz's rule runner executes all of these concurrently and merges their violations into one report. You don't give up your tools — you just stop reading five different output formats.

---

## Scoring & thresholds

Each category gets a score from **0 to 10**:

```
weighted = errors * 1.0 + warnings * 0.5 + infos * 0.1
score    = max(0, 10 - weighted)
```

A project **passes** when every category with rules is at or above its threshold. Default threshold is **7**.

```ts
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

---

## How it works

Gesetz is built in three layers, with dependencies pointing **downward only**:

```
┌──────────────────────────────────────────────────────────────┐
│  @gesetz/core     contracts + file-system primitives         │
│                   (zero parser dependencies)                 │
├──────────────────────────────────────────────────────────────┤
│  language adapters  export a SyntaxBackend object            │
│  @gesetz/typescript, @gesetz/php  (+ future: python, …)      │
├──────────────────────────────────────────────────────────────┤
│  tool adapters      wrap external linters / test runners     │
│  eslint, oxlint, phpstan, vitest, prettier, …                │
└──────────────────────────────────────────────────────────────┘
```

- **Core** defines service *contracts* — `FileSystem`, `SyntaxTree`, `ImportResolver`, `ProjectRoot`, `FileFilter` — and ships text/regex checks that work on any language. It has **no parser dependency**, so adding a new language never touches core.
- **Language adapters** each export a `SyntaxBackend` — a plain object that extracts imports, calls, exports, and structure from source via a real parser. You declare which adapters you want in `defineConfig({ adapters })`, and core's `SyntaxTreeLive` routes every file to the right backend by extension.
- **Tool adapters** wrap external CLI tools (ESLint, PHPStan, Vitest, …) and normalize their output into the same `Violation[]` shape.

### The three parsing tools

| Tool | Used for | Lives in |
|---|---|---|
| `oxc-parser` | JS/TS imports + exports (clean module specifiers) | `@gesetz/typescript` |
| `@ast-grep/napi` + `@ast-grep/lang-*` | Function calls + structural declarations for all languages | each language adapter |
| (none — text/regex) | Universal checks: file size, secrets, debug logging, magic numbers | `@gesetz/core` |

There is **no `ts-morph` and no `tree-sitter`** anywhere — every check that used them was either syntactic (and migrated to ast-grep/oxc-parser) or type-level (and delegated to `@gesetz/eslint`/`@gesetz/oxlint`, which ship type-checked versions). Core stays parser-free.

### What this means for your config

Some checks need a registered `SyntaxBackend` to do their job (e.g. `noDirectCalls`, `requireNamingConvention`, `defineArchitecture` for accurate import extraction). You opt in by listing backends in your config:

```ts
import { defineConfig } from 'gesetz';
import { typescriptSyntaxBackend } from '@gesetz/typescript';
import { phpSyntaxBackend } from '@gesetz/php';

export default defineConfig({
  adapters: [typescriptSyntaxBackend, phpSyntaxBackend],  // ← opt in to parsing
  rules: [/* ... */],
});
```

- **No adapters listed?** Universal text/regex checks still run; SyntaxTree-backed checks silently no-op on files with no registered backend (they don't crash). `defineArchitecture` and `noImportFrom` fall back to a JS/TS regex.
- **Polyglot project?** Just list every backend you need — they coexist because `SyntaxTreeLive` routes by extension (no Layer conflicts).

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

| Package | Layer | Description | When to install |
|---|---|---|---|
| `gesetz` | meta | **Start here.** Core primitives, rule runner, `defineConfig`, `select`, `defineArchitecture`, and the CLI. No heavy dependencies. | Always |
| `@gesetz/core` | core | Types, runner, primitives, file-system checks, pattern checks, architecture rules, `SyntaxTree`/`ImportResolver` contracts (included by `gesetz`) | — |
| `@gesetz/cli` | core | `gesetz` command-line interface (included by `gesetz`) | — |
| `@gesetz/typescript` | language adapter | `typescriptSyntaxBackend` + AST checks (oxc-parser + ast-grep): export pairs, call shapes, JSX, i18n, `noTypedAny`, `noEnum`, … | TypeScript projects needing AST rules |
| `@gesetz/php` | language adapter | `phpSyntaxBackend` + PHP checks (`@ast-grep/lang-php`): strict types, PSR-4, type hints, final classes, … | PHP projects needing AST rules |
| `@gesetz/effect-ts` | language-specific checks | Effect-TS anti-pattern detection (ast-grep) | Effect-TS codebases |
| `@gesetz/laravel` | language-specific presets | Laravel opinionated presets | Laravel projects |
| `@gesetz/eslint` | tool adapter | ESLint adapter | JS/TS projects using ESLint |
| `@gesetz/oxlint` | tool adapter | oxlint adapter | Projects using oxlint |
| `@gesetz/oxfmt` | tool adapter | oxfmt adapter | Projects using oxfmt |
| `@gesetz/prettier` | tool adapter | Prettier adapter | Projects using Prettier |
| `@gesetz/vitest` | tool adapter | Vitest adapter | Projects using Vitest |
| `@gesetz/bun-test` | tool adapter | bun:test adapter | Projects using Bun tests |
| `@gesetz/storybook` | tool adapter | test-storybook adapter | Projects with Storybook |
| `@gesetz/junit` | tool adapter | Shared JUnit XML parser | Pulled in automatically by bun-test / PHPUnit / Pest |
| `@gesetz/phpstan` | tool adapter | PHPStan adapter | PHP projects |
| `@gesetz/phpunit` | tool adapter | PHPUnit adapter | PHP projects |
| `@gesetz/pest` | tool adapter | Pest adapter | PHP projects |

---

## Philosophy

- **One gate** — many tools, one report.
- **Wrap, don't replace** — ESLint knows JS better than we do. PHPStan knows PHP better than we do. Gesetz wraps them so you read one output. Type-checked rules (e.g. `no-floating-promises`) are delegated to the adapters that already do them well.
- **Core has zero parser deps** — `@gesetz/core` defines contracts; language adapters own the parsers. Adding a language never touches core.
- **Cross-cutting first** — core's built-in checks focus on file structure, import discipline, and conventions that span every language. Language-specific depth lives in language adapters.
- **Never crash the build** — a broken rule produces a warning, not a fatal error. SyntaxTree-backed checks silently skip files whose extension has no registered backend.
- **Agent-native** — JSON output, skill files, guidance metadata.
- **TypeScript-first** — your config is typed, your architecture is typed, your rules are typed. Rules are functions (no string dispatch, no global registry) — tree-shakeable and refactor-safe.
- **Deterministic** — no global state, no random IDs, no module-level counters. Same code, same score, every time.
- **Memory-bounded** — `FileSystem.glob` reads file content lazily on first access and ignores `node_modules`/`.git` by default.

---

## Testing custom checks

Gesetz ships built-in testing helpers so you can test your custom checks without importing Effect, wiring service layers, or casting `{} as any`.

All helpers are exported from `@gesetz/core`. They are **plain functions** — no Effect, no runtime, no dependency injection.

### The three helpers

**`makeFile(path, content?)`** — creates a `File` object from a repository-relative path. The absolute path is resolved against `process.cwd()`. All metadata (`stem`, `ext`, `dir`, `size`, `mtimeMs`) is derived automatically.

```ts
import { makeFile } from '@gesetz/core';

const file = makeFile('src/Button.tsx', 'export function Button() { return <div />; }');
// → { path: 'src/Button.tsx', absolutePath: '/Users/…/src/Button.tsx', name: 'Button.tsx', stem: 'Button', ext: '.tsx', … }
```

**`makeCheckServices(options?)`** — builds a fully-typed `CheckServices` bag with safe, no-op defaults for every method. You only override what your check actually needs.

**`runCheck(check, file, services)`** — runs a check and returns its violations. A one-liner that reads as a test operation.

```ts
import { makeCheckServices, runCheck } from '@gesetz/core';

const services = makeCheckServices();
const violations = await runCheck(myCheck, file, services);
```

### Patterns

#### Pattern 1 — Pure sync checks (regex, text scanning)

Checks that only read `file.content` or `file.path`. No services needed.

```ts
import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

describe('noDebugLogging', () => {
  it('flags console.log in TypeScript files', async () => {
    const v = await runCheck(
      noDebugLogging(),
      makeFile('src/foo.ts', 'console.log("hi");'),
      makeCheckServices(),  // all safe defaults
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(1);
  });
});
```

**What to provide:** nothing. `makeCheckServices()` with no options gives you a complete, valid `CheckServices` where every method returns a safe default (`fs.exists` returns `false`, `syntax.process` returns empty arrays, etc.).

#### Pattern 2 — File system checks (`requireSibling`, `requireChildren`)

Checks that call `fs.exists` or `fs.readFile`.

```ts
import * as nodePath from 'node:path';
import { makeCheckServices } from '@gesetz/core';

const CWD = process.cwd();

describe('requireSibling', () => {
  it('passes when the sibling file exists', async () => {
    const services = makeCheckServices({
      projectRoot: CWD,
      files: {
        [nodePath.resolve(CWD, 'src/Button.stories.tsx')]: '',
      },
    });
    const v = await runCheck(
      requireSibling('.stories.tsx'),
      makeFile('src/Button.tsx'),
      services,
    );
    expect(v).toHaveLength(0);
  });

  it('fails when the sibling is missing', async () => {
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(
      requireSibling('.stories.tsx'),
      makeFile('src/Button.tsx'),
      services,
    );
    expect(v).toHaveLength(1);
  });
});
```

**What to provide:** `files` — a map of absolute path → content. `fs.exists` returns `true` for keys in this map, `false` for everything else. `fs.readFile` returns the value (content) for matching keys.

#### Pattern 3 — Syntax tree checks (`noDirectCalls`, `requireNamingConvention`, `noImportFrom`)

Checks that call `syntax.process` and `syntax.canProcess`.

```ts
describe('noDirectCalls', () => {
  it('flags calls whose name is in the banned set', async () => {
    const services = makeCheckServices({
      syntax: {
        calls: [
          { name: 'eval', line: 3 },
          { name: 'fetch', line: 7 },
        ],
      },
    });
    const v = await runCheck(noDirectCalls(['eval']), makeFile('src/foo.ts'), services);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(3);
  });

  it('returns no violations when canProcess is false', async () => {
    const services = makeCheckServices({
      overrides: { syntax: { canProcess: () => false } },
    });
    const v = await runCheck(noDirectCalls(['eval']), makeFile('src/foo.rb'), services);
    expect(v).toHaveLength(0);
  });
});
```

**What to provide:** `syntax` — a `Partial<SyntaxBackendProcessResult>` with `{ calls, imports, exports, structure }`. These values are merged into the default empty arrays. `canProcess` defaults to `true` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.php`.

#### Pattern 4 — The escape hatch for dynamic mocks

When you need custom mock logic that the declarative options can't express — e.g. `process()` that throws for specific files — use `overrides`.

```ts
describe('error handling', () => {
  it('returns empty array when syntax processing throws', async () => {
    const services = makeCheckServices({
      overrides: {
        syntax: {
          process: async (file) => {
            if (file.name === 'evil.ts') throw new Error('parse error');
            return { imports: [], calls: [], exports: [], structure: [] };
          },
        },
      },
    });
    const v = await runCheck(requireDocstrings(), makeFile('src/evil.ts'), services);
    expect(v).toHaveLength(0);
  });
});
```

**What `overrides` does:** takes precedence over all other options. `overrides.syntax.process` replaces the static `syntax` option entirely. `overrides.fs`, `overrides.syntax`, `overrides.imports`, and `overrides.projectRoot` are all partially typed — you only override the methods you need.

### Full options reference

| Option | Type | Default | Description |
|---|---|---|---|
| `files` | `Record<string, string>` | `{}` | Absolute path → file content. `fs.exists` returns true for keys; `fs.readFile` returns the value. |
| `glob` | `readonly File[]` | `[]` | Override `fs.glob` result. |
| `syntax` | `Partial<SyntaxBackendProcessResult>` | all empty arrays | Static data merged into `syntax.process()` return value. |
| `imports` | `Record<string, string \| null>` | `{}` | Specifier → resolved absolute path (or `null`). |
| `projectRoot` | `string` | `process.cwd()` | Absolute project root path. |
| `overrides` | nested partials | — | Escape hatch: override individual `CheckServices` methods. Takes precedence. |

### Principles

1. **One `makeCheckServices` call per test** — build the exact state inline; don't share mutable services objects across tests.
2. **Use `overrides` sparingly** — the declarative options (`files`, `syntax`, `imports`) cover 95% of cases, are more readable, and are statically checked.
3. **Always use absolute paths in `files`** — `fs.exists` receives absolute paths from checks. Build keys with `nodePath.resolve(projectRoot, relativePath)` or use `makeFile().absolutePath`.
4. **`syntax.canProcess` defaults to true for common code extensions** — if your check uses `.ts` files, you don't even need to set it. Only override when testing the "no backend registered" path or using non-standard extensions.
5. **Errors become empty arrays** — the runner catches check errors and returns `[]`. In tests, verify this behaviour explicitly by checking for `toHaveLength(0)`, not by calling a check that throws.

---

## License

MIT
