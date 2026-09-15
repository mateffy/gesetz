# Upgrade Notes

This document lists breaking changes between versions of `gesetz` and explains how to migrate existing code. Each section is keyed by the version where the breaking change was introduced. Newest first.

If you are a coding agent tasked with upgrading a codebase, read the section for the version you are upgrading **to**, then work backwards through any older sections that apply to the current state of the code.

---

## v3.0 — Incremental cache engine (no netzwerk)

### One-line summary

The rule-execution backend now runs on a built-in incremental cache in
`@gesetz/core`. Rules are evaluated per file, results are stored in a
content-hash cache (SQLite via Node's built-in `node:sqlite`), and
`gesetz check` re-checks only changed files on repeat runs. **The public API is
unchanged** — no migration needed for configs, custom checks, or adapters.

### What changed for consumers

- `gesetz check` persists a cache in **one shared file outside your
  repositories**: `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`. Nothing needs to
  be gitignored, and clearing it is `rm -rf ~/.cache/gesetz`. Entries are
  namespaced by project root, so projects never see each other's results, and
  entries untouched for 30 days are swept on open. `GESETZ_DB` overrides the
  location, `GESETZ_DB=off` disables persistence, `--full` bypasses the cache,
  and `--watch` re-runs incrementally on file changes. If you previously added
  `.gesetz/` to a `.gitignore` for gesetz, you can drop it.
- **A tool adapter that cannot run is now a critical violation instead of a
  silent pass.** ESLint, oxlint, Vitest, PHPStan, and friends previously
  swallowed a failed tool invocation and contributed no violations. They now
  fail the run, report `failedRules` in the JSON envelope and status banner, and
  are retried on the next invocation (failures are never cached). Pass
  `--throw` (or `runAll(config, { throwOnRuleError: true })`) to abort with the
  full error instead. Note that a non-zero exit is still normal — linters exit
  non-zero when they find violations.
- `execTool` changed contract: it used to return `''` when the tool could not be
  started; it now throws. Callers that relied on the empty string must catch.
- `runAll` results gained an optional `failedRules: string[]` field.
- **`storage` is simpler, and now authoritative for both `gesetz check` and
  `runAll`.** It is `{ kind: 'memory' }` or `{ kind: 'sqlite', path }` — the
  `json` kind and the `driver` field are gone. Omit it to accept the default
  (CLI: the shared cache; programmatic `runAll`: memory). Precedence for
  `gesetz check` is `--full` / `GESETZ_DB=off` → config `memory` →
  `GESETZ_DB=<path>` → config `sqlite` path → the shared cache →
  `<root>/.gesetz/cache.db`. A relative `storage.path` is resolved against
  `projectRoot`.
- **Per-file results are invalidated when the file set changes.** Checks are not
  pure functions of one file — `requireSibling` reads the project's listing, as
  do `requireChildren`, `forbidFile`, `fs.glob`, and `imports.resolve`. Adding,
  removing, or renaming a file therefore recomputes all per-file results;
  editing a file still only re-checks that file.
- Persistence needs a SQLite driver: the built-in `node:sqlite` on Node ≥ 23.4
  (or ≥ 22.5 with `--experimental-sqlite`), otherwise a driver registered by
  `@gesetz/sqlite-compat`. With neither, the run continues **without a cache**
  and says so once. The JSON fallback adapter was removed.
- Custom cache drivers can be registered with `registerCacheDriver('sqlite', factory)`;
  `createSqliteStoreFromDatabase(db)` builds a store over any
  better-sqlite3-shaped database. Driver selection is automatic — it is not a
  user-facing setting.
- `runAll(config, options?)` accepts an optional second argument
  (`{ fileFilter, onScan, throwOnRuleError }`). The Effect service environment is
  no longer required — providing it is harmless but ignored.
- Violations are reported with repo-relative paths consistently (external-tool
  adapters that emitted absolute paths are normalized).
- Files excluded by `.gitignore` (e.g. `dist/`) are not scanned — gesetz asks
  git for the file list. Outside a git repository gesetz walks the directory
  tree and cannot honour `.gitignore`.
- Files larger than 64 KB are no longer skipped. The previous backend silently
  ignored them.
- **Adapter `cwd` and `bin` are resolved at run time against the project
  root.** Relative options like `vitest({ cwd: 'packages/web' })` previously
  resolved against `process.cwd()` while the config was evaluated, so they broke
  under `--project-root`. Adapters now also prefer a tool installed relative to
  their working directory and fall back to `PATH`, so `oxlint()` no longer
  requires `oxlint` to be on `PATH`. An explicit `bin` still wins.
- **`--project-root` now selects the scanned tree.** It previously only located
  the config file; the scan root came from `defineConfig()`, which defaults to
  `process.cwd()`. Running `gesetz check --project-root ./packages/web` from the
  repo root therefore scanned the repo root. An explicit flag now overrides the
  config's `projectRoot`; when the flag is omitted, a config that sets its own
  `projectRoot` is still honoured.
- New, additive SDK helpers: `select(glob, { exclude, category, label })` and
  `group(category, rules)`.

### What did NOT change

- `select()`, `defineConfig()`, `runAll()`, `defineArchitecture()`,
  `noCycles()`, all `@gesetz/*` check factories and tool adapters — same
  signatures, same `Violation` shape, same scoring formula.
- `--since`, `--files`, `--category`, exemptions, and thresholds behave as
  before (aggregation-time filters over cached results).
- `Rule`, `Rule.project`, and `Rule.perFile` keep their shapes. `ProjectRuleContext`
  no longer carries a `network` field — it exposes `{ rootDir, changedFiles }`,
  and no adapter used the field it replaced.
- The `netzwerk` runtime dependency is gone. `@gesetz/core` depends only on
  `effect`, `fast-glob`, and `micromatch`.

---

## v2.0 — Check API migration from Effect to async/await

### One-line summary

The `Check` type changed from returning `Effect.Effect<Violation[], never, ...>` to returning `Promise<Violation[]>`. Services (`FileSystem`, `SyntaxTree`, `ImportResolver`) are now passed as a second argument bag instead of being pulled from Effect context via `yield*`. The builder (`select(...).check(...)`) and runner (`runAll`) remain unchanged.

### Before and after

| | Before | After |
|---|---|---|
| **Type** | `Check = (file) => Effect.Effect<Violation[], never, FileSystem \| SyntaxTree \| ImportResolver \| ProjectRoot>` | `Check = (file, services) => Promise<Violation[]>` |
| **Services** | `yield* FileSystem`, `yield* SyntaxTree`, `yield* ImportResolver` | `services.fs`, `services.syntax`, `services.imports` |
| **Sync check** | `Effect.sync(() => { ... })` | `async (file) => { ... }` |
| **Async check** | `Effect.gen(function* () { ... })` | `async (file, services) => { ... }` |
| **Violation.rule** | `rule: ''` required as placeholder | `rule` is optional — builder injects it |

### What did NOT change

- `select(...).check(...)` — the fluent builder API is identical
- `Rule.run` — still `Effect.Effect<Violation[], never, ...>` internally
- `runAll` — still orchestrates rules with Effect internally
- `defineArchitecture`, `noCycles` — still return `Rule[]` objects with internal Effect runners
- All built-in checks (`noGodFile`, `noImportFrom`, `noDirectCalls`, `noConsoleLog`, etc.) — migrated in the package already
- Language adapters (`typescriptSyntaxBackend`, `phpSyntaxBackend`) — still export plain `SyntaxBackend` objects

### What changed for consumers

Only **custom checks you wrote yourself** and **tests for those checks** need migration. If your `gesetz.config.ts` only uses built-in checks from the packages, no changes are needed.

### Migration: custom check functions

#### Pattern A — Pure sync check (no services needed)

**Before:**
```ts
import { Effect } from 'effect';
import type { Check, Violation, File } from 'gesetz';

export function noFooInComments(): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.includes('//') && line.toLowerCase().includes('foo')) {
          violations.push({
            rule: '',
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

**After:**
```ts
import type { Check, Violation } from 'gesetz';

export function noFooInComments(): Check {
  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.includes('//') && line.toLowerCase().includes('foo')) {
          violations.push({
            severity: 'warn',
            source: 'core',
            message: `Do not mention 'foo' in comments: ${line.trim()}`,
            path: file.path,
            line: i + 1,
          });
        }
      }

      return violations;
  };
}
```

**Changes to make:**
1. Remove `import { Effect } from 'effect'`
2. Replace `Effect.sync(() => { ... })` with `async (file) => { ... }`
3. Remove `rule: ''` from every violation object — the builder injects the rule ID

#### Pattern B — FileSystem service check

**Before:**
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

**After:**
```ts
import * as nodePath from 'node:path';
import type { Check, Violation } from 'gesetz';

