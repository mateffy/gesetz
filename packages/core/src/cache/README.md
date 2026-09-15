# `src/cache` — incremental file cache

A small, dependency-free kernel for **content-hash incremental file processing**.

It answers one question: *"which files changed since last time, and what did I
compute for the ones that didn't?"* It hashes files, diffs them against a storage
adapter, recomputes only what changed, and remembers the rest.

The rule this module is built around: **it knows nothing about gesetz.** There is
no mention of rules, violations, or syntax anywhere in this directory, and there
must never be.

## Why this exists

Gesetz used to get incremental behaviour from the `netzwerk` library. Netzwerk's
scan worked, but the dependency brought ~856 MB of transitive `node_modules`
(onnxruntime, transformers, sharp, libsql, tree-sitter), stored per-marker rows
through a Turso client at roughly one awaited write per marker, and silently
skipped files over 64 KB. The kernel here is the small part gesetz actually
needed.

## The contract

> **This directory imports only `node:*` builtins and `./` siblings.**
> `tests/cache/purity.test.ts` fails the build if that is violated.

That single rule makes extraction a `git mv` instead of a refactor.

## API

```ts
import { sync, createSqliteStore } from './cache';

// Shared cache files hold every project, so a store is bound to a namespace.
const store = await createSqliteStore('/path/to/cache.db', { namespace: projectRoot });

const result = await sync({
  scope: 'rules',                      // cache namespace
  store,
  files: [{ path: 'src/a.ts', absolutePath: '/repo/src/a.ts' }],
  fingerprint: 'rules@v3',             // invalidates the whole scope when it changes
  compute: async (file, { content, hash }) => {
    return analyse(content);           // any JSON-serialisable value
  },
});

result.values.get('src/a.ts');         // cached or freshly computed
result.added;                          // paths computed for the first time
result.changed;                        // paths recomputed because the hash moved
result.removed;                        // paths pruned because they vanished
result.reused;                         // paths served from cache
result.hashes;                         // path -> content hash
await store.close();
```

### `CacheStore`

```ts
interface CacheStore {
  get(scope, path): Promise<CacheEntry | undefined>;
  put(scope, path, entry): Promise<void>;
  delete(scope, path): Promise<void>;
  entries(scope): Promise<ReadonlyMap<string, CacheEntry>>;
  prune(scope, keep: ReadonlySet<string>): Promise<readonly string[]>;
  close(): Promise<void>;
}
```

### Adapters

| Adapter | Factory | Use |
|---|---|---|
| Memory | `createMemoryStore()` | the default; tests, one-shot runs, `--full` |
| SQLite | `await createSqliteStore(path, options)` | persistence; built-in `node:sqlite`, WAL |

There is no JSON adapter: it rewrote the whole file on every close, which does
not scale, and the compat driver below covers the runtimes that lack
`node:sqlite`.

### Namespaces and retention

The default cache file is **shared across projects**, so a store is bound to a
namespace at construction:

```ts
createSqliteStore(path, { namespace: projectRoot });
```

Every statement is scoped to that namespace, including `prune`, so one project
can never read or delete another's entries. `ttlMs` (default 30 days, `0`
disables) sweeps entries older than the window when the store opens, so a shared
file cannot grow without bound. A `user_version` mismatch — i.e. an older table
layout — drops the table and recreates it, since this is only ever a cache.

Nothing is shared *between* namespaces: entries are keyed by repo-relative path,
and per-file checks can depend on other files in the project.

### Drivers

`createSqliteStore(path, driver)` resolves its backend at call time:

| `driver` | Behaviour |
|---|---|
| `auto` (default) | built-in `node:sqlite`, else a registered driver, else throw |
| `node` | built-in only |
| `compat` | a registered driver only |

A driver is registered through this port-level seam, so this directory never
depends on a native binding:

```ts
registerCacheDriver('sqlite', async (path) => myStore(path));
```

When no driver is available, `createSqliteStore` throws
`SqliteUnavailableError` whose message names the optional compatibility package
and the supported Node versions. `sqliteUnavailableMessage()` returns that text
on its own, for callers that want to show it before choosing an adapter.
`@gesetz/sqlite-compat` is the shipped implementation (backed by
`better-sqlite3`); it registers itself on import.

Callers of gesetz itself do not choose a driver — `defineConfig({ storage })`
only says *whether* and *where* to cache, and the driver is resolved
automatically. The `driver` argument exists for tests and for advanced callers
of the low-level API.

## Invariants

- **Content hash is the only reuse signal.** Never mtimes, never git status.
- **`fingerprint` and `force` are the only invalidation levers.** A caller that
  changes what `compute` does MUST change its `fingerprint`; the kernel cannot see
  inside a closure.
- **A caller may `delete` an entry to force recomputation.** Gesetz uses this to
  avoid caching failed runs: a rule that threw is retried on the next
  invocation instead of serving a stale error.
- **Discovery is the caller's job.** `sync()` takes a `readonly FileRef[]`.
  Directory walking, gitignore handling, size caps, and binary sniffing are
  consumer policy and live in `../engine/discovery.ts`.
- **Files that cannot be read are treated as absent** and pruned, so a listing
  that outlives a file on disk cannot crash a run.
- **Values must be JSON-serialisable.**
- **`compute` is skipped for reused files.** If you need to read every file,
  write that in `read`, not in `compute`.

## If it is ever extracted

1. `git mv packages/core/src/cache <new-package>/src`
2. Move `packages/core/tests/cache/` alongside it.
3. Add a `package.json` with `"type": "module"`, an `exports` map, and **no
   dependencies**; copy `packages/core/tsdown.config.ts` and drop the reporters
   entry.
4. Publish at `1.0.0` with a real repository and CI. Never publish a `link:` or
   `file:` dependency.

Nothing inside `src/cache/` needs to change for any of this.
