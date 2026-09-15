# Incremental Cache Engine Implementation Plan

> **Status:** IMPLEMENTED (architecture v2 — see implementation notes below)
> **Plan:** `./.plans/incremental-cache/PLAN.md`
> **Last updated:** 2026-09-14

---

## Implementation notes (read this before the plan body)

The plan below describes an earlier design (v1) in which a persisted
`gesetz-syntax` marker cache sat alongside per-rule caches. Measurement showed
that design optimised the wrong thing, so the shipped implementation follows
**architecture v2**. The plan body is kept for its context and rationale; where
it disagrees with this section, this section wins.

What shipped, and how it differs from the plan body:

- **No persisted syntax cache.** Measurement showed the syntax backend was
  consumed by only a handful of checks, that `typescriptSyntaxBackend` parsed
each file four times per `process()` call (two oxc passes + two ast-grep passes),
  and that the dominant cold-run cost was netzwerk's storage layer (one awaited
  `@libsql/client` write per marker). Parsing is now lazy and in-run only.
- **One per-file cache scope, file-major execution.** `scope: 'rules'`, key =
  file path, value = `{ [ruleId]: Violation[] }`, fingerprint = hash of every
  per-file rule plus the syntax-backend fingerprint. Each file is read once and
  parsed once; every applicable rule runs against that single parse.
- **Parse memoization lives in `@gesetz/typescript`**
  (`src/parse-memo.ts`), shared by `checks/shared.ts#parseFile` and
  `syntax-backend.ts`. This was the single highest-leverage change.
- **Lazy syntax services.** `check-services.ts` extracts on demand, memoized per
  file and per kind. A registered adapter that no rule consumes parses nothing.
- **Discovery asks git** (`git ls-files --cached --others --exclude-standard`)
  with a fast-glob walk fallback outside a repository. No size cap. Files listed
  in the index but deleted from disk are skipped and pruned.
- **Project and run-only rules** get one cache entry each, keyed by the hash of
  the files they cover plus their own fingerprint. `noCycles` and
  `defineArchitecture` dropped their duplicate netzwerk `project` blocks and run
  through their existing Effect `run`.
- **Store port trimmed** to `get`/`put`/`entries`/`prune`/`close`. Three adapters
  ship: memory, SQLite (`node:sqlite`), and JSON (fallback for Node < 23.4/Bun).
- **SDK additions shipped:** `select(glob, { exclude, include, category, label,
  guidance })` and `group(category, rules)`. Both additive.
- **Tool failures are surfaced.** `execTool` now throws when a tool could not be
  started (missing binary, killed process, no exit status) while still treating a
  non-zero exit as normal — linters exit non-zero on findings, and file-reporting
  tools (PHPUnit, Storybook) exit non-zero while writing a report file. The
  runner catches that and emits a critical violation, records
  `RunResult.failedRules`, refuses to pass, and deletes the rule's cache entry so
  the next run retries. `--throw` / `throwOnRuleError` aborts instead.
- **SQLite driver resolution is explicit.** `createSqliteStore(path, driver)`
  takes `auto` | `node` | `compat`; `SqliteUnavailableError` carries an
  actionable message naming `@gesetz/sqlite-compat`. The driver registry
  (`registerCacheDriver`) keeps native bindings out of `@gesetz/core`, and the
  new `@gesetz/sqlite-compat` package supplies a `better-sqlite3` implementation.
- **Storage configuration was collapsed after review.** `storage` is now just
  `{ kind: 'memory' } | { kind: 'sqlite', path }` — no `json` kind, no `driver`
  field — and it is authoritative for both the CLI and `runAll`.
- **The cache became one shared file** at `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`,
  namespaced by project root, rather than a `.gesetz/cache.db` per repository.
  Nothing needs gitignoring and there is one place to clear it. `namespace` is
  bound at store construction, so every statement (including `prune`) is scoped;
  `ttlMs` (default 30 days) sweeps on open; a `user_version` mismatch drops and
  recreates the table. `<project>/.gesetz/cache.db` remains the fallback when the
  shared location is not writable.
- **Per-file cache invalidation had a correctness bug**, found by asking what the
  key actually covers: `requireSibling`-style checks read the project's file
  listing, so deleting a sibling left the cached "sibling present" result in
  place — a silent pass. The candidate/project path set is now folded into the
  scope fingerprint (`v: 2`), so add/remove/rename recomputes while an edit still
  only re-checks the edited file.
- **Test result:** 27 core test files / 209 tests pass, and the entire workspace
  suite is green (except `@gesetz/junit`, whose `test` script is `bun test` and
  bun is not installed in this environment). No existing test needed changing for
  backward compatibility — the 4 previously-netzwerk-dependent engine tests
  passed unmodified against the new runner.
- **Measured effect on this repository** (203 candidates, 3 per-file rules,
  TypeScript syntax backend): cold ~684 ms (was ~22 s), warm ~119 ms (was
  ~1.0–1.5 s), one-file edit ~124 ms.

---

## ⚠️ Instructions for the implementing agent

**READ THIS SECTION BEFORE TOUCHING ANY CODE.**

You are an executor. Your job is to implement this plan exactly as written.
This plan was written with full context from a prior research and design session.
You do not have that context. The plan is your complete specification.

**Rules you must follow without exception:**

1. **Do not deviate from this plan.** Do not simplify steps, skip phases, combine
   tasks, or substitute approaches — even if a different approach seems easier or
   more elegant. The decisions here were made deliberately. Respect them.

2. **Do not make decisions not explicitly covered by this plan.** If you reach a
   point where the plan is ambiguous or where you feel you need to make a choice
   the plan does not make for you, **stop and ask the user** before proceeding.
   Do not guess. Do not pick the path of least resistance. Do not assume.

3. **Do not change the plan.** If you believe a plan decision is wrong or
   suboptimal, stop and tell the user why. Do not silently implement something
   different.

4. **Work phase by phase.** Complete one phase fully before starting the next.
   Do not jump ahead.

5. **Update the Progress section** at the bottom of this file as you work:
   - Mark phase checkboxes `[x]` when a phase is complete.
   - Mark task checkboxes `[x]` as each task is done.
   - After each phase, write a brief note under "Session log" with what was
     done and what comes next. This allows a new agent to resume from exactly
     where you left off if the session is interrupted.

6. **If your context window is running low**, finish the current task cleanly,
   update the Progress section with exactly where you stopped and what the next
   step is, then tell the user you need a fresh session to continue.

---

## Goal

Replace gesetz's runtime dependency on the `netzwerk` library with a small,
self-contained incremental file cache that lives inside `packages/core/src/cache/`
and is written so it can be lifted into its own package later without edits.

`gesetz check` keeps its current behaviour (content-hash incremental re-checks,
persistent cache across runs) but ships with zero heavy dependencies, no global
cache-path bug, no silent 64 KB file skip, and no unpublishable `link:` dependency.

## Approach

The engine is split into a **generic kernel** (`src/cache/`) and **gesetz glue**
(everything else). The kernel owns exactly four things: read a file, hash it,
diff it against what is stored, and remember the computed result. It knows
nothing about rules, violations, syntax backends, or markers. It talks to a
storage adapter through a tiny `CacheStore` port with three shipped adapters
(memory, sqlite, json).

`src/cache/` is dependency-free: it imports only `node:*` builtins and files
inside its own directory. A test enforces this mechanically (`tests/cache/purity.test.ts`),
which is what makes the later extraction a `git mv` instead of a refactor.

The runner is rewritten to drive the kernel directly instead of compiling rules
into netzwerk extensions. Per-file rules (`select()`) get one cache scope per
rule id; project rules and run-only rules (the tool adapters, `noCycles`,
`defineArchitecture`) get one synthetic cache key per rule id keyed by a hash of
all their relevant file hashes. Syntax parsing becomes a `gesetz-syntax` scope
that parses each file once per content hash and serves all rules from cache.

File discovery stays out of the kernel and lives in `src/engine/discovery.ts`
(fast-glob over the union of all rule patterns). This is deliberate: netzwerk's
hardcoded 64 KB `maxFileBytes` cap is the source of a silent correctness bug we
are removing, and discovery semantics differ per consumer — the kernel must never
own them.

**Alternatives considered and rejected:**

- *Keep netzwerk, patch the storage path.* Rejected: the published `netzwerk@0.0.5`
  `storageFor()` ignores `{ kind: 'sqlite', path }` and the fix is unpublished;
  even patched, the dependency pulls 856 MB of `node_modules` (onnxruntime, sharp,
  transformers, libsql, tree-sitter) for a hash cache. See "Why" below.
- *Extract the kernel straight into a new published package now.* Rejected: the
  user's instruction is explicit — build it inside gesetz first, keep it
  extraction-ready. A fresh package would also be premature until gesetz has
  proven the interface against real use.
- *Use `better-sqlite3` for the sqlite adapter.* Rejected: native build step,
  breaks under Bun, and reintroduces a compiled dependency. `node:sqlite` is
  built in and available on the deployment target (Node v24.21.0 verified).
- *Rebuild netzwerk's import resolver (`resolverForLanguage`) inside the kernel.*
  Rejected: gesetz's existing `ImportResolverDefault` plus the per-rule
  candidate-probing that `noCycles` and `defineArchitecture` already perform is
  sufficient. `resolveImportEdges` usage is deleted, not ported.
- *Put discovery inside `src/cache/`.* Rejected: it would force a `fast-glob`
  dependency into the extractable kernel and let consumer-specific semantics
  (size caps, binary sniffing, git statusMatrix) leak into the library.

## Tech stack & conventions

- **Package manager:** pnpm 11.9.0. Workspace root is the repo root; packages are
  under `packages/*`. Never run `npm install`.
- **Build:** `tsdown` (per-package `tsdown.config.ts`; core has one). ESM only.
- **Tests:** vitest 4. `packages/core/vitest.config.ts` sets `include: ['tests/**/*.test.ts']`,
  `environment: 'node'`, `globals: false`. Tests import from `../../src/...`.
  Always run from the package directory: `pnpm -C packages/core test` or
  `cd packages/core && pnpm test`.
- **TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true` (`packages/core/tsconfig.json`). This means:
  optional properties must be written `readonly x?: T | undefined` when the value
  can be explicitly `undefined`; array/Map index access returns `T | undefined`
  and must be handled. Do not weaken these flags.
- **Effect:** the repo uses Effect **v3** in `packages/core` (`"effect": "^3.15.0"`).
  `Rule.run` stays an `Effect.Effect<Violation[], never, FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter>`.
  Do not migrate anything to Effect v4.
- **Formatting/lint:** the repo dogfoods gesetz itself (`gesetz.config.ts` at repo
  root). Match existing code style: 2-space indent, single quotes, semicolons,
  explicit `| undefined` on optional fields.
- **No new runtime dependencies** may be added to `packages/core/package.json`.
  This plan removes one (`netzwerk`) and adds none.
- **Node version for `node:sqlite`:** the built-in module requires Node ≥ 23.4 to
  import without the `--experimental-sqlite` flag (≥ 22.5 with the flag). The
  sqlite adapter must lazy-import it and fail with a clear message; the CLI picks
  the json adapter when sqlite is unavailable.

## Why (evidence from the investigation)

These are measured facts that motivate every decision. Do not re-litigate them.

- `@gesetz/core@1.3.3` (pre-netzwerk): **41 MB** `node_modules`, 23 packages, 0 vulnerabilities.
- `@gesetz/core@3.0.0-rc.4` (netzwerk as a real dep): **856 MB** `node_modules`, 288 packages, 10 high-severity vulnerabilities.
- The weight is `onnxruntime-node` (536 MB), `onnxruntime-web` (92 MB),
  `@huggingface/transformers` (49 MB), `@vscode/tree-sitter-wasm`, `@libsql/client`,
  `sharp`, `isomorphic-git`, `d3-force-3d` — none of which gesetz uses.
- `@netzwerk/core@0.0.5`'s `storageFor()` ignores `{ kind: 'sqlite', path }` and
  calls `resolveNetzwerkDbPath()`, so the cache always lands in `~/.fabrik/netzwerk.db`.
  `GESETZ_DB` and even `NETZWERK_DB` are ignored. The fix is committed in the
  netzwerk repo (`e990883`) but not published, and `package.json` still says `0.0.5`.
- `netzwerk`'s `maxFileBytes` defaults to `65_536`; gesetz never overrides it, so a
  140 KB `.ts` file containing `console.log` produces **no violation** (verified).
- `@gesetz/core@3.0.0-rc.2` shipped `"netzwerk": "link:../../../netzwerk/packages/netzwerk"`.
  `npm install` fails with `EUNSUPPORTEDPROTOCOL`; `pnpm add` links a dangling
  directory and fails at runtime with `ERR_MODULE_NOT_FOUND`.
- On this repo (246 files, 1.1 MB) a full `runAll` is ~20 s cold and ~1 s warm.
  The ~19 s is the TypeScript syntax backend parsing; netzwerk's own scan is
  ~1.2 s cold / ~0.4 s warm. **The cache is worth keeping; netzwerk is not.**

## Context & orientation

Read this section before Phase 1. It names every file this plan touches.

### Current architecture (to be replaced)

```
packages/core/src/
  engine/
    runner.ts              # runAll — currently builds a netzwerk network and scans
    config.ts              # defineConfig/ResolvedConfig, GesetzStorageConfig
    rule.ts                # Rule, Violation, Check, CheckServices, File, ProjectRuleContext
  backend/                 # netzwerk adapter layer — ALL DELETED in Phase 4
    compile.ts             # Rule -> netzwerk extension
    check-services.ts      # CheckServices backed by a netzwerk Network
    syntax-extension.ts    # parses files into netzwerk markers
    violation-markers.ts   # Violation <-> netzwerk marker mapping
  services/
    fs.ts                  # FileSystem Effect service (fast-glob) — KEPT
    syntax-tree.ts         # SyntaxBackend interface + SyntaxTree tag — KEPT
    import-resolver.ts     # ImportResolver tag + relative-path default — KEPT
  primitives/select.ts     # select() -> Rule with `perFile`
  primitives/graph.ts      # noCycles — has an Effect `run` AND a netzwerk `project`
  architecture.ts          # defineArchitecture — has an Effect `run` AND a netzwerk `project`