export function requireReadme(): Check {
  return async (file, { fs }) => {
    const dir = nodePath.dirname(file.absolutePath);
    const readmePath = nodePath.join(dir, 'README.md');
    const exists = await fs.exists(readmePath);

    if (exists) return [];

    return [{
      severity: 'error',
      source: 'core',
      message: `Directory missing README.md: ${file.dir}`,
      path: file.path,
    }];
  };
}
```

**Changes to make:**
1. Remove `import { Effect } from 'effect'` and `import { FileSystem } from 'gesetz'`
2. Replace `Effect.gen(function* () { const fs = yield* FileSystem; ... })` with `async (file, { fs }) => { ... }`
3. Replace `yield* fs.exists(path)` with `await fs.exists(path)`
4. Remove `rule: ''` from violations

#### Pattern C — SyntaxTree service check

**Before:**
```ts
import { Effect } from 'effect';
import { SyntaxTree } from 'gesetz';
import type { Check, Violation } from 'gesetz';

export function noConsoleCalls(): Check {
  return (file) =>
    Effect.gen(function* () {
      const st = yield* SyntaxTree;
      if (!st.canProcess(file)) return [];

      const result = yield* st.process(file, { calls: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      const violations: Violation[] = [];
      for (const call of result.calls) {
        if (call.name.startsWith('console.')) {
          violations.push({
            rule: '',
            severity: 'error',
            source: 'core',
            message: `Forbidden call: ${call.name}()`,
            path: file.path,
            line: call.line,
          });
        }
      }
      return violations;
    });
}
```

**After:**
```ts
import type { Check, Violation } from 'gesetz';

export function noConsoleCalls(): Check {
  return async (file, { syntax }) => {
    if (!syntax.canProcess(file)) return [];

    try {
      const result = await syntax.process(file, { calls: true });

      const violations: Violation[] = [];
      for (const call of result.calls) {
        if (call.name.startsWith('console.')) {
          violations.push({
            severity: 'error',
            source: 'core',
            message: `Forbidden call: ${call.name}()`,
            path: file.path,
            line: call.line,
          });
        }
      }
      return violations;
    } catch {
      return [];
    }
  };
}
```

**Changes to make:**
1. Remove `import { Effect } from 'effect'` and `import { SyntaxTree } from 'gesetz'`
2. Replace `Effect.gen(function* () { const st = yield* SyntaxTree; ... })` with `async (file, { syntax }) => { ... }`
3. Replace `yield* st.process(...).pipe(Effect.catchAll(...))` with `try { await syntax.process(...) } catch { return [] }`
4. Remove `rule: ''` from violations

#### Pattern D — Multiple services

**Before:**
```ts
import { Effect } from 'effect';
import { FileSystem, SyntaxTree } from 'gesetz';
import type { Check, Violation } from 'gesetz';

export function complexCheck(): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const st = yield* SyntaxTree;

      const exists = yield* fs.exists('/some/path');
      const result = yield* st.process(file, { imports: true }).pipe(
        Effect.catchAll(() => Effect.succeed({ imports: [], calls: [], exports: [], structure: [] })),
      );

      // ... logic ...
    });
}
```

**After:**
```ts
import type { Check, Violation } from 'gesetz';

