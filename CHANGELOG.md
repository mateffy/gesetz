# Changelog

All notable changes to **Gesetz** and the `@gesetz/*` packages are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0-rc.7] — 2026-09-30

> `rc.6` taught several agents to share one worktree; this candidate teaches them
> to share one *run*. Until now a scoped check computed results only for the paths
> it was asked about, so no two agents could ever share work: every distinct
> `--files` scope was a different request, and coordination serialised. Twenty
> agents meant twenty scans and twenty runs of every tool for one tree.
>
> This entry also documents the fixes that landed in the `rc.6` candidate after its
> notes were written, so nothing ships silently.

### Added

- **A scoped check reuses a whole-tree run.** The request identity is now split
  into an *instance* (root, config, rules, thresholds, baseline, storage), a
  *scope* (the requested paths and the `--since` cut), and the scope a whole-tree
  run of that instance would have. A record from a whole-tree run answers any scope
  of the same instance, narrowed to what was asked. A record from another *narrow*
  scope is never reused, however recent — it examined other files, and reusing it
  would report this caller's files as clean without having looked at them.
  Verified: one full run, then three scoped requests at three scopes, each reused
  and each narrowed to its own scope.
- `runMs` and `reusedScope` in the envelope's `coordination` block and in the
  stderr notice: `reused a run from 2.5s ago — narrowed from a whole-tree run to
  your scope`. Coordination records are version 2; a version 1 record cannot say
  what it examined, so it is ignored.

### Changed

- **Baseline entries are identified per occurrence, by the offending line's
  content** — `hash(rule, path, message, line text)`. The count-based identity could
  not see a swap: with 48 occurrences baselined, fixing 47 and introducing one
  unrelated new occurrence left the count unchanged, so the gate passed blind to
  it. The line *number* stays out of the identity on purpose — inserting an import
  belongs to every file below it — and surrounding whitespace is normalised.
  `BASELINE_FILE_VERSION` is now 2, so an existing baseline reports as new and
  stale until it is written again: one `gesetz baseline` run per project.
- `baseline --prune` removes stale entries and adds nothing, and rewrites a kept
  entry's count to what was observed, which also tightens the gate. `--rule X`
  scopes the refusal as well as the write: an unrelated rule's new violation no
  longer blocks bookkeeping for the rule that was named.
- A record at the *same* scope is preferred over a more recent whole-tree one,
  since it needs no narrowing.

### Fixed

- **`waitedMs` reported the run's duration on the `ran` path.** It was measured from
  when the caller entered coordination, so the number that says "how long this
  waited" was really "how long this took". `waitedMs` is now only the wait, `runMs`
  is the work, and the notice prints both so they cannot be added together.
- **`takeOverIfStale` examined slot 0 only**, on reasoning that held while `jobs`
  could not exceed 1. A fleet holds slots 0..N, and a dead holder of any of them
  stranded its waiters for the whole wait timeout.
- **A scope vitest could not read ran the entire suite.** A `--files` scope of PHP
  paths is a positional pattern matching no test file, and vitest does not then run
  nothing: it falls back to its default include. Measured at 25 minutes and still
  going, twenty agents at a time — 2,528 s for a single scoped check. Patterns
  resolving outside vitest's own cwd are dropped, and when none survive the rule
  reports nothing examined instead of widening: `null` would mean "no pattern",
  which is the whole suite again.
- **A check that throws is a violation, not silence.** `select()` caught a rejected
  check and returned no findings, so a rule that threw on 137 files looked exactly
  like a rule that examined 137 clean files.
- **An exemption that names no rule silences every rule.** `{ path }` alone matches
  every rule id, so the file stops being checked by all of them and nothing said
  so. Suppressions are counted and reported now: in one real configuration this was
  124 files and 222 violations, about a third of what the run reported.
- **A cache miss under Bun crashed the run.** `bun:sqlite` returns `null` for an
  absent row where `node:sqlite` returns `undefined`, and the guard checked only
  `undefined`. `bun node_modules/.bin/gesetz` is how agents invoke it. A row with
  no usable hash, or a value that is not valid JSON, now reads as a miss so the
  value is recomputed.

## [3.0.0-rc.6] — 2026-09-28

> The engine of `3.0.0-rc.5` (no `netzwerk`) with everything learned since put back
> on top of it. `rc.5` had the cache but none of the orchestration: no request
> scoping, no adapter or test scoping, no baseline, no coordination between
> agents. This candidate restores all of it, and fixes the defects the merge
> surfaced in a real 13,711-file repository.

### Added

- **Several `gesetz check` processes in one worktree now share one run.** A second
  caller waits for the run in flight and reuses its result when that result covers
  the tree state it was about to check — keyed on observed state, never on
  recency. `--standalone` (and `--full`, and `GESETZ_LOCK=off`) opt out; `--jobs N`
  lets N run at once; `--wait-timeout S` bounds the wait. Every run reports what it
  did on stderr, and `--format=json` carries an additive `coordination` block.
- **`--files` reduces work, not just the report.** Rules that cannot match the
  request are not run, files outside it keep their cached results, and adapters
  hand their tool only the requested paths. Accepts globs, commas, and repetition.