```

### Rule kinds (decides how each is cached)

- **per-file rule** — `Rule.perFile` is set, by `select()` only
  (`packages/core/src/primitives/select.ts`, `buildRule`). Cached **per file**.
- **project rule** — `Rule.project` is set, by all ten tool adapters
  (`packages/eslint`, `vitest`, `oxlint`, `oxfmt`, `prettier`, `phpstan`, `pest`,
  `phpunit`, `bun-test`, `storybook`). Every adapter's `project.run` **ignores its
  context argument** and only supplies `patterns` for change detection
  (verified in `packages/eslint/src/adapter.ts` and `packages/vitest/src/adapter.ts`).
  Cached **per project**, keyed by the file hashes matching `patterns`.
- **run-only rule** — neither field. After this plan: `noCycles` and
  `defineArchitecture` (their netzwerk `project` blocks are deleted). Cached
  **per project**, keyed by all candidate file hashes.

### Key existing behaviours that must be preserved

- `runAll` returns `Effect.Effect<RunResult, never, never>` and never fails.
  `RunResult` has `byRule`, `byCategory`, `totalViolations`, `passing`.
- Category scores: `weighted = errors*1 + warnings*0.5 + infos*0.1`, then
  `score = max(0, round((10 - weighted) * 10) / 10)`; threshold defaults to 7.
- `RunAllOptions` is `{ fileFilter?: readonly string[] | null | undefined; onScan?: (result: ScanStats) => void }`.
  `ScanStats` is `{ filesSeen, added, changed, removed, reused, durationMs }`.
- Exemptions, `--files` (`fileFilter`), and `--since` (`changedSince`) are
  **aggregation-time filters** applied to the final violation list. They must
  never influence what is computed or cached.
- `applyExemptions(violations, exemptions, ruleId)` is exported and tested.
- Violation paths are repo-relative with posix separators.

### Files created by this plan

```
packages/core/src/cache/README.md          # extraction contract + API docs
packages/core/src/cache/types.ts           # FileRef, CacheEntry, CacheStore
packages/core/src/cache/hash.ts            # hashBytes, hashValue
packages/core/src/cache/kernel.ts          # sync()
packages/core/src/cache/store-memory.ts
packages/core/src/cache/store-sqlite.ts
packages/core/src/cache/store-json.ts
packages/core/src/cache/index.ts
packages/core/src/engine/cache-store.ts    # GesetzStorageConfig -> CacheStore
packages/core/src/engine/rule-fingerprint.ts
packages/core/src/engine/syntax-markers.ts
packages/core/src/engine/discovery.ts
packages/core/src/engine/services-layer.ts
packages/core/src/services/check-services.ts
packages/core/tests/cache/kernel.test.ts
packages/core/tests/cache/store-memory.test.ts
packages/core/tests/cache/store-sqlite.test.ts
packages/core/tests/cache/store-json.test.ts
packages/core/tests/cache/purity.test.ts
packages/core/tests/services/check-services.test.ts
packages/core/tests/engine/discovery.test.ts
packages/core/tests/engine/syntax-markers.test.ts
```

### Files deleted by this plan

```
packages/core/src/backend/compile.ts
packages/core/src/backend/check-services.ts
packages/core/src/backend/syntax-extension.ts
packages/core/src/backend/violation-markers.ts
packages/core/tests/backend/compile.test.ts
packages/core/tests/backend/check-services.test.ts
packages/core/tests/backend/netzwerk-smoke.test.ts
packages/core/tests/backend/syntax-extension.test.ts
packages/core/tests/backend/violation-markers.test.ts
```

---

## Scope

**In scope (exact paths):**

- `packages/core/src/cache/**`
- `packages/core/src/engine/runner.ts`, `config.ts`, `rule.ts`
- `packages/core/src/engine/cache-store.ts`, `rule-fingerprint.ts`,
  `syntax-markers.ts`, `discovery.ts`, `services-layer.ts`
- `packages/core/src/services/check-services.ts`
- `packages/core/src/primitives/graph.ts` (remove the netzwerk `project` block only)
- `packages/core/src/architecture.ts` (remove the netzwerk `project` block only)
- `packages/core/src/index.ts` (exports)
- `packages/core/package.json`, `packages/core/tsconfig.json`
- `packages/core/tests/**`
- `packages/cli/src/main.ts` (storage resolution only)
- `README.md`, `UPGRADE.md`, `CHANGELOG.md`, `packages/core/TESTING.md`

**Out of scope:**

- The ten adapter packages under `packages/{eslint,vitest,oxlint,oxfmt,prettier,phpstan,pest,phpunit,bun-test,storybook}/`.
  Their `project: { patterns, run }` blocks ignore the context argument and need
  no changes. **Do not edit them.**
- `packages/{typescript,php,effect-ts,junit,laravel,gesetz}/**`.
- `.github/**`, `docs/**`, `tutorials/**`, `resources/**`.
- Any other repo on the machine (`/root/dev/netzwerk`, `/root/dev/briefkasten`, …).
  This plan touches only this worktree.

**Forbidden actions (do not do these under any circumstances):**

- Do NOT add any dependency to `packages/core/package.json`. The only dependency
  change permitted is **removing** `netzwerk`.
- Do NOT import anything from `netzwerk` anywhere after Phase 4. Zero references.
- Do NOT import from outside `packages/core/src/cache/` (or from a non-`node:`
  module) inside `packages/core/src/cache/`.
- Do NOT change the `Rule.project` or `Rule.perFile` shapes, and do NOT edit the
  ten adapter packages.
- Do NOT change the scoring formula, `RunResult` shape, `Violation` shape,
  `CategoryScore` shape, or `ScanStats` shape.
- Do NOT introduce a file-size cap, binary sniffing, or git `statusMatrix`
  discovery. Discovery is fast-glob over rule patterns plus the existing
  `node_modules`/`.git` ignores.
- Do NOT apply `fileFilter` (`--files`) or `changedSince` (`--since`) at compute
  time. They are aggregation-time filters only.
- Do NOT run `git commit`, `git push`, or `git checkout`. The user handles git.
- Do NOT weaken `strict`, `noUncheckedIndexedAccess`, or `exactOptionalPropertyTypes`.

---

## Acceptance criteria

A human can verify all of these after Phase 4.

- `grep -rn "netzwerk" packages/*/src packages/*/tests packages/core/package.json`
  prints **nothing**.
- `grep -rn "netzwerk" pnpm-lock.yaml` prints nothing for `packages/core`.
- `cd packages/core && pnpm test` → all tests pass, including `tests/cache/*`.
- `cd packages/core && pnpm typecheck` → 0 errors.
- `node -e "import('@gesetz/core')"` inside `packages/core` succeeds without
  loading any native module.
- In a temp project with two files, `runAll` with `storage: { kind: 'sqlite', path }`
  creates **that exact file**, and a second run reuses cache (incremental test in
  `tests/engine/runner-incremental.test.ts` covers this).
- The 64 KB regression is fixed: a `.ts` file larger than 64 KB containing
  `console.log` produces a violation (covered by a new test in
  `tests/engine/runner-incremental.test.ts`).
- In a git repository, files matched by `.gitignore` are not scanned and
  untracked-but-not-ignored files are scanned (covered by the git describe block
  in `tests/engine/discovery.test.ts`).
- `packages/core/src/cache/README.md` exists and documents the extraction contract.
- `tests/cache/purity.test.ts` passes and fails if a relative import or non-`node:`
  import is added to `src/cache/`.

---

## Architecture

### Data flow

```
runAll(config, options)
   │
   ├─ createConfiguredStore(config.storage)      → CacheStore (memory|sqlite|json)
   │
   ├─ discoverCandidateFiles(config)             → FileRef[]   [src/engine/discovery.ts]
   │      git ls-files --cached --others --exclude-standard (honours .gitignore),
   │      else fast-glob walk; then filter by the union of
   │      perFile.patterns + project.patterns, minus node_modules/.git.
   │      No size cap.
   │
   ├─ sync({ scope:'gesetz-syntax', fingerprint: syntaxFingerprint(adapters) })
   │      → values: Map<path, SyntaxMarkers>, hashes: Map<path, hash>
   │      parses each CHANGED file once; unchanged files reuse cached parse
   │
   ├─ createCheckServices({ rootDir, backends, syntaxByPath, allPaths })
   │
   ├─ for each per-file rule:
   │      sync({ scope: rule.id, fingerprint: ruleFingerprint(rule),
   │             compute: run rule's checks on one file })
   │      → Map<path, Violation[]>
   │
   ├─ for each project/run-only rule:
   │      hashOfRelevantFiles = hashValue(relevant paths+hashes)
   │      store.get(rule.id, '__project__')  → reuse when hash+fingerprint match,
   │      else run project.run(ctx) / Effect(run) and store
   │
   ├─ aggregate → RuleResult[] in config order
   ├─ apply fileFilter, changedSince, exemptions  (aggregation-time only)
   └─ computeCategoryScores → RunResult
```

### The cache kernel

```ts
// packages/core/src/cache/types.ts
interface CacheStore {
  get(scope, path): Promise<CacheEntry | undefined>;
  put(scope, path, entry): Promise<void>;
  delete(scope, path): Promise<void>;
  entries(scope): Promise<ReadonlyMap<string, CacheEntry>>;
  prune(scope, keep: ReadonlySet<string>): Promise<readonly string[]>;
  clear(scope?): Promise<void>;
  scopes(): Promise<readonly string[]>;
  close(): Promise<void>;
}

// packages/core/src/cache/kernel.ts
sync<Value>({
  scope, store, files, compute,
  fingerprint?, force?, read?, onProgress?,
}): Promise<SyncResult<Value>>

interface SyncResult<Value> {
  values: ReadonlyMap<string, Value>;
  hashes: ReadonlyMap<string, string>;
  added: readonly string[];
  changed: readonly string[];
  removed: readonly string[];
  reused: readonly string[];
  durationMs: number;
}
```

`CacheEntry.hash` is the file content hash at compute time.
`CacheEntry.meta.fingerprint` is the scope fingerprint. Either mismatch ⇒ recompute.

### Cache scopes used by gesetz

| Scope | Key | Value | Fingerprint |
|---|---|---|---|
| `gesetz-syntax` | file path | `SyntaxMarkers` | `syntaxFingerprint(adapters)` |
| `<rule.id>` (per-file) | file path | `Violation[]` | `ruleFingerprint(rule)` |
| `<rule.id>` (project) | `__project__` | `Violation[]` | `ruleFingerprint(rule)` |

### SQLite schema

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS cache_entries (
  scope       TEXT NOT NULL,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  fingerprint TEXT,
  value       TEXT NOT NULL,        -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, path)
);
CREATE INDEX IF NOT EXISTS cache_entries_scope ON cache_entries (scope);
```

---

## Phases & tasks

### Phase 1: The extractable cache module

Build `src/cache/` as a standalone, dependency-free module with tests. Nothing in
gesetz imports it yet, so the repo stays green throughout.

#### Task 1.1: Cache types

**Why:** Defines the storage port that every adapter implements and the kernel
depends on. Getting this shape right is what makes extraction possible.

**Files:**
- Create: `packages/core/src/cache/types.ts`

**Steps:**

- [ ] **Step 1:** Create `packages/core/src/cache/types.ts` with exactly:

```ts
/**
 * Storage port for the incremental cache.
 *
 * Deliberately tiny: get/put/delete/entries/prune/clear/scopes/close. Every
 * adapter in this directory implements it, and the kernel depends on nothing
 * else. Keep it free of gesetz concepts (rules, violations, syntax) so this
 * directory can be lifted into its own package unchanged.
 */

/** A file the cache tracks. Paths are repo-relative with posix separators. */
export interface FileRef {
  readonly path: string;
  readonly absolutePath: string;
}

/** One cached computation for one (scope, path) pair. */
export interface CacheEntry<Value = unknown> {
  /** Content hash of the file at the time `value` was computed. */
  readonly hash: string;
  /** The cached payload. Must be JSON-serialisable. */
  readonly value: Value;
  /**
   * Extra validity material. The kernel stores `fingerprint` here: when it
   * differs from the incoming fingerprint, the entry is recomputed even if the
   * content hash is unchanged. This is how a rule edit invalidates its cache.
   */
  readonly meta?: Readonly<Record<string, string>> | undefined;
}

/** Storage backend for the incremental cache. */
export interface CacheStore {
  get<Value = unknown>(scope: string, path: string): Promise<CacheEntry<Value> | undefined>;
  put<Value = unknown>(scope: string, path: string, entry: CacheEntry<Value>): Promise<void>;
  delete(scope: string, path: string): Promise<void>;
  /** Every entry in `scope`, keyed by path. */
  entries<Value = unknown>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>>;
  /** Deletes entries in `scope` whose path is not in `keep`. Returns removed paths. */
  prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]>;
  /** Deletes every entry in `scope`, or everything when `scope` is omitted. */
  clear(scope?: string): Promise<void>;
  /** Names of all scopes that currently hold at least one entry. */
  scopes(): Promise<readonly string[]>;
  close(): Promise<void>;
}
```

#### Task 1.2: Hashing helpers

**Why:** Content hashing is the only reuse signal in the kernel; fingerprinting
uses the same primitives.

**Files:**
- Create: `packages/core/src/cache/hash.ts`

**Steps:**

- [ ] **Step 1:** Create `packages/core/src/cache/hash.ts` with exactly:

```ts
import { createHash } from 'node:crypto';

/** SHA-1 hex digest of a byte buffer. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/**
 * SHA-1 hex digest of a JSON-serialisable value. Used for scope fingerprints
 * (rule identity, syntax-backend identity, project-wide file sets).
 */
export function hashValue(value: unknown): string {
  return hashBytes(Buffer.from(JSON.stringify(value) ?? 'null', 'utf8'));
}
```

#### Task 1.3: Memory store + its test

**Why:** Required by the kernel tests, by `runAll`'s default `{ kind: 'memory' }`
storage, and by every test that must not touch disk.

**Files:**
- Create: `packages/core/src/cache/store-memory.ts`
- Test: `packages/core/tests/cache/store-memory.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/cache/store-memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../src/cache/store-memory';