export function complexCheck(): Check {
  return async (file, { fs, syntax }) => {
    const exists = await fs.exists('/some/path');
    let result;
    try {
      result = await syntax.process(file, { imports: true });
    } catch {
      result = { imports: [], calls: [], exports: [], structure: [] };
    }

    // ... logic ...
  };
}
```

**Changes to make:**
- Both `fs` and `syntax` are destructured from the second argument
- No `yield*` needed — use `await` for async calls

### The `CheckServices` bag

Every check receives this as its second argument:

```ts
interface CheckServices {
  fs: {
    glob(pattern: string | string[], options?: GlobOptions): Promise<File[]>;
    readFile(absolutePath: string): Promise<string>;
    exists(absolutePath: string): Promise<boolean>;
  };
  syntax: {
    canProcess(file: File): boolean;
    process(file: File, options: SyntaxTreeProcessOptions): Promise<SyntaxBackendProcessResult>;
  };
  imports: {
    resolve(fromFile: File, specifier: string): string | null;
  };
  projectRoot: string;  // absolute path
}
```

**Destructuring pattern:** Use only what you need.

```ts
// Only need fs
async (file, { fs }) => { ... }

// Only need syntax
async (file, { syntax }) => { ... }

// Need both
async (file, { fs, syntax }) => { ... }

// Need projectRoot
async (file, { projectRoot }) => { ... }
```

### Migration: rule configuration files

If your `gesetz.config.ts` only uses **built-in checks** (e.g. `noGodFile`, `noImportFrom`, `requireSibling`), **no changes are needed**. The builder API is unchanged:

```ts
// This works exactly as before
select('src/**/*.ts')
  .label('No god files')
  .check(noGodFile({ maxLines: 400 }));
```

If your config contains **custom checks** (functions you wrote), migrate them using the patterns above.

### Migration: tests

#### Before: running checks with Effect

```ts
import { Effect } from 'effect';
import { noGodFile } from 'gesetz';

const run = (effect) => Effect.runPromise(effect);

