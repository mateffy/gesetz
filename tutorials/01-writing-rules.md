# Writing Rules with Gesetz

A Gesetz rule is not a YAML file or a JSON schema. It is a TypeScript function you write, test, and version-control alongside your code. This tutorial explains every building block, from the simplest file-system check to a fully custom AST-based rule backed by a language adapter. By the end, you will be able to write any rule your team can describe in a sentence.

---

## Table of contents

1. [The mental model](#1-the-mental-model)
2. [Your first rule with `select`](#2-your-first-rule-with-select)
3. [Checks: the atomic unit of analysis](#3-checks-the-atomic-unit-of-analysis)
4. [File-system checks](#4-file-system-checks)
5. [Pattern checks (regex)](#5-pattern-checks-regex)
6. [Structure checks (size, nesting, comments)](#6-structure-checks-size-nesting-comments)
7. [Import and call checks](#7-import-and-call-checks)
8. [Writing a custom check from scratch](#8-writing-a-custom-check-from-scratch)
9. [Using the SyntaxTree service](#9-using-the-syntaxtree-service)
10. [Architecture rules (`defineArchitecture`)](#10-architecture-rules-definearchitecture)
11. [Testing a rule](#11-testing-a-rule)
12. [Full walkthrough: a custom React hook rule](#12-full-walkthrough-a-custom-react-hook-rule)

---

## 1. The mental model

Gesetz separates **what to scan** from **what to enforce**.

- **`select(pattern)`** says *which files* the rule looks at.
- **`.check(...)`** says *what must be true* about each file.
- The result is a **`Rule`**, which the runner executes.

A `Rule` is an object with four fields:

```ts
interface Rule {
  id: string;              // machine slug, e.g. "no-console-log"
  description: string;      // human label
  category?: string;        // scoring bucket, e.g. "cleanup"
  guidance?: RuleGuidance;  // agent-facing what/do/dont hints
  run: Effect.Effect<Violation[], never, ...>;  // the actual work
}
```

The `run` Effect is the heart. It has access to services (`FileSystem`, `SyntaxTree`, `ImportResolver`, `ProjectRoot`) that are injected at runtime. You never instantiate these yourself; you declare them as dependencies via `yield*` inside `Effect.gen`, and the CLI provides them when the rule runs.

This is **dependency injection by capability**: a rule says "I need to read files" or "I need to parse imports," and the runner wires the implementation.

---

## 2. Your first rule with `select`

The `select` function creates a fluent selector. Chain methods, then terminate with `.check(...)` to produce a `Rule`.

```ts
import { select, requireSibling } from 'gesetz';

export const everyPageNeedsMeta = select('app/**/*.tsx')
  .exclude('**/*.test.tsx', '**/layout.tsx')
  .label('Every page needs a metadata file')
  .category('organization')
  .guidance({
    what: 'Pages must declare SEO metadata in a sibling .meta.ts file.',
    do: 'Create PageName.meta.ts next to the page component.',
    dont: 'Inline metadata into the page component itself.',
  })
  .check(requireSibling('.meta.ts'));
```

Let us unpack every call:

- **`select('app/**/*.tsx')`** — glob pattern relative to `projectRoot`. Files are discovered via fast-glob.
- **`.exclude(...)` — additional patterns to remove from the matched set. Applied after globbing.
- **`.label(...)` — human description. It is also **slugified** into the rule ID (`'every-page-needs-a-metadata-file'`). If you do not call `.label()`, the ID is derived from the glob patterns.
- **`.category(...)` — scoring bucket. All violations from this rule roll into the `organization` score (0–10). Omitting it means the rule runs but does not affect scoring.
- **`.guidance(...)` — three short sentences for AI agents and `gesetz list` output. `what` describes the problem, `do` describes the fix, `dont` describes the anti-pattern.
- **`.check(...)` — terminates the builder and returns a `Rule`. You can pass multiple checks; they all run on every matched file.

---

## 3. Checks: the atomic unit of analysis

A `Check` is a function from one `File` to an `Effect` that produces `Violation[]`:

```ts
type Check = (file: File) => Effect.Effect<
  Violation[],
  never,
  FileSystem | SyntaxTree | ImportResolver | ProjectRoot
>;
```

Notice the error channel is `never`. Checks must not throw. They absorb internal failures and convert them into violations or empty arrays. This is a hard contract: a broken check must not crash the runner.

The `File` object carries everything you need:

```ts
interface File {
  path: string;         // repo-relative, e.g. "src/components/Foo.tsx"
  absolutePath: string; // absolute on disk
  name: string;         // "Foo.tsx"
  stem: string;         // "Foo"
  ext: string;          // ".tsx"
  dir: string;          // "src/components"
  content: string;      // full UTF-8 source
  size: number;         // bytes
  mtimeMs: number;      // last modified
}
```

A `Violation` is a plain object:

```ts
interface Violation {
  rule: string;         // rule ID (auto-filled by select)
  message: string;       // human-readable
  path: string;         // repo-relative path
  line?: number;        // 1-indexed, optional
  column?: number;      // optional
  severity: 'error' | 'warn' | 'info';
  context?: string;     // optional extra detail
  fix?: string;         // optional suggested replacement
  source: 'core' | 'eslint' | 'phpstan' | 'oxlint' | 'custom';
}
```

When you use `.check()` inside `select`, the rule ID is automatically injected into every violation's `rule` field, so you do not have to repeat it in each check.

---

## 4. File-system checks

These checks read neighboring files and directories. They do not parse source code; they work on any file type.

### `requireSibling(suffix)`

Ensures a file with the same stem and a given suffix exists in the same directory.

```ts
select('src/components/**/*.tsx')
  .exclude('**/*.stories.tsx', '**/*.test.tsx')
  .label('Components need stories')
  .check(requireSibling('.stories.tsx'));
```

If `src/components/Button.tsx` exists but `src/components/Button.stories.tsx` does not, the violation message is:

```
Missing sibling file: Button.stories.tsx
```

### `requireChildren(paths)`

Ensures the directory containing the matched file also contains specific files. Applied per-file, so if you target `src/modules/**/index.ts`, every module's `index.ts` triggers a check that the module directory has the required children.

```ts
select('src/modules/**/index.ts')
  .label('Modules must have standard structure')
  .check(requireChildren(['types.ts', 'hooks.ts']));
```

### `forbidFile()`

Flags any matched file as a violation. Use this with an inverted glob to ban files by pattern.

```ts
select('src/**/node_modules/**')
  .label('No nested node_modules')
  .check(forbidFile());
```

### `relativeImports()`

Verifies that every relative import in the file resolves to an existing file. It tries `.ts`, `.tsx`, `/index.ts`, and `/index.tsx` variants.

```ts
select('src/**/*.{ts,tsx}')
  .label('Relative imports must resolve')
  .check(relativeImports());
```

---

## 5. Pattern checks (regex)

These are the simplest checks: scan the file content with a regular expression. No parser needed. Works on any language.

### `noPattern(regex)`

Fails when the file contains a match.

```ts
select('src/**/*.php')
  .label('No legacy helper calls')
  .check(noPattern(/legacy_helper\(/, {
    message: 'Use modern_helper() instead of legacy_helper().',
  }));
```

By default it scans line-by-line and reports line numbers. Pass `fullFile: true` for whole-file matching (useful for multi-line patterns) — in that case, no line number is reported.

### `requirePattern(regex)`

Fails when the file does **not** contain a match.

```ts
select('src/**/*.php')
  .label('PHP files must declare strict types')
  .check(requirePattern(/declare\(strict_types=1\)/, {
    message: 'Add declare(strict_types=1) at the top of the file.',
  }));
```

---

## 6. Structure checks (size, nesting, comments)

These checks analyze text-level properties. They do not use a parser, so they work on any language, but they are less precise than AST checks.

### `noGodFile({ maxLines })`

Flags files exceeding a line count. Default max is 400.

```ts
select('src/**/*.{ts,tsx,php,py}')
  .label('Files should stay under 400 lines')
  .category('structure')
  .check(noGodFile({ maxLines: 400 }));
```

### `noDeepNesting({ maxLevels })`

Heuristic nesting detector. Counts indentation (spaces / tabs) and flags lines deeper than `maxLevels`. Default is 4. This is a heuristic, not an AST analysis — it catches visual nesting including object literals and chained calls, but may misclassify heavily-indented data definitions.

```ts
select('src/**/*.ts')
  .label('Avoid deep nesting')
  .check(noDeepNesting({ maxLevels: 4 }));
```

### `noDebugLogging()`

Extension-aware debug function detector. It maps file extensions to known debug calls:

| Extension | Functions flagged |
|---|---|
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | `console.log`, `console.debug`, `console.info`, `console.warn`, `console.error`, `console.dir`, `console.table`, `console.trace` |
| `.py` | `print`, `pprint`, `breakpoint` |
| `.php` | `var_dump`, `print_r`, `dd`, `dump`, `debug` |
| `.go` | `fmt.Println`, `fmt.Printf`, `log.Println`, `log.Printf` |
| `.rs` | `println!`, `eprintln!`, `dbg!` |
| `.rb` | `puts`, `p`, `pp` |

```ts
select('src/**/*')
  .label('No debug logging in production')
  .category('cleanup')
  .check(noDebugLogging({ severity: 'warn' }));
```

Unknown extensions silently pass (no violations). Use `extraNames` to add custom functions for all extensions.

### `noConsoleLog()` and `noEmptyCatch()`

TypeScript-specific regex checks. These live in `@gesetz/core` for historical reasons but only really make sense for JS/TS files.

### `noMagicNumbers({ ignore })`

Flags numeric literals that are not assigned to `SCREAMING_SNAKE_CASE` constants. Default allowed numbers: `0, 1, -1, 2, 100`.

```ts
select('src/**/*.ts')
  .label('Avoid magic numbers')
  .check(noMagicNumbers({ ignore: [0, 1, 100, 1000] }));
```

### `noTrivialComment()`

Flags narrative comments that restate the code (`// Import React`, `// Define the component`, `// Return JSX`). These are common AI-generated residue.

```ts
select('src/**/*.{ts,tsx}')
  .label('Remove trivial comments')
  .category('cleanup')
  .check(noTrivialComment());
```

### `noDebuggingResidueFiles()`

Flags file names that look like debug artefacts: `*_v2.ts`, `*_backup.ts`, `*_fixed.ts`, `*_copy.ts`, `*_old.ts`, `*_new.ts`, `*_temp.ts`, etc.

```ts
select('src/**/*.{ts,tsx,js,jsx,php,py}')
  .label('Clean up debugging artefacts')
  .check(noDebuggingResidueFiles());
```

### `noHardcodedSecret()`

Heuristic secret detector. Matches patterns like `api_key = "..."`, `token: "..."`, `password = "..."`. This is a coarse net, not a replacement for `git-secrets` or TruffleHog. Use it to catch obvious accidents during development.

```ts
select('src/**/*')
  .label('No hardcoded secrets')
  .category('security')
  .check(noHardcodedSecret());
```

---

## 7. Import and call checks

These checks use the `SyntaxTree` service when a backend is registered, falling back to regex for unregistered extensions.

### `noImportFrom(module)`

Bans importing from a specific module (exact match or prefix).

```ts
select('src/**/*.tsx')
  .label('Use SDK hooks instead of react-query directly')
  .check(noImportFrom('@tanstack/react-query', {
    message: 'Import from @internal/sdk-hooks instead.',
  }));
```

Also accepts a RegExp:

```ts
select('src/**/*.ts')
  .label('No generated SDK internals')
  .check(noImportFrom(/sdk\/generated/));
```

### `requireImportFrom(module)`

Requires that a file imports from a specific module at least once.

```ts
select('src/**/*.test.ts')
  .label('Tests must import vitest')
  .check(requireImportFrom('vitest'));
```

### `noDirectCalls(names)`

Bans specific function calls by name. **Requires a SyntaxBackend** for the file's extension. Uses `SyntaxTree.extractCalls` to get precise call names including member access (`console.log`, `dd`).

```ts
select('src/**/*.{ts,tsx}')
  .label('No eval or dangerous calls')
  .category('security')
  .check(noDirectCalls(['eval', 'Function', 'setInnerHTML']));
```

If no backend is registered, `canProcess(file)` returns `false` and the check returns an empty array. This means the rule does not run — it does not silently pass or fail. If you want to ensure the rule always runs, register the right adapters.

---

## 8. Writing a custom check from scratch

If the built-in checks do not cover your convention, write your own. A check is just a function returning an `Effect.Effect<Violation[], never, ...>`.

### The simplest possible check

```ts
import { Effect } from 'effect';
import type { Check, Violation } from 'gesetz';

export function noFooInComments(): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.includes('//') && line.toLowerCase().includes('foo')) {
          violations.push({
            rule: '',           // filled by select()
            severity: 'warn',
            source: 'core',
            message: `Do not mention 'foo' in comments: ${line.trim()}`,
            path: file.path,
            line: i + 1,
          });
        }
      }

      return violations;
    });
}
```

Use it:

```ts
select('src/**/*.ts')
  .label('No foo in comments')
  .check(noFooInComments());
```

### A check that reads the file system

```ts
import { Effect } from 'effect';
import { FileSystem } from 'gesetz';
import * as nodePath from 'node:path';
import type { Check, Violation } from 'gesetz';

export function requireReadme(): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const dir = nodePath.dirname(file.absolutePath);
      const readmePath = nodePath.join(dir, 'README.md');
      const exists = yield* fs.exists(readmePath);

      if (exists) return [];

      return [{
        rule: '',
        severity: 'error',
        source: 'core',
        message: `Directory missing README.md: ${file.dir}`,
        path: file.path,
      }];
    });
}
```

Notice `yield* FileSystem`. This declares a runtime dependency. The check will only work inside an Effect context that provides a `FileSystem` implementation. The CLI does this automatically.

---

## 9. Using the SyntaxTree service

When you need precise AST analysis — imports, exports, function calls, class structure — use the `SyntaxTree` service. It is backed by language adapters that you register in `gesetz.config.ts`.

### How it works

1. You import adapters and pass them to `defineConfig({ adapters: [...] })`.
2. The CLI builds a **router** (`SyntaxTreeLive`) that maps file extensions to backends.
3. Inside your check, `yield* SyntaxTree` gives you the router.
4. Call `st.canProcess(file)` to check if a backend exists for the file's extension.
5. Call `st.process(file, { imports: true, calls: true, exports: true, structure: true })` to get parsed data.

### Available data shapes

```ts
interface ParsedImport {
  specifier: string;   // "react", "./foo", "Illuminate\\Models\\User"
  names: string[];     // ["useState", "useEffect"]
  line: number;        // 1-indexed
}

interface ParsedCall {
  name: string;        // "console.log", "dd", "fmt.Println"
  line: number;
}

interface ParsedExport {
  name: string;        // "doThing", "UserService"
  kind: string;        // "function", "class", "const", "type", "interface", "enum"
  line: number;
}

interface StructureItem {
  kind: string;        // "function", "class", "method", "interface"
  name: string;
  startLine: number;
  endLine: number;
  docstring: string | null;
  children: StructureItem[];
}
```

### Example: custom import whitelist

```ts
import { Effect } from 'effect';
import { SyntaxTree } from 'gesetz';
import type { Check, Violation } from 'gesetz';

const ALLOWED_INTERNAL = new Set(['@internal/core', '@internal/ui']);

export function onlyAllowedInternalImports(): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { imports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      const violations: Violation[] = [];
      for (const imp of result.imports) {
        if (imp.specifier.startsWith('@internal/') && !ALLOWED_INTERNAL.has(imp.specifier)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `Unauthorized internal import: ${imp.specifier}`,
            path: file.path,
            line: imp.line,
          });
        }
      }
      return violations;
    });
}
```

Use it:

```ts
select('src/**/*.ts')
  .label('Only approved internal packages')
  .check(onlyAllowedInternalImports());
```

### Important: always catch `SyntaxTree` failures

`st.process()` can fail with `SyntaxTreeError` (parse errors or no backend). If you do not catch it, the check fails and the runner converts it into a special violation. It is safer to catch and return an empty array:

```ts
const result = yield* st.process(file, { calls: true }).pipe(
  Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
);
```

This is the pattern used by every built-in `SyntaxTree`-backed check.

---

## 10. Architecture rules (`defineArchitecture`)

Beyond per-file checks, Gesetz can enforce **layered architecture** constraints: which layers may import from which other layers, and which external packages are banned per layer.

### Define layers

```ts
import { defineArchitecture } from 'gesetz';

const arch = defineArchitecture({
  layers: [
    { name: 'entry',  pattern: 'src/cli/**',       canImportFrom: ['core', 'util'] },
    { name: 'core',   pattern: 'src/core/**',      canImportFrom: ['util'] },
    { name: 'util',   pattern: 'src/utils/**',     canImportFrom: [] },
  ],
  bannedExternals: {
    util: ['react', 'react-dom'],
  },
});
```

This means:
- CLI entry points may import from `core` and `util`.
- Core may import from `util` only.
- Utils may not import from anything inside `src/` (they are the bottom layer).
- No file in `util` may import React.

### Forbidden pairs

For one-off exceptions, use explicit forbidden pairs:

```ts
const arch = defineArchitecture({
  layers: [
    { name: 'ui',     pattern: 'src/ui/**',        canImportFrom: ['domain', 'infra'] },
    { name: 'domain', pattern: 'src/domain/**',    canImportFrom: ['infra'] },
    { name: 'infra',  pattern: 'src/infra/**',     canImportFrom: [] },
  ],
  forbidden: [
    { from: 'domain', to: 'ui', message: 'Domain must not depend on UI presentation layer.' },
  ],
});
```

### How it resolves imports

`defineArchitecture` uses the `SyntaxTree` service for import extraction (with a JS/TS regex fallback), and the `ImportResolver` service to map relative specifiers to absolute file paths. It then tries extension variants (`.ts`, `.tsx`, `.js`, `.jsx`, `.php`, `/index.ts`, etc.) to find which layer the target belongs to.

If you use TypeScript path mappings (`@/foo` → `src/foo`), provide a custom `ImportResolver` layer that resolves them. The default resolver only handles relative paths (`./foo`, `../bar`).

---

## 11. Testing a rule

Rules are pure functions returning Effects. You can test them with Vitest (or any test runner) by providing a minimal Layer and running the Effect.

### Testing a regex-based check

```ts
import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { noGodFile } from 'gesetz';
import type { File } from 'gesetz';

function makeFile(content: string, path = 'src/foo.ts'): File {
  return {
    path,
    absolutePath: `/abs/${path}`,
    name: 'foo.ts',
    stem: 'foo',
    ext: '.ts',
    dir: 'src',
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

const run = (effect: Effect.Effect<unknown, unknown, unknown>) =>
  Effect.runPromise(effect);

describe('noGodFile', () => {
  it('passes when file is under the limit', async () => {
    const file = makeFile('line\n'.repeat(399));
    const violations = await run(noGodFile({ maxLines: 400 })(file));
    expect(violations).toHaveLength(0);
  });

  it('fails when file exceeds the limit', async () => {
    const file = makeFile('line\n'.repeat(400));
    const violations = await run(noGodFile({ maxLines: 400 })(file));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('400');
  });
});
```

### Testing a SyntaxTree-backed check

For checks that use `yield* SyntaxTree`, you need a test Layer that provides mock data. Gesetz exports `makeSyntaxTreeLayer` for this:

```ts
import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import { noDirectCalls, SyntaxTree } from 'gesetz';
import type { File } from 'gesetz';

function makeFile(name = 'foo.ts'): File {
  return {
    path: `src/${name}`,
    absolutePath: `/abs/src/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: '.' + name.split('.').pop()!,
    dir: 'src',
    content: 'irrelevant — SyntaxTree is stubbed',
    size: 0,
    mtimeMs: 0,
  };
}

function makeSyntaxTreeLayer(result: Partial<{
  imports: { specifier: string; names: string[]; line: number }[];
  calls: { name: string; line: number }[];
  exports: { name: string; kind: string; line: number }[];
  structure: { kind: string; name: string; startLine: number; endLine: number; docstring: string | null; children: unknown[] }[];
}>) {
  const full = {
    imports: result.imports ?? [],
    calls: result.calls ?? [],
    exports: result.exports ?? [],
    structure: result.structure ?? [],
  };
  return Layer.succeed(SyntaxTree, {
    canProcess: () => true,
    process: (_file, _opts) => Effect.succeed(full),
  });
}

const run = (effect: Effect.Effect<unknown, unknown, SyntaxTree>, layer: Layer.Layer<unknown>) =>
  Effect.provide(effect, layer).pipe(Effect.runPromise);

describe('noDirectCalls', () => {
  it('flags banned calls', async () => {
    const layer = makeSyntaxTreeLayer({
      calls: [{ name: 'eval', line: 3 }],
    });
    const violations = await run(noDirectCalls(['eval'])(makeFile()), layer);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });
});
```

This test is fast: no real parser runs, no file system touches. You control the AST output and verify that your check logic transforms it into the right violations.

---

## 12. Full walkthrough: a custom React hook rule

Let us write a complete rule from scratch: **"Every `useFoo` hook must have a matching `useSuspenseFoo` and `useCachedFoo` exported from the same file."**

### Step 1: Write the check

```ts
// rules/require-related-hooks.ts
import { Effect } from 'effect';
import { SyntaxTree } from 'gesetz';
import type { Check, Violation } from 'gesetz';

export function requireRelatedHooks(): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { exports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      // Only consider function exports whose name starts with "use"
      const hooks = result.exports.filter(e => e.kind === 'function' && e.name.startsWith('use'));
      if (hooks.length === 0) return [];

      const exportNames = new Set(result.exports.map(e => e.name));
      const violations: Violation[] = [];

      for (const hook of hooks) {
        const base = hook.name.slice(3); // remove "use" prefix
        const suspenseName = `useSuspense${base}`;
        const cachedName = `useCached${base}`;

        if (!exportNames.has(suspenseName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `Hook '${hook.name}' is missing related export '${suspenseName}'`,
            path: file.path,
            line: hook.line,
          });
        }
        if (!exportNames.has(cachedName)) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `Hook '${hook.name}' is missing related export '${cachedName}'`,
            path: file.path,
            line: hook.line,
          });
        }
      }

      return violations;
    });
}
```

### Step 2: Wire it into a rule

```ts
// gesetz.config.ts
import { defineConfig, select } from 'gesetz';
import { typescriptSyntaxBackend } from '@gesetz/typescript';
import { requireRelatedHooks } from './rules/require-related-hooks';

export default defineConfig({
  adapters: [typescriptSyntaxBackend],
  rules: [
    select('src/hooks/**/*.ts')
      .exclude('**/*.test.ts', '**/index.ts')
      .label('Every useX hook needs useSuspenseX and useCachedX')
      .category('organization')
      .guidance({
        what: 'Data hooks must expose three variants: eager, suspense, and cached.',
        do: 'Export useSuspenseFoo and useCachedFoo alongside useFoo.',
        dont: 'Export only the eager hook and leave callers without async options.',
      })
      .check(requireRelatedHooks()),
  ],
});
```

### Step 3: Test it

```ts
// rules/require-related-hooks.test.ts
import { describe, it, expect } from 'vitest';
import { Effect, Layer } from 'effect';
import { SyntaxTree } from 'gesetz';
import { requireRelatedHooks } from './require-related-hooks';
import type { File } from 'gesetz';

function makeFile(name: string, exports: { name: string; kind: string; line: number }[]): File {
  return {
    path: `src/hooks/${name}`,
    absolutePath: `/abs/src/hooks/${name}`,
    name,
    stem: name.replace(/\.[^.]+$/, ''),
    ext: '.ts',
    dir: 'src/hooks',
    content: '',
    size: 0,
    mtimeMs: 0,
  };
}

function makeLayer(exports: { name: string; kind: string; line: number }[]) {
  return Layer.succeed(SyntaxTree, {
    canProcess: () => true,
    process: () => Effect.succeed({ imports: [], calls: [], exports, structure: [] }),
  });
}

const run = (eff: Effect.Effect<unknown, unknown, SyntaxTree>, layer: Layer.Layer<unknown>) =>
  Effect.provide(eff, layer).pipe(Effect.runPromise);

describe('requireRelatedHooks', () => {
  it('passes when all related hooks exist', async () => {
    const layer = makeLayer([
      { name: 'useUser', kind: 'function', line: 1 },
      { name: 'useSuspenseUser', kind: 'function', line: 10 },
      { name: 'useCachedUser', kind: 'function', line: 20 },
    ]);
    const v = await run(requireRelatedHooks()(makeFile('useUser.ts', [])), layer);
    expect(v).toHaveLength(0);
  });

  it('fails when suspense hook is missing', async () => {
    const layer = makeLayer([
      { name: 'useUser', kind: 'function', line: 1 },
      { name: 'useCachedUser', kind: 'function', line: 20 },
    ]);
    const v = await run(requireRelatedHooks()(makeFile('useUser.ts', [])), layer);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('useSuspenseUser');
  });
});
```

### What we just built

A rule that:
- Targets only hook files (`src/hooks/**/*.ts`).
- Parses exports via the TypeScript backend.
- Enforces a team convention (three hook variants).
- Reports line numbers pointing to the offending export.
- Is fully unit-tested without touching the file system or a real parser.

This pattern generalizes to any convention you can express as "for every X, check that Y also exists."

---

## Summary

| If you want to... | Use |
|---|---|
| Ban files by name or path | `forbidFile()` with an inverted glob |
| Require sibling files | `requireSibling()` |
| Require directory contents | `requireChildren()` |
| Match / ban regex patterns | `noPattern()`, `requirePattern()` |
| Check file size or nesting | `noGodFile()`, `noDeepNesting()` |
| Ban debug calls by extension | `noDebugLogging()` |
| Ban imports from a module | `noImportFrom()` |
| Require imports from a module | `requireImportFrom()` |
| Ban specific function calls | `noDirectCalls()` (needs adapter) |
| Enforce export relationships | `requireRelatedExports()` (needs adapter) |
| Enforce naming conventions | `requireNamingConvention()` (needs adapter) |
| Check layer architecture | `defineArchitecture()` |
| Anything else | Write a custom `Check` function |

The boundary between "use a built-in" and "write custom" is simple: if you can describe it as a regex, file-system query, or one of the pre-defined AST queries, use the built-in. If your convention is domain-specific (like the three-variant hook rule above), write a custom check. Both compile to the same `Rule` type and run in the same pipeline.