describe('createMemoryStore', () => {
  it('stores and reads entries per scope', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: [1] });
    await store.put('b', 'x.ts', { hash: 'h2', value: [2] });
    expect(await store.get('a', 'x.ts')).toEqual({ hash: 'h1', value: [1] });
    expect(await store.get('b', 'x.ts')).toEqual({ hash: 'h2', value: [2] });
    expect(await store.get('a', 'missing.ts')).toBeUndefined();
  });

  it('lists entries and scopes', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    expect([...(await store.entries('a')).keys()].sort()).toEqual(['x.ts', 'y.ts']);
    expect(await store.scopes()).toEqual(['a']);
  });

  it('prunes only paths not in keep', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    const removed = await store.prune('a', new Set(['x.ts']));
    expect(removed).toEqual(['y.ts']);
    expect((await store.entries('a')).size).toBe(1);
  });

  it('clears one scope or everything', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('b', 'x.ts', { hash: 'h1', value: 1 });
    await store.clear('a');
    expect(await store.scopes()).toEqual(['b']);
    await store.clear();
    expect(await store.scopes()).toEqual([]);
  });

  it('deletes a single entry', async () => {
    const store = createMemoryStore();
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.delete('a', 'x.ts');
    expect(await store.get('a', 'x.ts')).toBeUndefined();
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails (module not found).
      ```bash
      cd packages/core && pnpm test tests/cache/store-memory.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/cache/store-memory`.

- [ ] **Step 3:** Create `packages/core/src/cache/store-memory.ts` with exactly:

```ts
import type { CacheEntry, CacheStore } from './types';

/** In-memory store. Used for `{ kind: 'memory' }`, tests, and one-shot runs. */
export function createMemoryStore(): CacheStore {
  const data = new Map<string, Map<string, CacheEntry>>();

  const scopeOf = (scope: string): Map<string, CacheEntry> => data.get(scope) ?? new Map();

  return {
    async get<Value>(scope: string, path: string): Promise<CacheEntry<Value> | undefined> {
      return scopeOf(scope).get(path) as CacheEntry<Value> | undefined;
    },

    async put<Value>(scope: string, path: string, entry: CacheEntry<Value>): Promise<void> {
      const map = data.get(scope) ?? new Map<string, CacheEntry>();
      map.set(path, entry as CacheEntry);
      data.set(scope, map);
    },

    async delete(scope: string, path: string): Promise<void> {
      data.get(scope)?.delete(path);
    },

    async entries<Value>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>> {
      return new Map(scopeOf(scope)) as ReadonlyMap<string, CacheEntry<Value>>;
    },

    async prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
      const map = data.get(scope);
      if (map === undefined) return [];
      const removed: string[] = [];
      for (const path of [...map.keys()]) {
        if (!keep.has(path)) {
          map.delete(path);
          removed.push(path);
        }
      }
      return removed;
    },

    async clear(scope?: string): Promise<void> {
      if (scope === undefined) data.clear();
      else data.delete(scope);
    },

    async scopes(): Promise<readonly string[]> {
      return [...data.keys()].filter((scope) => (data.get(scope)?.size ?? 0) > 0);
    },

    async close(): Promise<void> {
      data.clear();
    },
  };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/cache/store-memory.test.ts
      ```
      Expected: PASS (5 tests).

#### Task 1.4: The sync kernel + its test

**Why:** This is the only genuinely novel code in the plan — the hash/diff/reuse
policy that replaces netzwerk's scan.

**Files:**
- Create: `packages/core/src/cache/kernel.ts`
- Test: `packages/core/tests/cache/kernel.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/cache/kernel.test.ts`:

```ts
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sync } from '../../src/cache/kernel';
import { createMemoryStore } from '../../src/cache/store-memory';
import type { FileRef } from '../../src/cache/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-kernel-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function refs(...names: string[]): FileRef[] {
  return names.map((name) => ({ path: name, absolutePath: nodePath.join(dir, name) }));
}

async function write(name: string, content: string): Promise<void> {
  await writeFile(nodePath.join(dir, name), content, 'utf8');
}

describe('cache sync kernel', () => {
  it('computes added files on a cold cache', async () => {
    await write('a.ts', 'a');
    await write('b.ts', 'b');
    const store = createMemoryStore();
    const result = await sync({
      scope: 's',
      store,
      files: refs('a.ts', 'b.ts'),
      compute: async (_file, source) => source.content.toUpperCase(),
    });
    expect(result.added.sort()).toEqual(['a.ts', 'b.ts']);
    expect(result.changed).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.values.get('a.ts')).toBe('A');
    expect(result.hashes.get('b.ts')).toBeDefined();
  });

  it('reuses unchanged files without calling compute', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(calls).toBe(1);
    expect(second.reused).toEqual(['a.ts']);
    expect(second.added).toEqual([]);
    expect(second.values.get('a.ts')).toBe('value');
  });

  it('recomputes changed files and reports them', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const compute = async (_f: unknown, s: { content: string }): Promise<string> => s.content;
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    await write('a.ts', 'a2');
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(second.changed).toEqual(['a.ts']);
    expect(second.values.get('a.ts')).toBe('a2');
  });

  it('removes entries for files that no longer exist', async () => {
    await write('a.ts', 'a');
    await write('b.ts', 'b');
    const store = createMemoryStore();
    const compute = async (_f: unknown, s: { content: string }): Promise<string> => s.content;
    await sync({ scope: 's', store, files: refs('a.ts', 'b.ts'), compute });
    await unlink(nodePath.join(dir, 'b.ts'));
    const second = await sync({ scope: 's', store, files: refs('a.ts'), compute });
    expect(second.removed).toEqual(['b.ts']);
    expect((await store.entries('s')).has('b.ts')).toBe(false);
  });

  it('skips files that vanished between discovery and reading', async () => {
    await write('a.ts', 'a');
    await write('gone.ts', 'g');
    const store = createMemoryStore();
    const compute = async (_f: unknown, s: { content: string }): Promise<string> => s.content;
    await sync({ scope: 's', store, files: refs('a.ts', 'gone.ts'), compute });
    await unlink(nodePath.join(dir, 'gone.ts'));
    const second = await sync({ scope: 's', store, files: refs('a.ts', 'gone.ts'), compute });
    expect(second.removed).toEqual(['gone.ts']);
    expect(second.values.has('gone.ts')).toBe(false);
    expect((await store.entries('s')).has('gone.ts')).toBe(false);
  });

  it('recomputes everything when the fingerprint changes', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), fingerprint: 'v1', compute });
    const second = await sync({ scope: 's', store, files: refs('a.ts'), fingerprint: 'v2', compute });
    expect(calls).toBe(2);
    expect(second.changed).toEqual(['a.ts']);
  });

  it('force recomputes despite an unchanged hash', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return 'value';
    };
    await sync({ scope: 's', store, files: refs('a.ts'), compute });
    await sync({ scope: 's', store, files: refs('a.ts'), force: true, compute });
    expect(calls).toBe(2);
  });

  it('accepts a custom reader', async () => {
    await write('a.ts', 'a');
    const store = createMemoryStore();
    const result = await sync({
      scope: 's',
      store,
      files: refs('a.ts'),
      read: async (file) => ({ content: `custom:${file.path}`, hash: 'fixed' }),
      compute: async (_f, source) => source.content,
    });
    expect(result.values.get('a.ts')).toBe('custom:a.ts');
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pnpm test tests/cache/kernel.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/cache/kernel`.

- [ ] **Step 3:** Create `packages/core/src/cache/kernel.ts` with exactly:

```ts
import { readFile } from 'node:fs/promises';
import { hashBytes } from './hash';
import type { CacheEntry, CacheStore, FileRef } from './types';

/** The bytes + hash handed to `compute` for a file that needs (re)computing. */
export interface FileSource {
  readonly content: string;
  readonly hash: string;
}

export interface SyncProgress {
  readonly done: number;
  readonly total: number;
  readonly current: string;
}

export interface SyncOptions<Value> {
  /** Cache namespace. Use one scope per rule, parser, or extension. */
  readonly scope: string;
  readonly store: CacheStore;
  /** The files to consider. Discovery is the caller's job. */
  readonly files: readonly FileRef[];
  /** Recompute everything, ignoring stored entries and the fingerprint. */
  readonly force?: boolean | undefined;
  /**
   * Validity material for the whole scope. When it differs from the stored
   * fingerprint, every entry in the scope is recomputed. Typical value: a rule
   * or parser fingerprint.
   */
  readonly fingerprint?: string | undefined;
  /** Reads a file into `{ content, hash }`. Default: read bytes, sha1, utf8. */
  readonly read?: ((file: FileRef) => Promise<FileSource>) | undefined;
  /** Computes the cached value for an added or changed file. */
  readonly compute: (file: FileRef, source: FileSource) => Promise<Value>;
  readonly onProgress?: ((event: SyncProgress) => void) | undefined;
}

export interface SyncResult<Value> {
  readonly values: ReadonlyMap<string, Value>;
  readonly hashes: ReadonlyMap<string, string>;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly reused: readonly string[];
  readonly durationMs: number;
}

const READ_CONCURRENCY = 8;

async function defaultRead(file: FileRef): Promise<FileSource> {
  const bytes = await readFile(file.absolutePath);
  return { content: bytes.toString('utf8'), hash: hashBytes(bytes) };
}

/** Runs `fn` over `items` with a bounded number of concurrent calls. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/** Reads a file, returning null when it vanished since discovery. */
async function readSafely(
  read: (file: FileRef) => Promise<FileSource>,
  file: FileRef,
): Promise<FileSource | null> {
  try {
    return await read(file);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Hashes `files`, diffs them against the stored entries for `scope`, recomputes
 * added/changed files via `compute`, prunes entries for vanished files, and
 * returns the full path -> value map.
 *
 * Content hash is the ONLY reuse signal — never mtimes. `fingerprint` and
 * `force` are the two explicit escape hatches for invalidating the scope.
 */
export async function sync<Value>(options: SyncOptions<Value>): Promise<SyncResult<Value>> {
  const startedAt = Date.now();
  const { scope, store, files, compute } = options;
  const read = options.read ?? defaultRead;

  const stored = await store.entries<Value>(scope);
  const fingerprintChanged =
    options.fingerprint !== undefined &&
    [...stored.values()].some((entry) => entry.meta?.['fingerprint'] !== options.fingerprint) &&
    stored.size > 0;

  // Hash phase. A file that vanished between discovery and this read is
  // skipped here and pruned below.
  const sources = await mapConcurrent(files, READ_CONCURRENCY, (file) =>
    readSafely(read, file),
  );

  const added: string[] = [];
  const changed: string[] = [];
  const reused: string[] = [];
  const values = new Map<string, Value>();
  const hashes = new Map<string, string>();
  const toCompute: number[] = [];
  const keep = new Set<string>();

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as FileRef;
    const source = sources[index] as FileSource | null;
    if (source === null) continue;
    keep.add(file.path);
    hashes.set(file.path, source.hash);
    const previous = stored.get(file.path);
    if (
      previous === undefined ||
      previous.hash !== source.hash ||
      options.force === true ||
      fingerprintChanged
    ) {
      if (previous === undefined) added.push(file.path);
      else changed.push(file.path);
      toCompute.push(index);
    } else {
      reused.push(file.path);
      values.set(file.path, previous.value);
    }
  }

  // Compute phase.
  const total = toCompute.length;
  let done = 0;
  for (const index of toCompute) {
    const file = files[index] as FileRef;
    const source = sources[index] as FileSource;
    const value = await compute(file, source);
    values.set(file.path, value);
    const entry: CacheEntry<Value> = {
      hash: source.hash,
      value,
      ...(options.fingerprint !== undefined
        ? { meta: { fingerprint: options.fingerprint } }
        : {}),
    };
    await store.put(scope, file.path, entry);
    done += 1;
    options.onProgress?.({ done, total, current: file.path });
  }

  // Prune phase. `keep` holds only files that were successfully read.
  const removed = await store.prune(scope, keep);

  return { values, hashes, added, changed, removed, reused, durationMs: Date.now() - startedAt };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/cache/kernel.test.ts
      ```
      Expected: PASS (8 tests).

#### Task 1.5: SQLite store + its test

**Why:** The default persistent adapter. Must use built-in `node:sqlite` (no native
build, no `better-sqlite3`).

**Files:**
- Create: `packages/core/src/cache/store-sqlite.ts`
- Test: `packages/core/tests/cache/store-sqlite.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/cache/store-sqlite.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSqliteStore } from '../../src/cache/store-sqlite';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-sqlite-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createSqliteStore', () => {
  it('persists entries across store instances', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const first = await createSqliteStore(path);
    await first.put('rule-a', 'x.ts', {
      hash: 'h1',
      value: [{ message: 'boom', path: 'x.ts' }],
      meta: { fingerprint: 'fp1' },
    });
    await first.close();

    const second = await createSqliteStore(path);
    const entry = await second.get<{ message: string; path: string }[]>('rule-a', 'x.ts');
    expect(entry?.hash).toBe('h1');
    expect(entry?.meta?.['fingerprint']).toBe('fp1');
    expect(entry?.value[0]?.message).toBe('boom');
    await second.close();
  });

  it('prunes, clears, and lists scopes', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const store = await createSqliteStore(path);
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    await store.put('b', 'x.ts', { hash: 'h1', value: 3 });

    expect((await store.prune('a', new Set(['x.ts']))).sort()).toEqual(['y.ts']);
    expect((await store.entries('a')).size).toBe(1);
    expect((await store.scopes()).sort()).toEqual(['a', 'b']);

    await store.clear('a');
    expect(await store.scopes()).toEqual(['b']);
    await store.clear();
    expect(await store.scopes()).toEqual([]);
    await store.close();
  });

  it('deletes a single entry', async () => {
    const path = nodePath.join(dir, 'cache.db');
    const store = await createSqliteStore(path);
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.delete('a', 'x.ts');
    expect(await store.get('a', 'x.ts')).toBeUndefined();
    await store.close();
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pnpm test tests/cache/store-sqlite.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/cache/store-sqlite`.

- [ ] **Step 3:** Create `packages/core/src/cache/store-sqlite.ts` with exactly:

```ts
import type { CacheEntry, CacheStore } from './types';

/**
 * Minimal structural view of `node:sqlite`, declared locally so this module
 * does not depend on the Node type definitions exposing the module (it is
 * experimental and its typings lag across Node versions).
 */
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

interface Row {
  readonly scope: string;
  readonly path: string;
  readonly hash: string;
  readonly fingerprint: string | null;
  readonly value: string;
}

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS cache_entries (
    scope       TEXT NOT NULL,
    path        TEXT NOT NULL,
    hash        TEXT NOT NULL,
    fingerprint TEXT,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (scope, path)
  );
  CREATE INDEX IF NOT EXISTS cache_entries_scope ON cache_entries (scope);
`;

function toEntry<Value>(row: Row): CacheEntry<Value> {
  return {
    hash: row.hash,
    value: JSON.parse(row.value) as Value,
    ...(row.fingerprint !== null ? { meta: { fingerprint: row.fingerprint } } : {}),
  };
}

/**
 * SQLite-backed store using the built-in `node:sqlite` module. Creates the
 * database file if missing and enables WAL. Each operation is its own
 * statement; the sync API is wrapped in resolved promises to satisfy the port.
 *
 * Requires Node >= 23.4 (or >= 22.5 with `--experimental-sqlite`).
 */
export async function createSqliteStore(path: string): Promise<CacheStore> {
  let sqlite: SqliteModule;
  try {
    sqlite = (await import('node:sqlite')) as unknown as SqliteModule;
  } catch (cause) {
    throw new Error(
      `gesetz: the SQLite cache requires Node >= 23.4 (or Node >= 22.5 with --experimental-sqlite). ` +
        `Run without persistence using --full, or set GESETZ_DB to a .json path. Cause: ${String(cause)}`,
    );
  }

  const db = new sqlite.DatabaseSync(path);
  db.exec(SCHEMA);

  return {
    async get<Value>(scope: string, entryPath: string): Promise<CacheEntry<Value> | undefined> {
      const row = db
        .prepare('SELECT scope, path, hash, fingerprint, value FROM cache_entries WHERE scope = ? AND path = ?')
        .get(scope, entryPath) as Row | undefined;
      return row === undefined ? undefined : toEntry<Value>(row);
    },

    async put<Value>(scope: string, entryPath: string, entry: CacheEntry<Value>): Promise<void> {
      db.prepare(
        `INSERT INTO cache_entries (scope, path, hash, fingerprint, value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, path) DO UPDATE SET
           hash = excluded.hash,
           fingerprint = excluded.fingerprint,
           value = excluded.value,
           updated_at = excluded.updated_at`,
      ).run(
        scope,
        entryPath,
        entry.hash,
        entry.meta?.['fingerprint'] ?? null,
        JSON.stringify(entry.value),
        Date.now(),
      );
    },

    async delete(scope: string, entryPath: string): Promise<void> {
      db.prepare('DELETE FROM cache_entries WHERE scope = ? AND path = ?').run(scope, entryPath);
    },

    async entries<Value>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>> {
      const rows = db
        .prepare('SELECT scope, path, hash, fingerprint, value FROM cache_entries WHERE scope = ?')
        .all(scope) as Row[];
      return new Map(rows.map((row) => [row.path, toEntry<Value>(row)]));
    },

    async prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
      const rows = db
        .prepare('SELECT scope, path, hash, fingerprint, value FROM cache_entries WHERE scope = ?')
        .all(scope) as Row[];
      const removed: string[] = [];
      const statement = db.prepare('DELETE FROM cache_entries WHERE scope = ? AND path = ?');
      for (const row of rows) {
        if (!keep.has(row.path)) {
          statement.run(scope, row.path);
          removed.push(row.path);
        }
      }
      return removed;
    },

    async clear(scope?: string): Promise<void> {
      if (scope === undefined) db.prepare('DELETE FROM cache_entries').run();
      else db.prepare('DELETE FROM cache_entries WHERE scope = ?').run(scope);
    },

    async scopes(): Promise<readonly string[]> {
      const rows = db.prepare('SELECT DISTINCT scope FROM cache_entries').all() as Array<{
        scope: string;
      }>;
      return rows.map((row) => row.scope);
    },

    async close(): Promise<void> {
      db.close();
    },
  };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/cache/store-sqlite.test.ts
      ```
      Expected: PASS (3 tests). `node:sqlite` may print an `ExperimentalWarning`
      to stderr on some Node versions — that is acceptable and must not fail the test.

#### Task 1.6: JSON store + its test

**Why:** Debug/small-project adapter and the fallback for Node versions without
`node:sqlite` and for Bun. Keeps the port honest (proves the kernel is not
sqlite-shaped).

**Files:**
- Create: `packages/core/src/cache/store-json.ts`
- Test: `packages/core/tests/cache/store-json.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/cache/store-json.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJsonStore } from '../../src/cache/store-json';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-cache-json-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createJsonStore', () => {
  it('persists to disk on close and reloads', async () => {
    const path = nodePath.join(dir, 'cache.json');
    const first = await createJsonStore(path);
    await first.put('a', 'x.ts', { hash: 'h1', value: { n: 1 }, meta: { fingerprint: 'fp' } });
    await first.close();

    const second = await createJsonStore(path);
    const entry = await second.get<{ n: number }>('a', 'x.ts');
    expect(entry?.hash).toBe('h1');
    expect(entry?.value.n).toBe(1);
    expect(entry?.meta?.['fingerprint']).toBe('fp');
    await second.close();
  });

  it('creates an empty store when the file is missing', async () => {
    const store = await createJsonStore(nodePath.join(dir, 'missing.json'));
    expect(await store.scopes()).toEqual([]);
    await store.close();
  });

  it('prunes and clears', async () => {
    const path = nodePath.join(dir, 'cache.json');
    const store = await createJsonStore(path);
    await store.put('a', 'x.ts', { hash: 'h1', value: 1 });
    await store.put('a', 'y.ts', { hash: 'h2', value: 2 });
    expect((await store.prune('a', new Set(['x.ts']))).sort()).toEqual(['y.ts']);
    await store.clear('a');
    expect(await store.scopes()).toEqual([]);
    await store.close();
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pnpm test tests/cache/store-json.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/cache/store-json`.

- [ ] **Step 3:** Create `packages/core/src/cache/store-json.ts` with exactly:

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { CacheEntry, CacheStore } from './types';

type JsonShape = Record<string, Record<string, CacheEntry>>;

async function load(path: string): Promise<JsonShape> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as JsonShape;
  } catch {
    return {};
  }
}

/**
 * Single-file JSON store. Loads the whole file on open, mutates in memory, and
 * writes atomically (tmp + rename) on close.
 *
 * Intended for debugging, small projects, and environments where `node:sqlite`
 * is unavailable. It rewrites the entire file on close, so it does not scale to
 * large repositories.
 */
export async function createJsonStore(path: string): Promise<CacheStore> {
  const data = await load(path);
  const scopeOf = (scope: string): Record<string, CacheEntry> => data[scope] ?? {};

  const flush = async (): Promise<void> => {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, path);
  };

  return {
    async get<Value>(scope: string, entryPath: string): Promise<CacheEntry<Value> | undefined> {
      return scopeOf(scope)[entryPath] as CacheEntry<Value> | undefined;
    },

    async put<Value>(scope: string, entryPath: string, entry: CacheEntry<Value>): Promise<void> {
      const bucket = data[scope] ?? {};
      bucket[entryPath] = entry as CacheEntry;
      data[scope] = bucket;
    },

    async delete(scope: string, entryPath: string): Promise<void> {
      if (data[scope] !== undefined) delete data[scope][entryPath];
    },

    async entries<Value>(scope: string): Promise<ReadonlyMap<string, CacheEntry<Value>>> {
      return new Map(Object.entries(scopeOf(scope))) as ReadonlyMap<string, CacheEntry<Value>>;
    },

    async prune(scope: string, keep: ReadonlySet<string>): Promise<readonly string[]> {
      const bucket = data[scope];
      if (bucket === undefined) return [];
      const removed: string[] = [];
      for (const key of Object.keys(bucket)) {
        if (!keep.has(key)) {
          delete bucket[key];
          removed.push(key);
        }
      }
      return removed;
    },

    async clear(scope?: string): Promise<void> {
      if (scope === undefined) {
        for (const key of Object.keys(data)) delete data[key];
      } else {
        delete data[scope];
      }
    },

    async scopes(): Promise<readonly string[]> {
      return Object.keys(data).filter((scope) => Object.keys(scopeOf(scope)).length > 0);
    },

    async close(): Promise<void> {
      await flush();
    },
  };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/cache/store-json.test.ts
      ```
      Expected: PASS (3 tests).

#### Task 1.7: Purity test (enforces extractability)

**Why:** This is the mechanical guarantee that the module can be lifted out
unchanged. Without it, the first stray `../../engine/rule` import silently
destroys the extraction contract.

**Files:**
- Test: `packages/core/tests/cache/purity.test.ts`

**Steps:**

- [ ] **Step 1:** Create `packages/core/tests/cache/purity.test.ts` with exactly:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CACHE_DIR = fileURLToPath(new URL('../../src/cache', import.meta.url));
const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

describe('src/cache is dependency-free and self-contained', () => {
  const files = readdirSync(CACHE_DIR).filter((name) => name.endsWith('.ts'));

  it('contains the expected modules', () => {
    expect(files).toContain('kernel.ts');
    expect(files).toContain('types.ts');
  });

  for (const name of files) {
    it(`${name} imports only node: builtins and ./ siblings`, () => {
      const source = readFileSync(nodePath.join(CACHE_DIR, name), 'utf8');
      const specifiers = [...source.matchAll(IMPORT_RE)].map((match) => match[1] as string);
      for (const specifier of specifiers) {
        const ok = specifier.startsWith('node:') || specifier.startsWith('./');
        expect(ok, `${name} imports "${specifier}"`).toBe(true);
      }
    });
  }
});
```

- [ ] **Step 2:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/cache/purity.test.ts
      ```
      Expected: PASS (1 + N tests; N = number of files in `src/cache/`).

- [ ] **Step 3:** Confirm the guard works: temporarily add
      `import { x } from '../../engine/rule';` to `src/cache/kernel.ts`, run the
      test, confirm it FAILS with `kernel.ts imports "../../engine/rule"`, then
      remove the line and confirm it passes again.
      ```bash
      cd packages/core && pnpm test tests/cache/purity.test.ts
      ```
      Expected: FAIL while the bad import is present; PASS after removing it.

#### Task 1.8: Cache barrel + README

**Why:** The barrel is the module's public surface; the README is the extraction
contract the user explicitly asked for.

**Files:**
- Create: `packages/core/src/cache/index.ts`
- Create: `packages/core/src/cache/README.md`

**Steps:**

- [ ] **Step 1:** Create `packages/core/src/cache/index.ts` with exactly:

```ts
export type { CacheEntry, CacheStore, FileRef } from './types';
export { hashBytes, hashValue } from './hash';
export { sync } from './kernel';
export type { FileSource, SyncOptions, SyncProgress, SyncResult } from './kernel';
export { createMemoryStore } from './store-memory';
export { createSqliteStore } from './store-sqlite';
export { createJsonStore } from './store-json';
```

- [ ] **Step 2:** Create `packages/core/src/cache/README.md` with exactly:

```markdown
# `src/cache` — incremental file cache

A tiny, dependency-free kernel for **content-hash incremental file processing**.

It answers one question: *"which files changed since last time, and what did I
compute for the ones that didn't?"* It hashes files, diffs them against a storage
adapter, recomputes only what changed, and remembers the rest.

It knows nothing about gesetz. There is no mention of rules, violations, syntax,
markers, or graphs in this directory — and there must never be.

## Why this exists

Gesetz used to get this behaviour from the `netzwerk` library. Netzwerk's scan
worked, but the dependency brought ~856 MB of `node_modules` (onnxruntime,
transformers, sharp, libsql, tree-sitter), silently skipped files over 64 KB, and
ignored its own configured cache path. The kernel here is the ~250 lines gesetz
actually needed, with none of that.

## The contract

> **This directory imports only `node:*` builtins and `./` siblings.**
> `tests/cache/purity.test.ts` fails the build if that is violated.

That single rule is what makes extraction a `git mv` instead of a refactor.

## Extraction checklist

When this becomes its own package:

1. `git mv packages/core/src/cache <new-package>/src`
2. Move `packages/core/tests/cache/` alongside it.
3. Add a `package.json` with `"type": "module"`, `"exports": { ".": "./dist/index.js" }`,
   `"engines": { "node": ">=22.5.0" }`, and **no dependencies**.
4. Add a `tsdown.config.ts` (copy `packages/core/tsdown.config.ts` and drop the
   reporters entry).
5. Publish at `1.0.0` with a real repository and CI. Never publish a `link:` or
   `file:` dependency — that is exactly what broke gesetz `3.0.0-rc.0`/`rc.2`.

Nothing inside `src/cache/` needs to change for any of this.

## API

```ts
import { sync, createSqliteStore, createMemoryStore, createJsonStore } from './cache';

const store = await createSqliteStore('.gesetz/cache.db');

const result = await sync({
  scope: 'my-rule',                 // cache namespace
  store,
  files: [{ path: 'src/a.ts', absolutePath: '/repo/src/a.ts' }],
  fingerprint: 'my-rule@v3',        // invalidates the whole scope when it changes
  compute: async (file, { content, hash }) => {
    return analyse(content);        // any JSON-serialisable value
  },
});

result.values.get('src/a.ts');      // cached or freshly computed
result.added;                       // paths computed for the first time
result.changed;                     // paths recomputed because the hash moved
result.removed;                     // paths pruned because they vanished
result.reused;                      // paths served from cache
result.hashes;                      // path -> content hash
```

### `CacheStore`

```ts
interface CacheStore {
  get(scope, path): Promise<CacheEntry | undefined>;
  put(scope, path, entry): Promise<void>;
  delete(scope, path): Promise<void>;
  entries(scope): Promise<ReadonlyMap<string, CacheEntry>>;
  prune(scope, keep: ReadonlySet<string>): Promise<readonly string[]>;
  clear(scope?): Promise<void>;
  scopes(): Promise<readonly string[]>;
  close(): Promise<void>;
}
```

### Adapters

| Adapter | Factory | Use |
|---|---|---|
| Memory | `createMemoryStore()` | tests, one-shot runs, `--full` |
| SQLite | `await createSqliteStore(path)` | default; `node:sqlite`, WAL, Node ≥ 23.4 (≥ 22.5 with `--experimental-sqlite`) |
| JSON | `await createJsonStore(path)` | debugging, small repos, environments without `node:sqlite`; rewrites the file on close |

## Invariants

- **Content hash is the only reuse signal.** Never mtimes, never git status.
- **`fingerprint` and `force` are the only invalidation levers.** A caller that
  changes what `compute` does MUST change its `fingerprint`; the kernel cannot see
  inside a closure.
- **Discovery is the caller's job.** `sync()` takes a `readonly FileRef[]`.
  Do not add directory walking, gitignore parsing, size caps, or binary sniffing
  here — those are consumer policy.
- **Values must be JSON-serialisable.**
- **Compute is skipped for reused files.** If you need to read every file, write
  that in `read`, not in `compute`.
```

- [ ] **Step 3:** Run the full core suite and typecheck.
      ```bash
      cd packages/core && pnpm test && pnpm typecheck
      ```
      Expected: all pass, 0 type errors.

---

### Phase 2: Netzwerk-free syntax markers and CheckServices

Build `SyntaxMarkers` parsing and the `CheckServices` implementation without any
netzwerk type. The old `backend/` files stay on disk until Phase 4 but are no
longer referenced by anything new.

#### Task 2.1: Syntax markers module + test

**Why:** One parse per file per content hash, shared by every rule — this is half
of the ~20× speedup. It replaces `backend/syntax-extension.ts` without netzwerk's
marker/extension machinery.

**Files:**
- Create: `packages/core/src/engine/syntax-markers.ts`
- Test: `packages/core/tests/engine/syntax-markers.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/engine/syntax-markers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { FileRef } from '../../src/cache/types';
import {
  EMPTY_SYNTAX_MARKERS,
  createSyntaxParser,
  syntaxFingerprint,
} from '../../src/engine/syntax-markers';
import type { SyntaxBackend } from '../../src/services/syntax-tree';

const backend: SyntaxBackend = {
  extensions: ['.ts'],
  extractImports: (content) => (content.includes('import') ? [{ specifier: './x', names: [], line: 1 }] : []),
  extractCalls: () => [{ name: 'foo', line: 2 }],
  extractExports: () => [{ name: 'bar', kind: 'const', line: 3 }],
  extractStructure: () => [
    { kind: 'function', name: 'bar', startLine: 3, endLine: 4, docstring: null, children: [] },
  ],
};

const file: FileRef = { path: 'a.ts', absolutePath: '/repo/a.ts' };

describe('syntax markers', () => {
  it('returns an empty result for an unclaimed extension', () => {
    const parse = createSyntaxParser([backend]);
    expect(parse({ path: 'a.php', absolutePath: '/repo/a.php' }, '<?php')).toEqual(EMPTY_SYNTAX_MARKERS);
  });

  it('extracts imports, calls, exports and structure for a claimed extension', () => {
    const parse = createSyntaxParser([backend]);
    const markers = parse(file, 'import x from "./x";');
    expect(markers.imports).toEqual([{ specifier: './x', names: [], line: 1 }]);
    expect(markers.calls).toEqual([{ name: 'foo', line: 2 }]);
    expect(markers.exports).toEqual([{ name: 'bar', kind: 'const', line: 3 }]);
    expect(markers.structure[0]?.name).toBe('bar');
  });

  it('fingerprints by version and backend extension ownership', () => {
    const a = syntaxFingerprint([backend]);
    const b = syntaxFingerprint([{ ...backend, extensions: ['.tsx'] }]);
    expect(a).toBe(syntaxFingerprint([backend]));
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pnpm test tests/engine/syntax-markers.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/engine/syntax-markers`.

- [ ] **Step 3:** Create `packages/core/src/engine/syntax-markers.ts` with exactly:

```ts
import { hashValue } from '../cache';
import type { FileRef } from '../cache/types';
import type {
  ParsedCall,
  ParsedExport,
  ParsedImport,
  StructureItem,
  SyntaxBackend,
} from '../services/syntax-tree';

/**
 * Shape version for cached syntax markers. Bump this whenever any marker shape
 * changes — it is part of the scope fingerprint, so a bump forces a full
 * re-parse of the project.
 */
export const SYNTAX_MARKERS_VERSION = '3';

export interface SyntaxMarkers {
  readonly imports: readonly ParsedImport[];
  readonly calls: readonly ParsedCall[];
  readonly exports: readonly ParsedExport[];
  readonly structure: readonly StructureItem[];
}

export const EMPTY_SYNTAX_MARKERS: SyntaxMarkers = {
  imports: [],
  calls: [],
  exports: [],
  structure: [],
};

/** Bump-safe fingerprint: marker shape version + which backend claims which extension. */
export function syntaxFingerprint(backends: readonly SyntaxBackend[]): string {
  return hashValue({
    version: SYNTAX_MARKERS_VERSION,
    ownership: backends.map((backend) => [...backend.extensions].sort()),
  });
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

/**
 * Creates a parser that maps (file, content) to markers using the first backend
 * that claims the file's extension. Files with no matching backend produce
 * `EMPTY_SYNTAX_MARKERS` (never an error).
 */
export function createSyntaxParser(
  backends: readonly SyntaxBackend[],
): (file: FileRef, content: string) => SyntaxMarkers {
  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) byExt.set(ext, backend);
    }
  }

  return (file: FileRef, content: string): SyntaxMarkers => {
    const backend = byExt.get(extensionOf(file.path));
    if (backend === undefined) return EMPTY_SYNTAX_MARKERS;
    return {
      imports: backend.extractImports(content, file.path),
      calls: backend.extractCalls(content, file.path),
      exports: backend.extractExports(content, file.path),
      structure: backend.extractStructure(content, file.path, true),
    };
  };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/engine/syntax-markers.test.ts
      ```
      Expected: PASS (3 tests).

#### Task 2.2: CheckServices over the syntax map + test

**Why:** Every existing check and adapter consumes `CheckServices`. This rebuilds
that exact contract on a plain `Map<path, SyntaxMarkers>` instead of a netzwerk
`Network`, so checks run unmodified.

**Files:**
- Create: `packages/core/src/services/check-services.ts`
- Test: `packages/core/tests/services/check-services.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/services/check-services.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCheckServices } from '../../src/services/check-services';
import { EMPTY_SYNTAX_MARKERS } from '../../src/engine/syntax-markers';
import type { SyntaxBackend } from '../../src/services/syntax-tree';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-services-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(nodePath.join(dir, 'src/b.ts'), 'export const b = 2;\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const backend: SyntaxBackend = {
  extensions: ['.ts'],
  extractImports: () => [{ specifier: 'react', names: ['useState'], line: 1 }],
  extractCalls: () => [{ name: 'console.log', line: 2 }],
  extractExports: () => [{ name: 'a', kind: 'const', line: 1 }],
  extractStructure: () => [],
};

function services() {
  return createCheckServices({
    rootDir: dir,
    backends: [backend],
    syntaxByPath: new Map([
      ['src/a.ts', { ...EMPTY_SYNTAX_MARKERS, imports: [{ specifier: 'react', names: ['useState'], line: 1 }] }],
    ]),
    allPaths: new Set(['src/a.ts', 'src/b.ts']),
  });
}

describe('createCheckServices', () => {
  it('globs known paths', async () => {
    const files = await services().fs.glob('src/**/*.ts');
    expect(files.map((file) => file.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(files[0]?.content).toContain('export');
  });

  it('reads and checks existence', async () => {
    const bag = services();
    expect(await bag.fs.readFile(nodePath.join(dir, 'src/a.ts'))).toContain('export const a');
    expect(await bag.fs.exists(nodePath.join(dir, 'src/a.ts'))).toBe(true);
    expect(await bag.fs.exists(nodePath.join(dir, 'src/nope.ts'))).toBe(false);
  });

  it('serves cached syntax markers and routes canProcess by extension', async () => {
    const bag = services();
    const file = (await bag.fs.glob('src/a.ts'))[0]!;
    expect(bag.syntax.canProcess(file)).toBe(true);
    const result = await bag.syntax.process(file, { imports: true });
    expect(result.imports).toEqual([{ specifier: 'react', names: ['useState'], line: 1 }]);
  });

  it('returns empty markers for a file with no cached parse', async () => {
    const bag = services();
    const file = (await bag.fs.glob('src/b.ts'))[0]!;
    expect(await bag.syntax.process(file, { imports: true })).toEqual(EMPTY_SYNTAX_MARKERS);
  });

  it('resolves relative imports to absolute paths', async () => {
    const bag = services();
    const file = (await bag.fs.glob('src/b.ts'))[0]!;
    expect(bag.imports.resolve(file, './a')).toBe(nodePath.join(dir, 'src/a'));
    expect(bag.imports.resolve(file, 'react')).toBeNull();
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pkg=packages/core; cd $pkg && pnpm test tests/services/check-services.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/services/check-services`.

- [ ] **Step 3:** Create `packages/core/src/services/check-services.ts` with exactly:

```ts
/**
 * Marker-free CheckServices.
 *
 * Implements the exact v2.0 `CheckServices` contract over a plain file list and
 * a map of cached syntax markers, so every existing Check in @gesetz/* packages
 * runs unmodified:
 *
 *   fs.glob/readFile/exists  → the scanned path set (+ disk fallback)
 *   syntax.process           → cached SyntaxMarkers (never parses)
 *   imports.resolve          → relative-path resolution
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import micromatch from 'micromatch';
import type { CheckServices, File } from '../engine/rule';
import { EMPTY_SYNTAX_MARKERS, type SyntaxMarkers } from '../engine/syntax-markers';
import type { SyntaxBackend, SyntaxTreeProcessOptions } from './syntax-tree';

export interface CreateCheckServicesInput {
  readonly rootDir: string;
  readonly backends: readonly SyntaxBackend[];
  /** Cached parse result per repo-relative path. */
  readonly syntaxByPath: ReadonlyMap<string, SyntaxMarkers>;
  /** Every repo-relative path that was scanned. */
  readonly allPaths: ReadonlySet<string>;
}

function toFile(rootDir: string, relativePath: string, content: string): File {
  const name = nodePath.basename(relativePath);
  const ext = nodePath.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const dir = nodePath.dirname(relativePath);
  return {
    path: relativePath,
    absolutePath: nodePath.join(rootDir, relativePath),
    name,
    stem,
    ext,
    dir: dir === '.' ? '' : dir,
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

/** Builds the CheckServices bag from a scanned file set and cached syntax markers. */
export function createCheckServices(input: CreateCheckServicesInput): CheckServices {
  const { rootDir, backends, syntaxByPath, allPaths } = input;

  const byExt = new Map<string, SyntaxBackend>();
  for (const backend of backends) {
    for (const ext of backend.extensions) {
      if (!byExt.has(ext)) byExt.set(ext, backend);
    }
  }

  const readContent = (relativePath: string): string => {
    try {
      return nodeFs.readFileSync(nodePath.join(rootDir, relativePath), 'utf-8');
    } catch {
      return '';
    }
  };

  return {
    projectRoot: rootDir,

    fs: {
      async glob(pattern: string | string[]): Promise<File[]> {
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        return [...allPaths]
          .filter((path) => micromatch.isMatch(path, patterns, { dot: true }))
          .sort((a, b) => a.localeCompare(b))
          .map((path) => toFile(rootDir, path, readContent(path)));
      },

      async readFile(absolutePath: string): Promise<string> {
        try {
          return nodeFs.readFileSync(absolutePath, 'utf-8');
        } catch {
          return '';
        }
      },

      async exists(absolutePath: string): Promise<boolean> {
        return nodeFs.existsSync(absolutePath);
      },
    },

    syntax: {
      canProcess: (file) => byExt.has(file.ext),

      async process(file, options: SyntaxTreeProcessOptions) {
        const markers = syntaxByPath.get(file.path) ?? EMPTY_SYNTAX_MARKERS;
        return {
          imports: options.imports ? markers.imports : [],
          calls: options.calls ? markers.calls : [],
          exports: options.exports ? markers.exports : [],
          structure: options.structure ? markers.structure : [],
        };
      },
    },

    imports: {
      resolve(fromFile, specifier): string | null {
        if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
        return nodePath.resolve(nodePath.dirname(fromFile.absolutePath), specifier);
      },
    },
  };
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/services/check-services.test.ts
      ```
      Expected: PASS (5 tests).

#### Task 2.3: Phase gate

- [ ] **Step 1:** Run the full suite and typecheck.
      ```bash
      cd packages/core && pnpm test && pnpm typecheck
      ```
      Expected: all previous tests still pass; new cache/syntax/services tests pass;
      0 type errors. No existing file has been modified yet in this phase.

---

### Phase 3: Rewrite the runner on the cache

Replace the netzwerk-driven runner with the kernel-driven one. This is the
riskiest phase; each task ends with the full suite green.

#### Task 3.1: Discovery + test

**Why:** The runner must own file enumeration: no size cap (so the 64 KB silent
skip cannot recur) and full `.gitignore` semantics (via git), with a plain-walk
fallback outside a git repository.

**Files:**
- Create: `packages/core/src/engine/discovery.ts`
- Test: `packages/core/tests/engine/discovery.test.ts`

**Steps:**

- [ ] **Step 1:** Write the failing test `packages/core/tests/engine/discovery.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverCandidateFiles, listProjectFiles } from '../../src/engine/discovery';
import { defineConfig } from '../../src/engine/config';
import { select } from '../../src/primitives/select';

function gitInit(path: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-'));
  await mkdir(nodePath.join(dir, 'src'), { recursive: true });
  await mkdir(nodePath.join(dir, 'node_modules/pkg'), { recursive: true });
  await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(nodePath.join(dir, 'src/b.php'), '<?php\n', 'utf8');
  await writeFile(nodePath.join(dir, 'node_modules/pkg/c.ts'), 'export const c = 1;\n', 'utf8');
  // 140 KB — over netzwerk's deleted 64 KB cap; must be discovered.
  await writeFile(nodePath.join(dir, 'src/big.ts'), '// pad\n'.repeat(20000), 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('discoverCandidateFiles', () => {
  it('unions rule patterns and skips node_modules', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [select('src/**/*.ts').check(async () => [])],
    });
    const files = await discoverCandidateFiles(config);
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(['src/a.ts', 'src/big.ts']);
  });

  it('includes files larger than 64 KB', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [select('src/**/*.ts').check(async () => [])],
    });
    const files = await discoverCandidateFiles(config);
    const big = files.find((file) => file.path === 'src/big.ts');
    expect(big).toBeDefined();
  });

  it('deduplicates overlapping patterns', async () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [
        select('src/**/*.ts').check(async () => []),
        select('src/a.ts').check(async () => []),
      ],
    });
    const files = await discoverCandidateFiles(config);
    expect(files.filter((file) => file.path === 'src/a.ts')).toHaveLength(1);
  });

  it('returns nothing when there are no rules', async () => {
    const config = defineConfig({ projectRoot: dir, rules: [] });
    expect(await discoverCandidateFiles(config)).toEqual([]);
  });
});

describe('discoverCandidateFiles inside a git repository', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-git-'));
    gitInit(repo);
    await mkdir(nodePath.join(repo, 'src'), { recursive: true });
    await mkdir(nodePath.join(repo, 'dist'), { recursive: true });
    await writeFile(nodePath.join(repo, '.gitignore'), 'dist/\n*.log\n', 'utf8');
    await writeFile(nodePath.join(repo, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(nodePath.join(repo, 'src/skip.log'), 'nope\n', 'utf8');
    await writeFile(nodePath.join(repo, 'dist/built.ts'), 'export const b = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('honours .gitignore', async () => {
    const config = defineConfig({
      projectRoot: repo,
      rules: [select('**/*.ts').check(async () => [])],
    });
    const paths = (await discoverCandidateFiles(config)).map((file) => file.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('dist/built.ts');
  });

  it('includes untracked files that are not ignored', async () => {
    expect(listProjectFiles(repo)).toContain('src/a.ts');
  });

  it('still excludes node_modules when it is not gitignored', async () => {
    await mkdir(nodePath.join(repo, 'node_modules/pkg'), { recursive: true });
    await writeFile(nodePath.join(repo, 'node_modules/pkg/d.ts'), 'export const d = 1;\n', 'utf8');
    const config = defineConfig({
      projectRoot: repo,
      rules: [select('**/*.ts').check(async () => [])],
    });
    const paths = (await discoverCandidateFiles(config)).map((file) => file.path);
    expect(paths).not.toContain('node_modules/pkg/d.ts');
  });

  it('returns null from listProjectFiles outside a repository', async () => {
    const plain = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-discovery-plain-'));
    try {
      expect(listProjectFiles(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2:** Run it, confirm it fails.
      ```bash
      cd packages/core && pnpm test tests/engine/discovery.test.ts
      ```
      Expected: FAIL — cannot resolve `../../src/engine/discovery`.

- [ ] **Step 3:** Create `packages/core/src/engine/discovery.ts` with exactly:

```ts
import * as childProcess from 'node:child_process';
import * as nodePath from 'node:path';
import fastGlob from 'fast-glob';
import micromatch from 'micromatch';
import type { FileRef } from '../cache/types';
import type { ResolvedConfig } from './config';

/** Ignored on top of whatever the file source already excludes. */
const ALWAYS_IGNORED = ['**/node_modules/**', '**/.git/**'];

/**
 * Lists every tracked file plus every untracked, non-ignored file, relative to
 * `projectRoot`, by asking git. This honours `.gitignore`, `.git/info/exclude`
 * and `core.excludesFile` exactly, including nested `.gitignore` files.
 *
 * Returns `null` when `projectRoot` is not inside a git repository or when git
 * is unavailable, so the caller can fall back to a plain walk.
 *
 * Note: git lists files that are in the index but deleted from disk. The cache
 * kernel skips files it cannot read, so this is safe.
 */
export function listProjectFiles(projectRoot: string): string[] | null {
  try {
    const output = childProcess.execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return output.split('\0').filter((path) => path !== '');
  } catch {
    return null;
  }
}

/** Plain recursive walk. Cannot honour `.gitignore` — used only outside a repo. */
async function walkProjectFiles(projectRoot: string): Promise<string[]> {
  return fastGlob('**/*', {
    cwd: projectRoot,
    absolute: false,
    dot: true,
    onlyFiles: true,
    unique: true,
    ignore: ALWAYS_IGNORED,
  });
}

function rulePatterns(config: ResolvedConfig): string[] {
  const patterns = new Set<string>();
  for (const rule of config.rules) {
    if (rule.perFile !== undefined) {
      for (const pattern of rule.perFile.patterns) patterns.add(pattern);
    }
    if (rule.project !== undefined) {
      for (const pattern of rule.project.patterns) patterns.add(pattern);
    }
  }
  return [...patterns];
}

/**
 * Enumerates every file any rule could touch: files that are not ignored and
 * match at least one per-file or project rule pattern.
 *
 * There is deliberately NO size cap and NO binary sniffing here. Netzwerk's
 * 64 KB default silently skipped large files; gesetz must never do that.
 */
export async function discoverCandidateFiles(config: ResolvedConfig): Promise<FileRef[]> {
  const patterns = rulePatterns(config);
  if (patterns.length === 0) return [];

  const listed = listProjectFiles(config.projectRoot);
  const all = listed ?? (await walkProjectFiles(config.projectRoot));

  return all
    .filter((path) => !micromatch.isMatch(path, ALWAYS_IGNORED, { dot: true }))
    .filter((path) => micromatch.isMatch(path, patterns, { dot: true }))
    .sort()
    .map((path) => ({
      path,
      absolutePath: nodePath.resolve(config.projectRoot, path),
    }));
}
```

- [ ] **Step 4:** Run it, confirm it passes.
      ```bash
      cd packages/core && pnpm test tests/engine/discovery.test.ts
      ```
      Expected: PASS (8 tests).

#### Task 3.2: Rule fingerprint + cache store factory

**Why:** Explicit invalidation material for each rule scope, and the mapping from
`GesetzStorageConfig` to a `CacheStore`.

**Files:**
- Create: `packages/core/src/engine/rule-fingerprint.ts`
- Create: `packages/core/src/engine/cache-store.ts`
- Modify: `packages/core/src/engine/config.ts` (`GesetzStorageConfig`)

**Steps:**

- [ ] **Step 1:** Create `packages/core/src/engine/rule-fingerprint.ts` with exactly:

```ts
import { hashValue } from '../cache';
import type { Rule } from './rule';

/**
 * Validity material for a rule's cache scope.
 *
 * A change to any field that affects a rule's output MUST change this string;
 * that is the only signal the cache has. `fn.toString()` is used for check
 * bodies because JavaScript offers no structural identity for closures — so a
 * check that closes over mutable configuration must either embed that
 * configuration in the produced function source (as the built-in factories do,
 * since their options appear in their messages) or supply an explicit
 * `rule.fingerprint`.
 */
export function ruleFingerprint(rule: Rule): string {
  if (rule.fingerprint !== undefined && rule.fingerprint !== '') return rule.fingerprint;
  return hashValue({
    v: 1,
    id: rule.id,
    category: rule.category ?? null,
    perFile:
      rule.perFile === undefined
        ? null
        : {
            patterns: rule.perFile.patterns,
            exclusions: rule.perFile.exclusions,
            checks: rule.perFile.checks.map((fn) => fn.toString()),
            predicates: rule.perFile.predicates.map((fn) => fn.toString()),
          },
    project: rule.project === undefined ? null : rule.project.patterns,
  });
}
```

- [ ] **Step 2:** In `packages/core/src/engine/config.ts`, replace the
      `GesetzStorageConfig` declaration with exactly:

```ts
/**
 * Where the incremental cache lives.
 *
 * - `memory` — ephemeral; tests, one-shot runs, `--full`.
 * - `sqlite` — persistent; the CLI default (node:sqlite, WAL).
 * - `json`   — persistent single file; debugging and Node/Bun environments
 *              without `node:sqlite`.
 */
export type GesetzStorageConfig =
  | { readonly kind?: 'memory' | undefined }
  | { readonly kind: 'sqlite'; readonly path: string }
  | { readonly kind: 'json'; readonly path: string };
```

- [ ] **Step 3:** Create `packages/core/src/engine/cache-store.ts` with exactly:

```ts
import { createJsonStore, createMemoryStore, createSqliteStore } from '../cache';
import type { CacheStore } from '../cache';
import type { GesetzStorageConfig } from './config';

/** Instantiates the storage adapter named by a `GesetzStorageConfig`. */
export async function createConfiguredStore(storage: GesetzStorageConfig): Promise<CacheStore> {
  switch (storage.kind) {
    case 'sqlite':
      return createSqliteStore(storage.path);
    case 'json':
      return createJsonStore(storage.path);
    case 'memory':
    case undefined:
      return createMemoryStore();
  }
}
```

- [ ] **Step 4:** Update the `Rule` interface in `packages/core/src/engine/rule.ts`:
  - Add the optional fingerprint field immediately after `guidance`:

```ts
  /**
   * Optional explicit cache-invalidation string. When set, the runner uses it
   * verbatim as the rule's scope fingerprint instead of hashing the rule's
   * shape. Factories whose behaviour is configured at runtime should set this.
   */
  readonly fingerprint?: string | undefined;
```

  - Replace the `ProjectRuleContext` and `NetworkFileLike` declarations with exactly:

```ts
/** Context handed to a project-level rule. */
export interface ProjectRuleContext {
  /** Absolute project root. */
  readonly rootDir: string;
  /** Repo-relative paths that were added or changed in this scan. */
  readonly changedFiles: readonly string[];
}
```

  and delete the entire `NetworkFileLike` interface. Also delete the
  `project.run` type reference to `NetworkFileLike` (it is only via
  `ProjectRuleContext`).

- [ ] **Step 5:** Typecheck the core package to find every now-broken reference.
      ```bash
      cd packages/core && pnpm typecheck
      ```
      Expected: FAIL with errors in `primitives/graph.ts` and `architecture.ts`
      (they use `ctx.network` / `import { NetworkFileLike }`) and in
      `backend/compile.ts`. These are fixed in Tasks 3.3 and 4.1. **Do not fix
      them here** — proceed to Task 3.3.

#### Task 3.3: Drop the netzwerk `project` blocks from `noCycles` and `defineArchitecture`

**Why:** Both duplicate logic that already exists in their Effect `run`. Removing
them deletes netzwerk's `resolveImportEdges` usage and the last `NetworkFileLike`
references, with no behaviour loss.

**Files:**
- Modify: `packages/core/src/primitives/graph.ts`
- Modify: `packages/core/src/architecture.ts`

**Steps:**

- [ ] **Step 1:** In `packages/core/src/primitives/graph.ts`:
  - Delete the line `import { resolveImportEdges } from 'netzwerk';`
  - Delete the line `import type { File, NetworkFileLike, Rule, Violation } from '../engine/rule';`
    and replace it with `import type { File, Rule, Violation } from '../engine/rule';`
  - Delete the entire `project: { ... }` property from the object returned by
    `noCycles` (the block that begins `project: {` around line 132 and ends before
    the closing `};` of the returned `Rule`). The returned object must end as:

```ts
  return {
    id,
    description,
    run,
  };
```

- [ ] **Step 2:** In `packages/core/src/architecture.ts`:
  - Delete the line `import { resolveImportEdges } from 'netzwerk';`
  - Delete the line `import { SYNTAX_EXTENSION } from './backend/syntax-extension';`
  - Delete the line `import type { NetworkFileLike, Rule, Violation } from './engine/rule';`
    and replace it with `import type { Rule, Violation } from './engine/rule';`
  - Delete the entire function `buildLayerProject` (from its doc comment
    `/** Project-rule implementation: ... */` through its closing `}`), and
    change the public factory from:

```ts
export function defineArchitecture(config: ArchitectureConfig): Rule[] {
  const [rule] = [buildLayerRule(config)];
  return [{ ...rule, project: buildLayerProject(config) }];
}
```

    to:

```ts
export function defineArchitecture(config: ArchitectureConfig): Rule[] {
  return [buildLayerRule(config)];
}
```

- [ ] **Step 3:** Confirm the netzwerk `resolveImportEdges` usage is gone.
      ```bash
      grep -rn "resolveImportEdges\|NetworkFileLike" packages/core/src
      ```
      Expected: no output.

#### Task 3.4: Effect layer shim for `Rule.run`

**Why:** Run-only rules and project rules still expose `Rule.run` as an Effect
requiring `FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter`.
This bridges those tags onto the plain `CheckServices` bag.

**Files:**
- Create: `packages/core/src/engine/services-layer.ts`

**Steps:**

- [ ] **Step 1:** Create `packages/core/src/engine/services-layer.ts` with exactly:

```ts
import { Effect, Layer } from 'effect';
import type { CheckServices } from './rule';
import { FileSystem, FileFilter, FileFilterLive, ProjectRoot } from '../services/fs';
import { ImportResolver } from '../services/import-resolver';
import { SyntaxTree, SyntaxTreeError } from '../services/syntax-tree';

/**
 * Bridges the async `CheckServices` bag onto the Effect service tags that
 * `Rule.run` requires, so legacy/project rules execute against the same parsed
 * and globbed view as per-file checks.
 */
export function servicesLayer(
  services: CheckServices,
  fileFilter: readonly string[] | null,
): Layer.Layer<FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter> {
  return Layer.mergeAll(
    Layer.succeed(FileSystem, {
      glob: (pattern, options) => Effect.promise(() => services.fs.glob(pattern, options)),
      readFile: (absolutePath) => Effect.promise(() => services.fs.readFile(absolutePath)),
      exists: (absolutePath) => Effect.promise(() => services.fs.exists(absolutePath)),
    }),
    Layer.succeed(SyntaxTree, {
      canProcess: (file) => services.syntax.canProcess(file),
      process: (file, options) =>
        Effect.tryPromise({
          try: () => services.syntax.process(file, options),
          catch: (cause) => new SyntaxTreeError({ cause: String(cause) }),
        }),
    }),
    Layer.succeed(ImportResolver, {
      resolve: (fromFile, specifier) => services.imports.resolve(fromFile, specifier),
    }),
    Layer.succeed(ProjectRoot, services.projectRoot),
    FileFilterLive(fileFilter),
  );
}
```

**Note:** the exact `SyntaxTreeError` constructor argument shape is defined in
`packages/core/src/services/syntax-tree.ts`; match it. If the tag exists under a
different export name, read that file and use the real one. Do not invent one.

#### Task 3.5: Rewrite the runner

**Why:** This is the core replacement — netzwerk's scan and marker store become
`sync()` calls against the cache.

**Files:**
- Modify (full rewrite): `packages/core/src/engine/runner.ts`

**Steps:**

- [ ] **Step 1:** Replace the entire contents of
      `packages/core/src/engine/runner.ts` with exactly:

```ts
import * as childProcess from 'node:child_process';
import { Effect } from 'effect';
import micromatch from 'micromatch';
import { hashValue, sync } from '../cache';
import type { CacheEntry, FileRef } from '../cache';
import type { Violation, Exemption, CheckServices, File, Rule } from './rule';
import type { ResolvedConfig } from './config';
import { createConfiguredStore } from './cache-store';
import { discoverCandidateFiles } from './discovery';
import { ruleFingerprint } from './rule-fingerprint';
import { createSyntaxParser, syntaxFingerprint, type SyntaxMarkers } from './syntax-markers';
import { createCheckServices } from '../services/check-services';
import { servicesLayer } from './services-layer';

export interface RuleResult {
  readonly ruleId: string;
  readonly description: string;
  readonly category: string | undefined;
  readonly violations: Violation[];
}

export interface CategoryScore {
  readonly category: string;
  readonly score: number;
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly totalViolations: number;
  readonly ruleIds: string[];
  readonly passing: boolean;
}

export interface RunResult {
  readonly byRule: RuleResult[];
  readonly byCategory: CategoryScore[];
  readonly totalViolations: number;
  readonly passing: boolean;
}

export interface RunAllOptions {
  readonly fileFilter?: readonly string[] | null | undefined;
  readonly onScan?: ((result: ScanStats) => void) | undefined;
}

export interface ScanStats {
  readonly filesSeen: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly reused: number;
  readonly durationMs: number;
}

const PROJECT_KEY = '__project__';
const SYNTAX_SCOPE = 'gesetz-syntax';

function resolveChangedFiles(
  changedSince: string | undefined,
  projectRoot: string,
): Set<string> | null {
  if (!changedSince) return null;
  try {
    const output = childProcess
      .execFileSync('git', ['diff', '--name-only', changedSince], {
        cwd: projectRoot,
        encoding: 'utf-8',
      })
      .trim();
    if (!output) return new Set();
    return new Set(output.split('\n').map((p) => p.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

function computeCategoryScores(
  results: RuleResult[],
  thresholds: ResolvedConfig['thresholds'],
): CategoryScore[] {
  const byCategory = new Map<
    string,
    { errors: number; warnings: number; infos: number; ruleIds: string[] }
  >();

  for (const result of results) {
    if (!result.category) continue;
    const existing =
      byCategory.get(result.category) ?? { errors: 0, warnings: 0, infos: 0, ruleIds: [] };
    for (const violation of result.violations) {
      if (violation.severity === 'error') existing.errors += 1;
      else if (violation.severity === 'warn') existing.warnings += 1;
      else existing.infos += 1;
    }
    existing.ruleIds.push(result.ruleId);
    byCategory.set(result.category, existing);
  }

  return Array.from(byCategory.entries()).map(([category, counts]) => {
    const weighted = counts.errors * 1.0 + counts.warnings * 0.5 + counts.infos * 0.1;
    const score = Math.max(0, Math.round((10 - weighted) * 10) / 10);
    const threshold = thresholds.find((t) => t.category === category)?.minScore ?? 7;
    return {
      category,
      score,
      errors: counts.errors,
      warnings: counts.warnings,
      infos: counts.infos,
      totalViolations: counts.errors + counts.warnings + counts.infos,
      ruleIds: counts.ruleIds,
      passing: score >= threshold,
    };
  });
}

export function applyExemptions(
  violations: Violation[],
  exemptions: Exemption[],
  ruleId: string,
): Violation[] {
  const today = new Date().toISOString().slice(0, 10);
  return violations.filter((violation) => {
    return !exemptions.some((exemption) => {
      if (exemption.until !== undefined && exemption.until < today) return false;
      const rulePattern = exemption.rule ?? '*';
      if (!micromatch.isMatch(ruleId, rulePattern)) return false;
      return micromatch.isMatch(violation.path, exemption.path);
    });
  });
}

function matchesPerFile(path: string, perFile: NonNullable<Rule['perFile']>): boolean {
  if (!micromatch.isMatch(path, [...perFile.patterns], { dot: true })) return false;
  if (perFile.exclusions.length > 0 && micromatch.isMatch(path, [...perFile.exclusions], { dot: true })) {
    return false;
  }
  return true;
}

function fileFromRef(reference: FileRef, content: string): File {
  const slash = reference.path.lastIndexOf('/');
  const name = slash === -1 ? reference.path : reference.path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot === -1 ? '' : name.slice(dot);
  const stem = dot === -1 ? name : name.slice(0, dot);
  return {
    path: reference.path,
    absolutePath: reference.absolutePath,
    name,
    stem,
    ext,
    dir: slash === -1 ? '' : reference.path.slice(0, slash),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

async function runChecks(
  rule: Rule,
  reference: FileRef,
  content: string,
  services: CheckServices,
): Promise<Violation[]> {
  const perFile = rule.perFile;
  if (perFile === undefined) return [];
  const file = fileFromRef(reference, content);
  if (!perFile.predicates.every((predicate) => predicate(file))) return [];
  const violations: Violation[] = [];
  for (const check of perFile.checks) {
    try {
      violations.push(...(await check(file, services)));
    } catch {
      // Checks never throw — same contract as the v2 runner.
    }
  }
  return violations.map((violation) => ({ ...violation, rule: violation.rule ?? rule.id }));
}

export const runAll = (
  config: ResolvedConfig,
  options: RunAllOptions = {},
): Effect.Effect<RunResult, never, never> =>
  Effect.promise(async () => {
    const startedAt = Date.now();
    const store = await createConfiguredStore(config.storage);
    const fileFilter = options.fileFilter ?? null;
    const fileFilterActive = fileFilter !== null && fileFilter.length > 0;

    try {
      const candidates = await discoverCandidateFiles(config);
      const changed = new Set<string>();

      // Syntax markers: parse each file at most once per content hash.
      const parse = createSyntaxParser(config.adapters);
      const syntax = await sync<SyntaxMarkers>({
        scope: SYNTAX_SCOPE,
        store,
        files: candidates,
        fingerprint: syntaxFingerprint(config.adapters),
        compute: async (file, source) => parse(file, source.content),
      });
      for (const path of [...syntax.added, ...syntax.changed]) changed.add(path);

      const services = createCheckServices({
        rootDir: config.projectRoot,
        backends: config.adapters,
        syntaxByPath: syntax.values,
        allPaths: new Set(candidates.map((file) => file.path)),
      });

      const violationsByRule = new Map<string, Violation[]>();

      // Per-file rules.
      for (const rule of config.rules) {
        const perFile = rule.perFile;
        if (perFile === undefined) continue;
        const matched = candidates.filter((file) => matchesPerFile(file.path, perFile));
        const result = await sync<Violation[]>({
          scope: rule.id,
          store,
          files: matched,
          fingerprint: ruleFingerprint(rule),
          compute: (file, source) => runChecks(rule, file, source.content, services),
        });
        for (const path of [...result.added, ...result.changed]) changed.add(path);
        violationsByRule.set(rule.id, [...result.values.values()].flat());
      }

      // Project and run-only rules — one cache entry per rule, keyed by the
      // hashes of every file the rule cares about.
      for (const rule of config.rules) {
        if (rule.perFile !== undefined) continue;
        const patterns = rule.project?.patterns ?? null;
        const relevant = patterns === null
          ? candidates
          : candidates.filter((file) => micromatch.isMatch(file.path, [...patterns], { dot: true }));
        const projectHash = hashValue(
          relevant.map((file) => [file.path, syntax.hashes.get(file.path) ?? '']),
        );
        const fingerprint = ruleFingerprint(rule);
        const stored = await store.get<Violation[]>(rule.id, PROJECT_KEY);
        const reusable =
          stored !== undefined &&
          stored.hash === projectHash &&
          stored.meta?.['fingerprint'] === fingerprint;

        if (reusable && stored !== undefined) {
          violationsByRule.set(rule.id, stored.value);
          continue;
        }

        const context = { rootDir: config.projectRoot, changedFiles: [...changed] };
        let violations: Violation[];
        if (rule.project !== undefined) {
          violations = await rule.project.run(context);
        } else {
          try {
            violations = await Effect.runPromise(
              Effect.provide(rule.run, servicesLayer(services, fileFilter)),
            );
          } catch (cause) {
            violations = [
              {
                rule: rule.id,
                message: `Rule threw an unexpected error: ${String(cause)}`,
                path: config.projectRoot,
                severity: 'error',
                source: 'core',
              },
            ];
          }
        }
        const entry: CacheEntry<Violation[]> = {
          hash: projectHash,
          value: violations,
          meta: { fingerprint },
        };
        await store.put(rule.id, PROJECT_KEY, entry);
        violationsByRule.set(rule.id, violations);
      }

      // Aggregation.
      const changedFiles = resolveChangedFiles(config.changedSince, config.projectRoot);

      const buildResult = (
        ruleId: string,
        description: string,
        category: string | undefined,
      ): RuleResult => {
        let violations = violationsByRule.get(ruleId) ?? [];
        if (fileFilterActive && fileFilter !== null) {
          violations = violations.filter((violation) =>
            micromatch.isMatch(violation.path, [...fileFilter]),
          );
        }
        if (changedFiles !== null) {
          violations = violations.filter((violation) => changedFiles.has(violation.path));
        }
        violations = applyExemptions(violations, config.exemptions, ruleId);
        return { ruleId, description, category, violations };
      };

      const results: RuleResult[] = config.rules.map((rule) =>
        buildResult(rule.id, rule.description, rule.category),
      );

      const totalViolations = results.reduce((sum, result) => sum + result.violations.length, 0);
      const byCategory = computeCategoryScores(results, config.thresholds);
      const passing = byCategory.length === 0 || byCategory.every((category) => category.passing);

      options.onScan?.({
        filesSeen: candidates.length,
        added: syntax.added.length,
        changed: syntax.changed.length,
        removed: syntax.removed.length,
        reused: syntax.reused.length,
        durationMs: Date.now() - startedAt,
      });

      return { byRule: results, byCategory, totalViolations, passing };
    } finally {
      await store.close();
    }
  });
```

- [ ] **Step 2:** Typecheck.
      ```bash
      cd packages/core && pnpm typecheck
      ```
      Expected: FAIL only in `src/backend/*` and `tests/backend/*` (Phase 4 removes
      them) — no errors in `src/engine/runner.ts`, `src/engine/services-layer.ts`,
      `src/primitives/graph.ts`, or `src/architecture.ts`. If there are errors in
      those four files, fix them before continuing; the fixes must be minimal and
      must not change behaviour.

#### Task 3.6: Migrate the runner tests

**Why:** The old tests exercised the netzwerk-backed runner. They must now
exercise the cache-backed runner without weakening what they assert.

**Files:**
- Modify: `packages/core/tests/engine/runner.test.ts`
- Modify: `packages/core/tests/engine/runner-incremental.test.ts`
- Modify: `packages/core/tests/engine/project-rules.test.ts`
- Modify: `packages/core/tests/engine/config.test.ts`

**Steps:**

- [ ] **Step 1:** In `packages/core/tests/engine/runner.test.ts`, update the test
      harness so every config has an explicit `projectRoot` pointing at a temp
      directory, and drop the now-unused `TestLayer`/`runWith` machinery (the
      runner no longer reads the ambient Effect environment). The rules in this
      file are run-only rules (`run: Effect.succeed(...)`), so no files need to
      exist. Concretely:
  - Add a `beforeEach` that creates a temp dir and an `afterEach` that removes it.
  - Wherever a config is built, pass `projectRoot: dir`.
  - Keep every assertion about exemptions, `fileFilter`, `changedSince`, scoring,
    and defensive error handling unchanged.

- [ ] **Step 2:** In `packages/core/tests/engine/runner-incremental.test.ts`, keep
      all five existing tests unchanged in intent. Add one new test at the end of
      the `describe` block:

```ts
  it('does not skip files larger than 64 KB', async () => {
    const dbPath = nodePath.join(dir, 'cache.db');
    // ~140 KB, well over netzwerk's deleted 64 KB cap.
    await writeFile(
      nodePath.join(dir, 'src/big.ts'),
      `console.log("big");\n${'// pad\n'.repeat(20_000)}`,
    );
    const result = await run(config(dbPath));
    expect(result.byRule[0]?.violations.map((violation) => violation.path)).toContain('src/big.ts');
  });
```

  Also add one test asserting the configured database path is honoured:

```ts
  it('writes the cache to the configured path', async () => {
    const dbPath = nodePath.join(dir, 'nested', 'custom-cache.db');
    await mkdir(nodePath.dirname(dbPath), { recursive: true });
    await writeFile(nodePath.join(dir, 'src/dirty.ts'), 'console.log("x");\n');
    await run(config(dbPath));
    await expect(stat(dbPath)).resolves.toBeDefined();
  });
```

  Add `stat` to the existing `node:fs/promises` import at the top of the file
  (`mkdir` is already imported).

- [ ] **Step 3:** In `packages/core/tests/engine/project-rules.test.ts`, the
      `noCycles` and `defineArchitecture` tests now exercise their Effect `run`
      path instead of the deleted `project` path. Keep the assertions; if a test
      asserted implementation details of the netzwerk path (for example checking
      `changedFiles`), rewrite it to assert the violation output instead. The
      expected violations for cycles and layer breaches must not change.

- [ ] **Step 4:** In `packages/core/tests/engine/config.test.ts`, add a case for
      the new json variant:

```ts
  it('passes json storage through', () => {
    const config = defineConfig({ rules: [], storage: { kind: 'json', path: '/tmp/x.json' } });
    expect(config.storage).toEqual({ kind: 'json', path: '/tmp/x.json' });
  });
```

- [ ] **Step 5:** Run the engine tests.
      ```bash
      cd packages/core && pnpm test tests/engine
      ```
      Expected: PASS. If a test fails because the runner now performs real
      discovery, fix the test to use a temp `projectRoot` — do not add a
      discovery bypass to production code.

#### Task 3.7: Phase gate

- [ ] **Step 1:** Run the full core suite and typecheck. Errors originating in
      `src/backend/*` / `tests/backend/*` are expected and will be removed in
      Phase 4; nothing else may fail.
      ```bash
      cd packages/core && pnpm test && pnpm typecheck
      ```
      Expected: PASS for every test outside `tests/backend/`; typecheck errors
      only under `src/backend/` and `tests/backend/`.

---

### Phase 4: Remove netzwerk, wire the CLI, update docs

#### Task 4.1: Delete the netzwerk backend layer

**Why:** Nothing imports these after Phase 3; they are the only remaining
netzwerk references in `src/`.

**Files:**
- Delete: `packages/core/src/backend/compile.ts`
- Delete: `packages/core/src/backend/check-services.ts`
- Delete: `packages/core/src/backend/syntax-extension.ts`
- Delete: `packages/core/src/backend/violation-markers.ts`
- Delete: `packages/core/tests/backend/compile.test.ts`
- Delete: `packages/core/tests/backend/check-services.test.ts`
- Delete: `packages/core/tests/backend/netzwerk-smoke.test.ts`
- Delete: `packages/core/tests/backend/syntax-extension.test.ts`
- Delete: `packages/core/tests/backend/violation-markers.test.ts`

**Steps:**

- [ ] **Step 1:** Confirm nothing outside those files references them.
      ```bash
      grep -rn "backend/" packages/core/src packages/core/tests packages/*/src packages/*/tests | grep -v "tests/backend"
      ```
      Expected: no output. If there is output, resolve it before deleting — ask
      the user if it is not obviously a stale import.
- [ ] **Step 2:** Delete the nine files listed above. Remove the now-empty
      `packages/core/src/backend/` and `packages/core/tests/backend/` directories.
      ```bash
      rm -rf packages/core/src/backend packages/core/tests/backend
      ```
- [ ] **Step 3:** Typecheck and test.
      ```bash
      cd packages/core && pnpm typecheck && pnpm test
      ```
      Expected: 0 type errors, all tests pass.

#### Task 4.2: Remove the dependency and its config

**Files:**
- Modify: `packages/core/package.json`
- Modify: `packages/core/tsconfig.json`
- Modify: `packages/core/src/index.ts`

**Steps:**

- [ ] **Step 1:** In `packages/core/package.json`, in `dependencies`:
  - Delete the `"netzwerk": "link:../../../netzwerk/packages/netzwerk"` entry.
  - Delete the `"@types/better-sqlite3": "^7.6.0"` devDependency (it existed only
    for netzwerk's storage types).
  - Delete the `"@types/d3-force": "^3.0.0"` devDependency (it existed only
    because the tsconfig pulled in netzwerk's `d3-force-3d.d.ts`).
  The `dependencies` block must end up as exactly:

```json
  "dependencies": {
    "effect": "^3.15.0",
    "fast-glob": "^3.3.3",
    "micromatch": "^4.0.8"
  },
```

- [ ] **Step 2:** In `packages/core/tsconfig.json`, remove the netzwerk include
      line and its comment so `include` is exactly:

```json
  "include": [
    "src/**/*",
    "tests/**/*"
  ]
```

- [ ] **Step 3:** In `packages/core/src/index.ts`, ensure the cache module is not
  exported publicly (it is internal until extraction). Leave `index.ts` otherwise
  unchanged except for removing nothing — there are currently no netzwerk exports.
  Verify:
      ```bash
      grep -n "netzwerk\|backend" packages/core/src/index.ts
      ```
      Expected: no output.

- [ ] **Step 4:** Refresh the lockfile and confirm the dependency tree.
      ```bash
      pnpm install
      grep -n "netzwerk" pnpm-lock.yaml
      ```
      Expected: `pnpm install` succeeds; the grep prints nothing.

- [ ] **Step 5:** Confirm the published manifest has no `link:`.
      ```bash
      grep -n "link:" packages/*/package.json
      ```
      Expected: no output.

#### Task 4.3: CLI storage resolution

**Why:** Pick the right adapter per environment, honour `GESETZ_DB`, and make
`--full` genuinely bypass persistence. Fixes the documented-but-broken cache path.

**Files:**
- Modify: `packages/cli/src/main.ts`

**Steps:**

- [ ] **Step 1:** Replace the `isBun`/`resolveStorage` block near the top of
      `packages/cli/src/main.ts` with exactly:

```ts
/** True when running under Bun (no `node:sqlite`). */
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/**
 * `node:sqlite` needs Node >= 23.4 to import without a flag (>= 22.5 with
 * `--experimental-sqlite`).
 */
const supportsNodeSqlite = (): boolean => {
  const [major = 0, minor = 0] = process.versions.node.split('.').map((part) => Number(part));
  return major > 23 || (major === 23 && minor >= 4);
};

/**
 * Chooses the cache adapter:
 *   --full                     → memory (no persistence)
 *   GESETZ_DB=off              → memory
 *   sqlite available           → sqlite at GESETZ_DB ?? <root>/.gesetz/cache.db
 *   otherwise                  → json at GESETZ_DB ?? <root>/.gesetz/cache.json
 */
const resolveStorage = (
  root: string,
  full: boolean,
): import('@gesetz/core').GesetzStorageConfig => {
  if (full) return { kind: 'memory' };
  const override = process.env['GESETZ_DB'];
  if (override === 'off') return { kind: 'memory' };

  if (!isBun && supportsNodeSqlite()) {
    const dbPath = override ?? nodePath.join(root, '.gesetz', 'cache.db');
    nodeFs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
    return { kind: 'sqlite', path: dbPath };
  }

  const jsonPath = (override ?? nodePath.join(root, '.gesetz', 'cache')).replace(/\.db$/, '.json');
  nodeFs.mkdirSync(nodePath.dirname(jsonPath), { recursive: true });
  return { kind: 'json', path: jsonPath.endsWith('.json') ? jsonPath : `${jsonPath}.json` };
};
```

- [ ] **Step 2:** Update the two stderr messages in the same file so they are
  accurate. Replace:
  - `'(--full) cache bypassed — running without persistence.'` — keep as is.
  - `'(bun) violation cache disabled — better-sqlite3 is unsupported under Bun.'`
    with `'(bun) using the JSON violation cache — node:sqlite is unavailable under Bun.'`.
  Note: that message is currently only reached when `!opts.full`; keep the guard
  structure (`if (opts.full) {...} else if (isBun) {...}`) unchanged.
- [ ] **Step 3:** Typecheck the CLI package.
      ```bash
      cd packages/cli && pnpm typecheck
      ```
      Expected: 0 errors. `@gesetz/core` must already be rebuilt or resolvable via
      its `dist/`; if the CLI cannot resolve the new types, run
      `pnpm -C packages/core build` first.

#### Task 4.4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `UPGRADE.md`
- Modify: `CHANGELOG.md`
- Modify: `packages/core/TESTING.md`

**Steps:**

- [ ] **Step 1:** In `README.md`, in the "Caching & watch mode" section, replace
  every netzwerk reference. The paragraph currently reads:

      Gesetz stores every detected violation as a marker in a local cache
      (backed by [netzwerk](../netzwerk), SQLite at `.gesetz/cache.db`). Files are
      fingerprinted by content hash, so repeat runs only re-check the files you
      actually edited — unchanged files are served from the cache:

  Replace it with:

      Gesetz stores every detected violation in a local cache (SQLite at
      `.gesetz/cache.db`, using Node's built-in `node:sqlite`). Files are
      fingerprinted by content hash, so repeat runs only re-check the files you
      actually edited — unchanged files are served from the cache:

  In the bullet list underneath, replace the Bun bullet with:

      - Under **Bun**, or on Node versions without `node:sqlite` (Node < 23.4),
        gesetz uses a single-file JSON cache at `.gesetz/cache.json` instead.

  Then add one sentence at the end of the "Caching & watch mode" section:

      Discovery honours `.gitignore` — gesetz asks git for the file list. Outside
      a git repository it walks the directory tree instead, and cannot honour
      `.gitignore`.

- [ ] **Step 2:** In `UPGRADE.md`, in the `v3.0 — Netzwerk-backed engine`
  section, rename the heading to `v3.0 — Incremental cache (no netzwerk)` and
  replace the two paragraphs after "One-line summary" with:

      The rule-execution backend now runs on the built-in incremental cache in
      `@gesetz/core`. Rules are evaluated per file and stored in a content-hash
      cache (SQLite via `node:sqlite`), so `gesetz check` re-checks only changed
      files on repeat runs. **The public API is unchanged** — no migration needed
      for configs, custom checks, or adapters.

  Then replace the "Under Bun the cache is disabled" bullet with:

      - Under **Bun**, or on Node < 23.4, the cache is a single JSON file
        (`.gesetz/cache.json`) instead of SQLite. `--full` disables persistence
        entirely.

  Keep the remaining bullets about `.gesetz/`, `GESETZ_DB`, config fingerprints,
  the `storage` field, and `runAll(config, options?)` — they are still true. Add
  the new `json` variant to the `storage` bullet:

      - `defineConfig` accepts an optional `storage` field
        (`{ kind: 'sqlite', path }`, `{ kind: 'json', path }`, or
        `{ kind: 'memory' }`, default memory).

- [ ] **Step 3:** In `CHANGELOG.md`, add a new entry at the top (below the
  front-matter paragraph, above `## [2.0.0]`):

```markdown
## [3.0.0] — unreleased

### Changed

- **Removed the `netzwerk` runtime dependency.** The incremental engine is now a
  self-contained, dependency-free cache in `@gesetz/core` (`src/cache/`). A cold
  run and a warm run behave as before; the install shrinks from ~856 MB of
  transitive dependencies (onnxruntime, transformers, sharp, libsql,
  tree-sitter) to zero.

### Fixed

- The violation cache is now written to the configured path (`.gesetz/cache.db`,
  or `GESETZ_DB`) instead of a global `~/.fabrik/netzwerk.db`.
- Files larger than 64 KB are no longer silently skipped.
- `gesetz check --full` now genuinely bypasses persistence.
```

- [ ] **Step 4:** In `packages/core/TESTING.md`:
  - Delete the row for `src/backend/compile.ts`.
  - Change the `noCycles` row's description to
    `noCycles — project-level; uses the Effect run path and cached syntax markers`.
  - Replace the "Known gaps" note that mentions the netzwerk `resolveImportEdges`
    integration with:

```markdown
1. **`noCycles`** — tested through integration-level tests in
   `tests/engine/project-rules.test.ts`. Cycle detection runs over the cached
   syntax markers; no netzwerk import-edge resolution is involved.
```

---

## Validation

Run these from the repo root unless noted.

```bash
# 1. No netzwerk anywhere
grep -rn "netzwerk" packages/*/src packages/*/tests packages/*/package.json
# Expected: no output

grep -n "netzwerk" pnpm-lock.yaml
# Expected: no output

# 2. Cache module is dependency-free
cd packages/core && pnpm test tests/cache/purity.test.ts
# Expected: PASS

# 3. Full core suite
cd packages/core && pnpm test
# Expected: all green

# 4. Types
cd packages/core && pnpm typecheck
# Expected: 0 errors

# 5. Build the packages that export types
pnpm -C packages/core build && pnpm -C packages/cli build
# Expected: both succeed

# 6. Consumer smoke test: the engine runs and is incremental
cd packages/core && pnpm test tests/engine/runner-incremental.test.ts
# Expected: PASS, including the ">64 KB" and "configured path" tests

# 7. CLI dogfood (from the repo root, after building)
node packages/cli/dist/main.js check
# Expected: prints a `scan: N files — +A ~C -R =U reused` line to stderr and a
# category table to stdout; exit 0 or 1 depending on the repo's own score.
# A second identical invocation must report `+0 ~0` and complete faster.
```

---

## Risks & rollback

- **Risk:** Discovery defers to `git ls-files` inside a git repository, so
  `.gitignore` is honoured exactly (as it was under netzwerk). Outside a git
  repository it walks with fast-glob and cannot honour `.gitignore`; a
  non-repo directory containing a `.gitignore` will see files that would
  otherwise be ignored.
  **Mitigation:** Document the non-git fallback in `README.md` (Task 4.4 Step 1)
  and keep the `UPGRADE.md` bullet about `.gitignore`-excluded files, which stays
  true for git repositories — verify its wording after Task 4.4.
- **Risk:** `git ls-files --cached` lists index entries whose working-tree file was
  deleted. A naive read would throw `ENOENT` and crash the run.
  **Mitigation:** The kernel's `readSafely` skips unreadable files and prunes their
  entries; covered by `tests/cache/kernel.test.ts`.
- **Risk:** `fn.toString()`-based fingerprints still miss closed-over values, so
  an inline check whose configuration changes outside the function source can
  serve stale results.
  **Mitigation:** Unchanged from the current design, but now exposed as
  `rule.fingerprint` for factories that need explicit control, documented in
  `rule-fingerprint.ts`. Do not attempt to fix closure identity in this plan.
- **Risk:** Per-file rule execution is now sequential in the runner (the old
  netzwerk path ran files through a worker pool). On a cold cache this could be
  slower.
  **Mitigation:** The compute phase is only hit for added/changed files; the
  20 s cold cost is dominated by the syntax parser and is unchanged. If the cold
  path regresses measurably, parallelise the per-file compute loop in a follow-up
  — do NOT do it in this plan (the kernel's `sync` contract is sequential by design).
- **Risk:** `node:sqlite` prints an `ExperimentalWarning` on some Node versions
  and is unavailable on Node < 22.5.
  **Mitigation:** Lazy import with a clear error; CLI falls back to JSON.
- **Rollback:** Every phase is additive until Phase 4. `git revert` of the Phase 4
  commits restores netzwerk; the cache module is inert without wiring. If Phase 3
  regresses, revert only the runner commit — the old `backend/` files still exist
  at that point (they are deleted only in Phase 4).

---

## Decisions taken (previously open questions)

- **Node support: native `node:sqlite` only.** No `better-sqlite3` optional peer is
  added. Persistent SQLite requires Node ≥ 23.4 (or ≥ 22.5 with
  `--experimental-sqlite`); everywhere else the CLI falls back to the JSON
  adapter, and `--full`/`GESETZ_DB=off` use memory. Decided by the user.
- **`.gitignore` is supported.** Discovery asks git
  (`git ls-files -z --cached --others --exclude-standard -- .`), which honours
  `.gitignore`, `.git/info/exclude` and `core.excludesFile` with full nested-file
  semantics. No new dependency: gesetz already shells out to git for `--since`.
  Outside a git repository, discovery falls back to a plain fast-glob walk that
  cannot honour `.gitignore` — documented behaviour, not an omission. Decided by
  the user.

There are no open questions blocking implementation.

---

## Progress

**This section is maintained by the implementing agent. Update it continuously.**

### Phase completion

- [ ] Phase 1: The extractable cache module
- [ ] Phase 2: Netzwerk-free syntax markers and CheckServices
- [ ] Phase 3: Rewrite the runner on the cache
- [ ] Phase 4: Remove netzwerk, wire the CLI, update docs
- [ ] Validation complete
- [ ] Plan marked DONE

### Session log

*The implementing agent appends an entry here after each phase or working
session. Include: what was completed, what was skipped and why, what comes next,
and any decisions made (with rationale). This log is the handoff document — a
new agent reading only this file must be able to continue without asking.*

---
*(no entries yet)*