const violations = await run(noGodFile({ maxLines: 400 })(file));
```

#### After: running checks directly

```ts
import { noGodFile } from 'gesetz';

const violations = await noGodFile({ maxLines: 400 })(file, {} as any);
```

For pure sync checks that don't need services, pass `{} as any` or `{} as CheckServices` as the second argument.

#### Before: running checks with Effect context + Layer

```ts
import { Effect, Layer } from 'effect';
import { noDirectCalls } from 'gesetz';
import { makeSyntaxTreeLayer } from 'gesetz/tests/helpers/syntax-tree';

const run = (effect, layer) =>
  Effect.provide(effect, layer).pipe(Effect.runPromise);

const violations = await run(noDirectCalls(['eval'])(file), makeSyntaxTreeLayer({ ... }));
```

#### After: using `buildCheckServices` helper

```ts
import { noDirectCalls } from 'gesetz';
import { makeSyntaxTreeLayer } from 'gesetz/tests/helpers/syntax-tree';
import { buildCheckServices } from 'gesetz/tests/helpers/services';
import { ProjectRootLive } from 'gesetz/src/services/fs';
import { ImportResolverDefault } from 'gesetz/src/services/import-resolver';

const services = await buildCheckServices(
  makeSyntaxTreeLayer({ ... }),
  ProjectRootLive('/abs'),
  ImportResolverDefault,
);

const violations = await noDirectCalls(['eval'])(file, services);
```

**Important:** `buildCheckServices` requires `FileSystem` to be available. It auto-includes an empty `MemoryFileSystem` layer, but if you need real files, pass your own `MemoryFileSystem(files)` as the first layer.

#### Alternative: manual mock services

For simple tests, construct the services manually:

```ts
const services: CheckServices = {
  fs: {
    glob: async () => [],
    readFile: async () => '',
    exists: async (path) => path === '/expected/path',
  },
  syntax: {
    canProcess: () => true,
    process: async () => ({ imports: [], calls: [], exports: [], structure: [] }),
  },
  imports: {
    resolve: () => null,
  },
  projectRoot: '/project',
};

const violations = await myCheck(file, services);
```

### The `Violation.rule` field

**Before:** Every violation had to include `rule: ''` as a placeholder. The builder overwrote it with the actual rule ID.

**After:** `rule` is optional. Omit it entirely in custom checks. The builder still injects it when the rule runs.

```ts
// Before
violations.push({
  rule: '',
  severity: 'error',
  source: 'core',
  message: '...',
  path: file.path,
});

// After
violations.push({
  severity: 'error',
  source: 'core',
  message: '...',
  path: file.path,
});
```

If you have code that creates `Violation` objects outside the builder context (e.g. in `defineArchitecture`), you may still want to set `rule` explicitly. The field is optional, not removed.

### What about `simpleCheck`?

The `simpleCheck` wrapper was explored during the v2.0 development cycle but **deleted before release**. It never shipped. If you see references to it in any internal docs or branches, ignore them. The new `Check` type *is* the simple API.

### Effect is not gone

Effect is still the runtime for the runner. Custom checks cannot access Effect primitives (fiber control, `Effect.all`, `Effect.retry`, etc.) because the `Check` signature is plain async. If you need Effect-level control, you must write a full `Rule` with a custom `run` Effect — but this is an advanced pattern for <1% of users.

For 99% of use cases, plain async/await with the `CheckServices` bag is sufficient.

### Migration checklist for agents

- [ ] Remove all `import { Effect } from 'effect'` from custom check files
- [ ] Remove all `import { FileSystem, SyntaxTree, ... } from 'gesetz'` from custom check files (unless used for types)
- [ ] Replace `Effect.sync(() => { ... })` with `async (file) => { ... }`
- [ ] Replace `Effect.gen(function* () { ... })` with `async (file, { fs, syntax, imports, projectRoot }) => { ... }`
- [ ] Replace `yield* fs.exists(path)` with `await fs.exists(path)`
- [ ] Replace `yield* st.process(...)` with `try { await syntax.process(...) } catch { ... }`
- [ ] Remove `rule: ''` from all violation objects in custom checks
- [ ] Update tests: replace `Effect.runPromise(check(file))` with `await check(file, services)`
- [ ] Update tests: use `buildCheckServices(...)` or manual mocks for service-requiring checks
- [ ] Verify `npx vitest run` passes after migration
- [ ] Verify `npx tsc --noEmit` is clean after migration

---

## v1.x

No breaking changes. Version 1.x used the original Effect-based `Check` API where checks returned `Effect.Effect<Violation[], never, FileSystem | SyntaxTree | ImportResolver | ProjectRoot>` and accessed services via `yield*` inside `Effect.gen`.