- **Test scoping.** The vitest adapter runs the tests that cover the files in play
  instead of the whole suite: 56.2 s → 10.8 s for one test file, measured.
- **`bun:sqlite`** is used under Bun, which has no `node:sqlite`. Without it every
  `bun node_modules/.bin/gesetz` run reported "SQLite caching is unavailable" and
  re-checked the project.

### Changed

- **`Rule.patterns` are resolved against the project root**, even when the adapter
  runs its tool in a `cwd`. A rule that declares patterns matching no file in a
  project that has files is **no longer cached** — its key would be a constant, so
  its first result would be served for ever — and it is named on stderr.
- A warm run decides reuse by `mtimeMs:size` first and only reads a file whose
  stamp moved. In the repository this was measured on: warm scan 31.8 s → **289 ms**
  over 13,711 files; a repeat `--files` run 14.6 s → **3 ms**.
- File contents are read lazily, as files are computed, instead of all at once.

### Fixed

- `EISDIR` aborted a whole run: git lists symlinks *to directories* as files
  (Laravel's `public/storage`), and reading one threw. Skipped now, like `ENOENT`.
  Anything else still throws — an unreadable file must not look checked.
- A stale adapter result could be served indefinitely when its patterns matched
  nothing (see above). `cached` and `--full` now agree.
- `oxlint`, `phpstan` and `eslint` no longer report a tool failure as "no
  violations": an unusable report is an error, not a pass.
- `scan:` reported the run's elapsed time rather than the scan's, which made a slow
  scan and a slow run indistinguishable.
- The baseline feature (`raised in rc.5`'s engine) is applied again, with the
  documented pass/fail rule: a run with a baseline passes only when nothing is new
  and nothing is stale.

## [3.0.0-rc.5] — 2026-09-15

> Supersedes `3.0.0-rc.0` … `3.0.0-rc.4`, which shipped the `netzwerk`-backed
> engine. Those candidates could not be installed on a fresh machine (`netzwerk`
> was a `link:` dependency in rc.0/rc.2, so `npm install` failed outright),
> ignored the configured cache path, and silently skipped files over 64 KB. This
> candidate drops the dependency completely and fixes those defects — see
> “Fixed” below. It is the first 3.x release that installs and caches correctly
> on a clean machine.

### Changed

- **The cache moved to one shared file: `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`.**
  It used to be per-project at `.gesetz/cache.db`, which meant every repository
  needed a `.gitignore` entry and the caches were scattered. Entries are now
  namespaced by project root inside the shared file, so nothing is shared
  *between* projects (entries are keyed by repo-relative path, and checks like
  `requireSibling` read other files). Clearing the cache is
  `rm -rf ~/.cache/gesetz`; entries untouched for 30 days are swept on open.
  `GESETZ_DB`, `storage: { kind: 'sqlite', path }`, and the
  `<project>/.gesetz/cache.db` fallback (used when the shared location is not
  writable) all still work.
- **Removed the `netzwerk` runtime dependency.** The incremental engine is now a
  self-contained, dependency-free cache inside `@gesetz/core` (`src/cache/`).
  Rules run file-major — each file is read and parsed once, and every applicable
  per-file rule runs against that single parse. On this repository a cold
  `gesetz check` went from ~22 s to ~0.7 s and a warm run from ~1.3 s to ~120 ms.
  The install no longer pulls onnxruntime, transformers, sharp, libsql, or
  tree-sitter.
- Parse results are memoized in `@gesetz/typescript`, so the ast-grep based
  checks and the syntax backend share a single parse per file instead of one
  parse per check.
- Syntax is extracted on demand. A registered adapter that no rule consumes no
  longer parses the project.
- **A tool adapter that cannot run is now a critical violation** instead of a
  silent pass. The run reports `failedRules`, never passes while a rule is
  broken, and retries the rule on the next invocation. Pass `--throw` to abort
  with the full error instead.
- `execTool` now throws when the tool could not be started (previously it
  returned `''` and logged a warning). A non-zero exit is unaffected.

### Added

- `gesetz check --throw` (and `runAll(config, { throwOnRuleError: true })`) to
  fail hard when a rule or tool adapter cannot run.
- `RunResult.failedRules` — the ids of rules that could not run. Surfaced in the
  status banner and the JSON envelope.
- `select(glob, { exclude, include, category, label, guidance })` — inline
  shorthand for the corresponding builder calls.
- `group(category, rules)` — applies one scoring category to a list of rules.
- `@gesetz/sqlite-compat` — optional `better-sqlite3` cache driver for runtimes
  without `node:sqlite`. Registered through the new
  `registerCacheDriver('sqlite', factory)` seam and `createSqliteStoreFromDatabase`,
  so `@gesetz/core` still ships no native dependency.
- `storage: { kind: 'sqlite', path }` in `gesetz.config.ts` is now authoritative
  for `gesetz check`; a relative path resolves against `projectRoot`.
- `noCrossModuleImports({ modulePattern, message })` in `@gesetz/typescript`:
  flags imports that cross from one module into another module's internals. The
  `domain-isolation` blueprint in `gesetz init` referenced this check, but no
  package exported it.
- A CI guard (`packages/cli/tests/init-imports.test.ts`) asserting that every
  import `gesetz init` generates resolves to a real export.
- `publint` and `attw` now run in CI, after the packaging bugs below.

### Removed

- The JSON cache adapter. When no SQLite driver is available the run continues
  without a cache instead. `storage` is now `{ kind: 'memory' } | { kind:
  'sqlite', path }`, with no `driver` field — driver selection is automatic.

### Fixed

- **`noMagicNumbers` reported digits inside strings, comments and regex
  literals.** `'utf-8'` was reported as the magic number 8, `'Node >= 23.4'` as
  23.4, `/** Default: 400 */` as 400, and the character class `[^a-z0-9]` as 9 —
  most of its output was false positives. The check now blanks string, template
  and regex literals and comments before scanning, preserving line numbers.
- **`gesetz init` generated imports for checks that do not exist.**
  `noConsoleLog`, `noEmptyCatch`, `noTrivialComment` and `relativeImports` were
  imported from `@gesetz/core` after moving to `@gesetz/typescript`, so the
  generated config did not compile.
- **`@gesetz/core` still defined those four checks** — dead code unreachable from
  the package's public API, and the source of the `init` bug above.
- **`@gesetz/junit` ran its tests with `bun test`** although the tests import
  from vitest, so `pnpm test` failed without Bun installed.
- **Per-file cache results are now invalidated when the project's file set
  changes.** The cache key covered the file's own content hash and the rule
  definitions, but per-file checks are not pure functions of one file:
  `requireSibling` asks `fs.exists`, and `requireChildren`/`forbidFile`/
  `fs.glob`/`imports.resolve` consult the project's file listing. Deleting
  `a.test.ts` left `a.ts`'s cached "sibling present" result in place, so
  `everyFileNeedsTest`-style rules **silently passed**. The path set is now part
  of the fingerprint, so add/remove/rename recomputes while an edit still only
  re-checks the edited file.
- **Adapter `cwd` is resolved when the rule runs, not when the config is
  loaded.** Adapters used to capture `nodePath.resolve(opts.cwd ?? process.cwd())`
  while `gesetz.config.ts` was being evaluated, so a relative `cwd` (for example
  `vitest({ cwd: 'packages/web' })`) anchored to the shell's directory rather
  than the project root. `eslint`, `oxlint`, `oxfmt`, `prettier`, `vitest`,
  `storybook`, `bun-test`, `pest`, `phpunit`, and `phpstan` now resolve it from
  the project root at run time.
- **Adapter binaries prefer a local install, then `PATH`.** `oxlint` used to
  require `oxlint` on `PATH` while the other adapters required
  `node_modules/.bin/<tool>`; `phpstan`/`phpunit`/`pest` required
  `vendor/bin/<tool>`. All ten adapters now look for their tool relative to the
  adapter's working directory first and fall back to `PATH`. An explicit `bin`
  still wins.
- `gesetz check --project-root <dir>` now actually scans `<dir>`. Previously the
  flag only located the config; because `defineConfig()` defaults `projectRoot`
  to `process.cwd()`, the scan silently ran against the current directory
  instead — `--project-root ./packages/web` from the repo root scanned the repo
  root.
- The violation cache is now written where the configuration says
  (`GESETZ_DB`, a configured `storage` path, or the shared cache) instead of a
  global `~/.fabrik/netzwerk.db` that ignored every setting.
- Files larger than 64 KB are no longer silently skipped.
- `gesetz check --full` genuinely bypasses persistence.
- Discovery honours `.gitignore` via `git ls-files`, including files deleted from
  the working tree but still present in the git index.

### Deprecated

- **`noDeepNesting` from `@gesetz/core`.** It flags *indentation*, not control-flow
  depth: a callback passed to `.pipe(...)` counts as a level exactly as a nested
  `if` does, and continuation lines are counted too. Against this repository it
  reported 227 warnings, of which the large majority were ordinary formatting.
  Use oxlint's `eslint/max-depth` and `eslint/max-nested-callbacks` instead —
  both measure real nesting from the AST, match ESLint's semantics, and sit in
  oxlint's `pedantic` category (enable them explicitly):

  ```jsonc
  // .oxlintrc.json
  {
    "rules": {
      "max-depth": ["error", { "max": 4 }],
      "max-nested-callbacks": ["error", { "max": 3 }]
    }
  }
  ```

  Gesetz recommends oxlint and oxfmt for TypeScript/JavaScript, so for TS/JS
  projects its own nesting check has no reason to exist. It is kept for languages
  oxlint does not cover, and will be removed in a future major version. It is no
  longer used by gesetz's own configuration.

- **Eight more checks, for the same reason:** Gesetz ships a rule only when
  nothing better exists, and oxlint already implements these from the AST and
  maintains them upstream. Each is marked `@deprecated` in its JSDoc (so editors
  surface it) and in the README, but **nothing was removed or changed** — they
  still work and are still used by gesetz's own configuration.

  | Deprecated | Use instead |
  |---|---|
  | `noGodFile` | `max-lines` |
  | `noConsoleLog` | `no-console` |
  | `noEmptyCatch` | `no-empty` |
  | `noMagicNumbers` | `no-magic-numbers` |
  | `noTypedAny` | `typescript/no-explicit-any` |
  | `noDefaultExport` | `import/no-default-export` (enable the `import` plugin) |
  | `noBarrelFile` | `oxc/no-barrel-file` |
  | `requireExplicitReturnType` | `typescript/explicit-function-return-type` |

  Moving a rule to oxlint does not lose its score contribution: `@gesetz/oxlint`
  feeds oxlint's findings into the same report and category scores. The rest of
  the catalog has no oxlint equivalent — file-pairing rules, architecture layers,
  pattern rules, secret scanning, the Effect rules, and every PHP/Laravel rule
  (oxlint is JavaScript/TypeScript only).

### Notes

- `ProjectRuleContext` no longer has a `network` field; it exposes
  `{ rootDir, changedFiles }`. No shipped adapter used the removed field.
- Persistent SQLite caching requires a usable driver: Node >= 23.4, Node >= 22.5
  with `--experimental-sqlite`, or the optional `@gesetz/sqlite-compat`
  (`better-sqlite3`) package. Without one, gesetz prints an actionable notice
  and runs without a cache.
- `@gesetz/core` depends only on `effect`, `fast-glob`, and `micromatch`.
- **Cache invalidation is derived from each rule's shape** — `fn.toString()` for
  check bodies, the rule's patterns, and the project's file set. A change to a
  check's *module-level helper* is invisible to that fingerprint, because the
  closure's own source text is unchanged. After upgrading an adapter package, run
  `gesetz check --full` once (or delete the cache) if reported violations look
  stale. Rules whose behaviour is configured at runtime can set an explicit
  `Rule.fingerprint` to make invalidation deterministic.

---

## [2.0.0] — 2026-07-05

### Breaking: Check type migrated from Effect to async/await

The `Check` type is now `(file: File, services: CheckServices) => Promise<Violation[]>`
 instead of `Effect.Effect<Violation[], never, FileSystem | SyntaxTree | ...>`.
 This is the **largest breaking change in v2.0.0** — every custom check, every
 adapter check, and every test must be rewritten.

**Effect stays internal.** The runner, services, and `Rule.run` remain
 Effect-based. Only per-file check functions become plain async. Checks
 receive `FileSystem`, `SyntaxTree`, `ImportResolver`, and `projectRoot` via
 a `CheckServices` bag as the second argument — no more `Effect.gen` or `yield*`.

#### Before (1.x)

```ts
import { Effect } from 'effect';
import { FileSystem } from '@gesetz/core';
import type { Check } from '@gesetz/core';

export function requireSibling(suffix: string): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const siblingPath = file.dir + '/' + file.stem + suffix;
      const exists = yield* fs.exists(file.absolutePath.replace(file.name, file.stem + suffix));
      if (exists) return [];
      return [{
        severity: 'error',
        source: 'core',
        message: `Missing sibling file: ${file.stem}${suffix}`,
        path: file.path,
      }];
    });
}
```

#### After (2.0)

```ts
import type { Check } from '@gesetz/core';

export function requireSibling(suffix: string): Check {
  return async (file, { fs }) => {
    const siblingPath = file.dir + '/' + file.stem + suffix;
    const exists = await fs.exists(file.absolutePath.replace(file.name, file.stem + suffix));
    if (exists) return [];
    return [{
      severity: 'error',
      source: 'core',
      message: `Missing sibling file: ${file.stem}${suffix}`,
      path: file.path,
    }];
  };
}
```

#### Key differences

1. **No Effect imports needed** — checks are plain `async` functions.
2. **Services come from the second argument** — destructure `{ fs, syntax, imports, projectRoot }` instead of `yield* FileSystem`.
3. **No `Effect.gen` / `yield*` / `Effect.sync`** — use `await` and `return` directly.
4. **No error channel** — return `[]` on failure; never throw.
5. **`rule` field is optional** — the builder auto-injects the rule ID. Omit it from violations.
6. **`.check()` in `select` is unchanged** — still chain `.check(myCheckFn)` as before.
7. **External tool adapters** (eslint, oxlint, …) — their run Effects are unchanged. Only per-file checks are affected.

#### Services available via `CheckServices`

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
  projectRoot: string;
}
```

### Breaking: `--files` filtering now happens before execution

Previously, `--files <globs>` only filtered output — all checks and external
 tools ran on the full codebase, and violations from non-matching files were
 suppressed post-hoc. Now the filter is applied proactively:

- **`select()` rules** — `--files` patterns are used for `fast-glob` scanning
  instead of the rule's own patterns. The rule's `select()` patterns are
  applied as a post-glob micromatch filter. Fewer files are glob-scanned.
- **External tool adapters** — each adapter now yields `FileFilter` and passes
  its patterns as file arguments to the external tool (eslint, oxlint,
  prettier, oxfmt, vitest, phpstan, pest, phpunit, bun-test). The tool only
  processes the `--files` subset. The adapter's own `pattern` option is
  overridden by `--files` when both are present.
- **storybook** is not affected — its `--stories` flag filters story names,
  not file paths. The post-hoc runner filter handles it.
- The post-hoc runner filter **remains** as a safety net for any violations
  produced outside the `--files` scope.

### Migration notes (from 1.x)

1. **Rewrite all custom `Check` functions** from `Effect.gen(function* () { ... })` to `async (file, services) => { ... }`. See the before/after example above.
2. **Remove `import { Effect } from 'effect'`** from check files — it's no longer needed.
3. **Remove `import { FileSystem, SyntaxTree, ImportResolver } from '@gesetz/core'`** from check files — services come from the second argument now.
4. **Tests for checks** — replace `Effect.runPromise(Effect.provide(check(file), layer))`
   with `await check(file, makeCheckServices({ ... }))`. Use the `makeCheckServices`
   helper from `@gesetz/core`.
5. **`Rule.run` and `defineConfig` are unchanged** — only the `Check` type changed.
6. **`DefineArchitecture` is unchanged** — it constructs rules internally; no public API change.
7. **Adapter `pattern` option** — when using `--files`, the adapter's own `pattern`
   is overridden. If you need both, pass combined patterns via `--files`.

### Affected packages

All 18 packages (`@gesetz/bun-test`, `@gesetz/cli`, `@gesetz/core`,
 `@gesetz/effect-ts`, `@gesetz/eslint`, `gesetz`, `@gesetz/junit`,
 `@gesetz/laravel`, `@gesetz/oxfmt`, `@gesetz/oxlint`, `@gesetz/pest`,
 `@gesetz/php`, `@gesetz/phpstan`, `@gesetz/phpunit`, `@gesetz/prettier`,
 `@gesetz/storybook`, `@gesetz/typescript`, `@gesetz/vitest`).

---

## [1.3.3] — 2026-06-28

### Fixed

- **`noHardcodedStrings` (in `@gesetz/typescript`) produced massive false-positive
  rates on real React codebases.** The 1.3.0 rewrite added a third detection
  case — "string literals anywhere inside a JSX expression container `{...}`" —
  implemented with a recursive AST search. This flagged every utility token
  string nested inside expressions: Tailwind classes inside `cn("flex …")`, route
  paths in `<Link to="/companies" />`, enum-like prop values like
  `variant="outline"`, CSS classes like `className="h-8 w-8"`, internal toggle
  values like `value="stacking"`, and any string passed to a helper inside `{}`.
  Reverted to the original immoui behavior: only **raw JSX text children**
  (`<div>Hello</div>`) and **string literals on a narrow, fixed allowlist of
  translatable props** are flagged. The allowlist is now exactly: `label`,
  `placeholder`, `title`, `aria-label`, `heading`, `subtitle`, `description`,
  `helperText`, `hint`, `emptyStateHeading`, `emptyStateDescription`,
  `modalHeading` (previously included `alt`, `content`, `text`, `message`,
  `caption`, `tooltip`, `summary`, and several `aria-*` props that carry tokens,
  not prose). Strings inside JSX expression containers are never flagged.
  Added 16 regression tests covering the exact upstream false-positive cases.

---

## [1.3.2] — 2026-06-28

### Fixed

- **`@gesetz/cli` could not load `gesetz.config.ts` under plain Node.** The
  1.3.0/1.3.1 CLI used a native `import()` to load the config, which worked
  under Bun (native TS) but failed under Node with `SyntaxError: Cannot use
  import statement outside a module`. Now uses [`jiti`](https://github.com/unjs/jiti)
  (the same runtime TS loader used by Nuxt, Nitro, ESLint, Tailwind, Knip) to
  transpile TypeScript config files on the fly. `jiti` is a new runtime
  dependency of `@gesetz/cli` (kept external in the bundle, resolves from
  `node_modules`). `tryNative: false` is set so jiti always transpiles rather
  than delegating to Node's experimental native TS stripping — which only
  works for `"type": "module"` packages or `.mts`/`.mjs` files and would
  silently break CJS consumer projects. `.js`, `.mjs`, and `.cjs` configs
  continue to work.

---

## [1.3.1] — 2026-06-28

### Fixed

- **`@gesetz/cli` produced no output when invoked via the `node_modules/.bin/gesetz`
  symlink** (the normal consumer install path). The entry-point guard compared
  `import.meta.url` to `pathToFileURL(process.argv[1])`, but `process.argv[1]`
  is the *unresolved* symlink path while `import.meta.url` is the real file URL,
  so the guard failed and `runGesetz()` was never called — the CLI silently
  exited 0. Now resolves `process.argv[1]` with `fs.realpathSync` before
  comparing, so symlinked bin invocation works.

---

## [1.3.0] — 2026-06-28

Migrated the entire toolchain from **Bun to pnpm + tsdown**. Packages now
ship compiled JavaScript (ESM) and TypeScript declarations instead of raw
`.ts` source, so they run under any Node-compatible runtime — not just Bun.
This release also fixes the publishing correctness bug that made 1.2.0
internally inconsistent (adapters resolving `@gesetz/core` to a stale
`1.1.1` in their tarballs).

### Changed

**Package manager: Bun → pnpm 11.9.0.** `bun.lock` replaced by
`pnpm-lock.yaml`; `pnpm-workspace.yaml` added; `packageManager: "pnpm@11.9.0"`
declared. The `workspaces` field was removed from the root `package.json`
(pnpm reads `pnpm-workspace.yaml` instead). Root scripts now use `pnpm -r`
and `pnpm --filter`.

This fixes the core publishing problem: Bun resolves `workspace:*` from
`bun.lock`, and `bun install` does **not** refresh workspace versions in
`bun.lock` after a version bump (oven-sh/bun#18906, still open as of Bun
1.3.14 — also affects `bun install --force` and `bun install
--lockfile-only`). The result was that `bun pm pack` / `bun publish` baked
stale dependency versions into published tarballs. **pnpm resolves
`workspace:*` from each package's `package.json` at pack/publish time** —
the documented, correct behavior — so no lockfile gymnastics are required.

**Build tool: `bun build` → tsdown 0.22.3.** tsdown (Rolldown-based, the
official successor to tsup) builds every package to `dist/*.js` (ESM) +
`dist/*.d.ts`. `exports` now point at `dist` with a `types` condition;
`files: ["dist"]`; `prepack: tsdown`. The root `tsdown.config.ts` drives
workspace builds (`tsdown -W`); per-package configs in `packages/*/
tsdown.config.ts` handle the `./reporters` subpath (`@gesetz/core`) and the
bundled executable with node shebang (`@gesetz/cli`).

**`@gesetz/cli` runs under plain Node.** The shebang changed from
`#!/usr/bin/env bun` to `#!/usr/bin/env node`. The CLI is now a self-contained
ESM bundle (`dist/main.js`, ~58 KB) with `@gesetz/*`, the Effect ecosystem,
oxc-parser, and `@ast-grep/*` kept external. Verified: `node dist/main.js
--help` works.

**Every published package now ships compiled JS + types**, not raw
TypeScript. `exports` use the conditional `{ "types": "./dist/*.d.ts",
"import": "./dist/*.js" }` shape. `publint` reports clean across all 18
packages.

### Removed

- **`bun.lock`** — replaced by `pnpm-lock.yaml`.
- **`scripts/bump-version.ts`** — the hand-rolled version bumper whose only
  job was to delete-and-regenerate `bun.lock` to work around Bun's stale-
  workspace-version bug. With pnpm, `pnpm version` and `pnpm -r publish`
  handle this natively.
- **`scripts/publish-all.ts`** — the hand-rolled publish orchestrator with
  its pre-publish `workspace:*` consistency check. Replaced by
  `pnpm -r publish --access public`, which resolves workspace versions
  correctly without a safety net.
- **`tsup`** dev dependency on `@gesetz/cli` — replaced by `tsdown`.

### Migration notes (from 1.2.0)

1. **No source-level changes required.** The public API of every package is
   unchanged; only the published artifact format changed (`.ts` → `.js` +
   `.d.ts`).
2. **Runtime no longer requires Bun.** Any Node 20+ runtime works.
3. **If you develop in this repo**, switch to pnpm: `npm i -g pnpm`, then
   `pnpm install`. Use `pnpm run build` / `pnpm run test` / `pnpm run
   typecheck` instead of the `bun run` equivalents. The `pnpm publish`
   flow replaces the deleted scripts.

---

## [1.2.0] — 2026-06-27

A ground-up rewrite of the rule engine. Core is now parser-free; language
adapters own their parsers; rules are plain functions (no string dispatch, no
global registry). Backward-incompatible — the project is freshly released, so
no compatibility shims are provided.

### Added

**Architecture — `SyntaxBackend` routing pattern**
- New `SyntaxTree` service + `SyntaxBackend` interface in `@gesetz/core`. A
  `SyntaxBackend` is a plain object (not an Effect Layer) that extracts
  imports, calls, exports, and structure from source. Core's `SyntaxTreeLive(
  backends[])` factory creates one Effect Layer that routes requests to the
  correct backend by file extension.
- New `ImportResolver` service + `ImportResolverDefault` (relative-path
  resolver) in `@gesetz/core`. Used by `defineArchitecture` and `noCycles` to
  map import specifiers to file paths.
- New `adapters: SyntaxBackend[]` field on `defineConfig`. Declare your
  backends once; the runner wires `SyntaxTreeLive` automatically.
- New `SyntaxTreeStub` Layer for tests that don't need parsing.

**New core primitives (SyntaxTree-backed)**
- `noDirectCalls(names, opts?)` — precise AST-level ban on specific function
  calls (member access supported: `console.log`, `fmt.Println`).
- `requireNamingConvention({ kinds?, pattern, message?, severity? })` —
  structural items must match a naming regex.
- `noForbiddenNames(names | RegExp, { kinds?, message?, severity? })` — ban
  specific names on structural items.
- `requireDocstrings({ kinds?, message?, severity? })` — structural items must
  have attached docstrings.
- `requireExportsMatching(pattern, minCount?, opts?)` — file must export at
  least `minCount` identifiers matching a pattern.
- `requireRelatedExports(getRelated, opts?)` — for every export `X`, all
  counterparts returned by `getRelated(X)` must also be exported. N-ary
  (returns `string[]`, not one string).
- `requireMinStructureCount(kind, minCount, opts?)` — file must declare at
  least `minCount` structural items of a kind (counted recursively).

**New core primitive (regex, no backend)**
- `noDebugLogging(opts?)` — polyglot debug-logging detector. Extension-aware:
  flags `console.*` in TS/JS, `print`/`pprint`/`breakpoint` in Python,
  `var_dump`/`dd`/`dump` in PHP, `fmt.Println`/`log.Printf` in Go,
  `println!`/`dbg!` in Rust, `puts`/`p`/`pp` in Ruby. Unknown extensions are
  silently skipped. Supports `extraNames`, custom severity, custom message.

**New TypeScript/JS checks (`@gesetz/typescript`)**
- `noTypedAny`, `noAsUnknownAs` (double casts), `noDefaultExport`, `noEnum`,
  `noBarrelFile`, `requireExplicitReturnType`.

**New PHP checks (`@gesetz/php`)**
- `requireTypeHints`, `requireReturnType`, `requireNamespace`, `noDieOrExit`,
  `noEval`, `requireFinalClasses`.

**New Laravel checks (`@gesetz/laravel`)**
- `noDd({ message?, severity? })` — standalone Check banning `dd`/`ddd`/`dump`/
  `debug` (more precise than the pre-built `noDebugHelpers` rule).
- `noFacades({ facades?, message?, severity? })` — ban Laravel Facades
  (`Auth::`, `DB::`, `Cache::`, …) in favor of dependency injection.

**`typescriptSyntaxBackend`** — the `SyntaxBackend` for TypeScript/JavaScript,
exported from `@gesetz/typescript`. Uses `oxc-parser` for imports/exports and
`@ast-grep/napi` for calls/structure. Handles `.ts`, `.tsx`, `.js`, `.jsx`,
`.mjs`, `.cjs`.

**`phpSyntaxBackend`** — the `SyntaxBackend` for PHP, exported from
`@gesetz/php`. Uses `@ast-grep/lang-php`. Handles `.php`, including grouped
`use Foo\{A, B}` and aliased `use Foo\Bar as Baz` imports.

**Memory safety** — `FileSystemLive.glob` now reads file content **lazily** on
first `file.content` access (caching getter) instead of eagerly materializing
every globbed file's content at glob time. Peak memory is bounded to what
checks actually access. The `File` interface is unchanged (`readonly content:
string`).

**`FileSystemLive.glob` default ignores** — when the caller passes no
`ignore`, globs now default to `['**/node_modules/**', '**/.git/**']` so a
code-quality tool never scans dependency trees or VCS metadata.

**Publishing fix** — `@gesetz/cli` now declares `"files": ["dist", "src"]` and
a `"prepack": "bun run build"` script, so the gitignored `dist/main.js` is
built and included in the published tarball. `scripts/publish-all.ts` runs
each package's `prepack` before publishing as belt-and-suspenders. The plain
`gesetz` command now resolves to a built, runtime-ready JS bundle and is
created at `node_modules/.bin/gesetz` on install.

### Changed

**`Check` / `Rule` service requirements** — the `R`-channel is now
`FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter`
(was `FileSystem | TsAdapter | PhpAdapter | ProjectRoot | FileFilter`).

**`defineArchitecture`** — import extraction now uses `SyntaxTree.process({
imports: true })` when a backend is registered (oxc-parser for TS/JS,
`@ast-grep/lang-php` for PHP); relative specifiers are resolved to file paths
via `ImportResolver`. Falls back to a JS/TS regex when no backend is
registered. Still returns **one** batched `Rule` (not O(n²) per-pair rules).

**`noCycles`** — rewritten. Now uses `SyntaxTree` (import extraction) +
`ImportResolver` (path resolution) + DFS over the dependency graph. No
`dependency-cruiser`. Files whose extension has no registered backend are
skipped; external (non-resolvable) imports are ignored.

**`noImportFrom` / `requireImportFrom`** — now use `SyntaxTree` for accurate
specifiers when a backend is registered; fall back to a JS/TS regex otherwise.
Report 1-indexed line numbers when a backend is used.

**Renames (signatures changed too)**
- `requireExportPairs(getCounterpart: (name) => string | null)` →
  `requireRelatedExports(getRelated: (name) => string[] | null)`. Now N-ary:
  returns an array of required counterparts, all of which must be exported.
- `requireExportFactories({ pattern, minCount, … })` →
  `requireExportsMatching(pattern, minCount?, opts?)`. Positional parameters.
- `requireCallShape(fnName, requiredKeys, opts)` →
  `requireOptionsObject(fnName, { argIndex?, requiredKeys })`. New `argIndex`
  (default 0) selects which argument must be the object literal.

**Moved from `@gesetz/core` to `@gesetz/typescript`** (these are
TypeScript/JavaScript-specific, not language-agnostic):
- `noConsoleLog`, `noEmptyCatch`, `noMagicNumbers`, `noTrivialComment`,
  `relativeImports`.

**`@gesetz/effect-ts`** — all four checks (`noRunPromiseScattered`,
`noThrowInEffectGen`, `noYieldWithoutStar`, `noUnboundedEffectAll`) migrated
from ts-morph to ast-grep. Public API (function names + options) unchanged;
implementation only. Removed the `ts-morph` and `@gesetz/typescript`
dependencies.

**`@gesetz/typescript`** — every ts-morph check migrated to ast-grep /
oxc-parser (via `typescriptSyntaxBackend` and the shared ast-grep helper in
`checks/shared.ts`). Removed the `ts-morph` dependency.

**`@gesetz/php`** — `PhpAdapterLive` (tree-sitter-php) deleted. Replaced by
`phpSyntaxBackend` (`@ast-grep/lang-php`). The generic PHP checks
(`strictTypes`, `psrNamespace`, `noInlineQueries`) are unchanged.

**`packages/cli` build script** — removed `--external dependency-cruiser`,
`--external ts-morph`, `--external tree-sitter`,
`--external tree-sitter-php`. Added `--external oxc-parser`,
`--external @ast-grep/napi`, `--external @ast-grep/lang-php`.

**`gesetz` meta-package** — removed the conflicting `bin` field (it pointed
at TypeScript source and clashed with `@gesetz/cli`'s bin). Deleted the
redundant `src/cli.ts` shim. The `gesetz` command now comes from
`@gesetz/cli`'s bin, hoisted into `node_modules/.bin/gesetz`.

### Removed

**`TsAdapter`, `TsAdapterStub`, `TsSourceFile`, `TsAdapterService`,
`TsAdapterError`** — deleted from `@gesetz/core` entirely. The tag, the stub,
the service file (`services/ts-adapter.ts`), and the error class are gone. No
shims, no compatibility aliases.

**`PhpAdapter`, `PhpAdapterStub`, `PhpSyntaxNode`, `PhpAdapterService`,
`PhpAdapterError`** — deleted from `@gesetz/core` entirely. Replaced by the
`SyntaxBackend` pattern.

**`ts-morph`** — removed as a dependency from `@gesetz/typescript` and
`@gesetz/effect-ts`. No check in either package needs the TypeScript type
checker.

**`tree-sitter`, `tree-sitter-php`** — removed from `@gesetz/php`. Replaced
by `@ast-grep/lang-php`.

**`dependency-cruiser`** — removed from the workspace. `noCycles` no longer
uses it.

**`noFloatingPromises`** — intentionally not provided. It requires the
TypeScript type checker (`getTypeAtLocation`) to know whether a call returns a
`Promise`; ast-grep and oxc-parser are purely syntactic and cannot do this
correctly. Use `@gesetz/eslint` (`@typescript-eslint/no-floating-promises`) or
`@gesetz/oxlint` (`typescript/no-floating-promises` with `--type-aware` +
`tsgolint`) — both ship type-checked, battle-tested versions.

**`noCrossModuleImports`** — deleted. `defineArchitecture` is the replacement
for architectural boundary enforcement.

**`requireImportBoundary`** — deleted. Same reasoning; use
`defineArchitecture`.

### Migration notes (from 1.1.x)

1. **Add `adapters` to your config.** Any SyntaxTree-backed check
   (`noDirectCalls`, `requireNamingConvention`, `requireDocstrings`,
   `requireExportsMatching`, `requireRelatedExports`,
   `requireMinStructureCount`) and the accurate path of `defineArchitecture` /
   `noCycles` / `noImportFrom` require a registered backend:
   ```ts
   import { typescriptSyntaxBackend } from '@gesetz/typescript';
   defineConfig({ adapters: [typescriptSyntaxBackend], rules: [...] })
   ```
2. **Re-import moved checks.** `noConsoleLog`, `noEmptyCatch`,
   `noMagicNumbers`, `noTrivialComment`, `relativeImports` now come from
   `@gesetz/typescript`, not `@gesetz/core`.
3. **Apply renames.** `requireExportPairs` → `requireRelatedExports` (callback
   now returns `string[] | null`); `requireExportFactories` →
   `requireExportsMatching` (positional args); `requireCallShape` →
   `requireOptionsObject` (options object with `argIndex` + `requiredKeys`).
4. **Drop deleted checks.** `noCrossModuleImports` and `requireImportBoundary`
   are gone — express their intent via `defineArchitecture`.
5. **For floating-promise detection**, add `@gesetz/eslint` or
   `@gesetz/oxlint` to your rules and enable the type-checked rule there.
6. **Programmatic `runAll` usage** — provide `SyntaxTreeLive(config.adapters)`
   and `ImportResolverDefault` in your Layer (in addition to `FileSystemLive`,
   `ProjectRootLive`, `FileFilterLive`). Without them, SyntaxTree-backed rules
   throw `Service not found: gesetz/SyntaxTree` at runtime.

---

## [1.1.1] — 2026-06-26

- Initial public release of the polyglot rule engine, CLI, and adapter
  packages.
