# Daemon mode — raw codebase findings

Companion to `PLAN.md`. Facts only, gathered from the working tree; reasoning and
decisions live in the plan.

---

## 1. Machinery that already exists and the daemon can build on

| Path | What it gives a daemon |
|---|---|
| `packages/core/src/engine/discovery.ts` · `rulePatterns(config)` | **The watch set.** The union of every rule's patterns, plus `**/*` when a rule has no patterns. This is literally "the files the config selects". |
| `packages/core/src/engine/discovery.ts` · `listProjectFiles(root)` | The file list, via git when available (`listGitFiles` returns null outside a repo). |
| `packages/core/src/engine/discovery.ts` · `candidateFileRefs`, `discoverCandidateFiles` | File refs (path + stamp) for the candidate set, i.e. the same set the runner uses. |
| `packages/core/src/engine/file-set.ts` · `treeStateFor(root)`, `TreeState`, `treeStatesMatch` | A change **authority**: a stat walk producing a comparable state. Measured 289 ms warm for 13,711 files. Catches changes that fs events miss. |
| `packages/core/src/engine/rule-execution.ts` · `matchesPerFile(path, perFile)` | Pure. Answers "does this rule care about this file" — the change → work mapping, O(rules) per changed file (~121 here). |
| `packages/core/src/engine/tool-patterns.ts` · `toolWatchPatterns`, `scopedPatterns`, `toolScope` | Per-tool watch globs, and "which requested files does this tool own". Already load-bearing; `scopedPatterns` returns `null` rather than `[]` because an empty tool scope looks exactly like a clean project. |
| `packages/core/src/engine/rule-execution.ts` · `ruleReadsFileSystem(rule)` | Splits rules into file-major (cacheable per file) and file-system/project rules (need the covered path set). Determines what can be recomputed incrementally and what must re-run per request. |
| `packages/backend/request-scope.ts` · `expandRequest`, `rulesForRequest` | Request → concrete paths, and request → rules that can match them. |
| `packages/core/src/cache/*` | Per-file cache scopes with `mtimeMs:size` stamps, plus `rules`, `rules:<requestHash>` and `__project__` scopes. The hot state a daemon holds is this. |
| `packages/core/src/engine/run-lock.ts`, `run-lock-files.ts` | Slots, heartbeats, stale takeover, waiters, and `run.<key>.<id>.json` records keyed by tree state. The daemon replaces the lock for its own work and reuses this as the fallback path. |
| `packages/cli/src/check-coordination.ts` · `requestKeyFor` | Instance/scope/full-scope keys. A daemon request is the same idea without the files. |
| `packages/core/src/engine/aggregate.ts` · `narrowRunResult` | Slice a whole-tree result to a scope, recomputing `new`/`stale`/scores. A daemon serving a filtered request uses this. |
| `packages/cli/src/check-coordination.ts` · `describeCoordination`, `envelope.ts` | The reporting contract agents already read. A daemon response can be the same envelope. |
| `packages/typescript/src/parse-memo.ts` · `parseAstGrep`, `parseOxc`, `pickAstGrepParser` | Per-file parse memoisation. In a long-lived process this becomes a genuinely hot parse cache. |
| `packages/core/src/services/import-resolver.ts` · `ImportResolver.resolve(fromFile, specifier)` | File → file edges. Needs a reverse index (dependents) built on top for the graph phase. |
| `packages/core/src/primitives/graph.ts` · `noCycles` | Builds a graph today, but per call and inside a rule. There is no reusable graph service. |
| `packages/core/src/engine/exec.ts` · `execTool`, `resolveToolBin`, `resolveToolCwd`, `runWithTempFile` | The single seam where a tool process is spawned — where a long-lived tool process would live. |
| `packages/cli/src/watch.ts` | The current `--watch`: recursive `fs.watch` on the root, 150 ms debounce, ignore list for `.gesetz`, `.git`, `node_modules`. It re-runs **everything** and discards the filename. |

