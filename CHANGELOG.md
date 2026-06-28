# Changelog

All notable changes to **Gesetz** and the `@gesetz/*` packages are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