## 2. Measurements from this session (the problem being solved)

| Measurement | Value |
|---|---|
| One scoped `gesetz check` under a 20-agent fleet | **2,528 s** (the case in `SCALING-BRIEF.md`) |
| `vitest run --project unit` with a PHP pattern | ~25 min, killed; it falls back to the default include |
| Warm scan, 13,711 files | 289 ms |
| Full run, warm cache | 4.23 s |
| Repeat scoped run (filtered reuse) | 3 ms |
| RSS per gesetz process | ~360 MB |
| Twenty agents | ~7 GB RSS, twenty scans, twenty runs of each tool |
| vitest scoped vs whole project | 10.8 s vs 56.2 s |
| oxlint scoped vs whole | 0.5 s vs 3.8 s |

## 3. Tool watch-mode landscape

| Tool | In gesetz today | Native watch / incremental | Verified? |
|---|---|---|---|
| vitest | `packages/vitest` | `--watch`, `--changed`; also `--project` filtering | known yes |
| tsc | **no adapter at all** | `--watch`, `--incremental` + `.tsbuildinfo` | known yes |
| eslint | `packages/eslint` | `--watch`, `--cache` | known yes |
| oxlint | `packages/oxlint` | claimed `--watch` in newer versions; `--help` here printed no watch/stdin line | **unverified** |
| oxfmt | `packages/oxfmt` | none (formatter) | known none |
| phpstan | `packages/phpstan` | none; has a result cache (`resultCachePath`) | known none |
| phpunit / pest | `packages/phpunit`, `packages/pest` | none | known none |
| prettier | `packages/prettier` | none; `--cache` exists | partially |
| storybook | `packages/storybook` | n/a | n/a |

**No adapter passes any watch, cache or incremental flag today.** The only
occurrence of `--watch` in `packages/*/src` is the CLI's own loop.

## 4. Gaps that block the daemon

1. **No rule-level filter.** `check` accepts `--category` but not `--rule` and not
   a tool/adapter group. "Run only the type checker" is not expressible.
   (`packages/cli/src/main.ts`, the check options list.)
2. **No type-checking adapter.** There is no `tsc`/`vue-tsc` package, so the one
   thing agents most want to run alone is outside gesetz entirely. Everything the
   user wants to consolidate starts here.
3. **No daemon, no socket, no client.** Coordination is file-based and one-shot.
4. **No fs-event layer worth the name.** `fs.watch({ recursive: true })` is
   supported on macOS and Windows; on Linux it throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. A portable watcher needs per-directory watchers or a reconciliation walk.
5. **No dependency graph.** Import edges exist per call (`ImportResolver.resolve`),
   but nothing maintains a reverse index, so "what else is affected by this file"
   cannot be answered without a full scan.
6. **No rule-source watching.** In a pilot repo the rules live *in the repo*
   (`immoui/gesetz/*.ts`) and are edited constantly. `ruleFingerprint` already
   hashes rule source, so invalidation is correct — but nothing watches those
   files to trigger it.

## 5. Operational facts

- Cache: `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`, namespaced per project
  root, `GESETZ_DB` overrides, `SCHEMA_VERSION = 3`, `busy_timeout = 5000`.
  WAL, so concurrent readers are fine; writers serialise.
- Coordination files: `<root>/.gesetz/coord/` (`lock`, `wait.<pid>`, `run.<key>.<id>.json`).
- A single writer is already the design intent: `jobs` defaults to 1 for exactly
  this reason.
- Tests that call `runAll` used to write the developer's real cache and block for
  the full 5 s `busy_timeout` when another gesetz process held the lock; fixed on
  `main` by pointing `XDG_CACHE_HOME` at a per-run directory
  (`packages/core/tests/setup-cache-isolation.ts`). Same hazard, one process
  further out, is what the daemon eliminates.
