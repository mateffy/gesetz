# `@gesetz/sqlite-compat`

Optional SQLite cache driver for **gesetz** on runtimes without a usable
`node:sqlite` module — Node < 23.4, or Bun.

## Why this is separate

`@gesetz/core` must stay dependency-light, so it never depends on a native
SQLite binding. It exposes a driver registry instead, and this package registers
a `better-sqlite3`-backed implementation under the `sqlite` kind.

## Install

```bash
pnpm add -D @gesetz/sqlite-compat
```

`better-sqlite3` is a dependency of this package, so this pulls the native
module too. It is never a dependency of `@gesetz/core`.

## Use

Import it once from `gesetz.config.ts`. The import is the entire opt-in — it
registers the driver as a side effect:

```ts
// gesetz.config.ts
import '@gesetz/sqlite-compat';
import { defineConfig } from 'gesetz';

export default defineConfig({
  rules: [
    /* … */
  ],
});
```

That is the whole change — the default shared cache then works on this runtime.
(To keep the cache somewhere specific instead, set
`storage: { kind: 'sqlite', path: '…' }`.)

`gesetz check` then uses `better-sqlite3` automatically whenever `node:sqlite`
is unavailable. Driver selection is automatic and is **not** a user-facing
setting: `storage` only says *whether* and *where* to cache.

If `better-sqlite3` cannot be resolved, importing this module is a no-op and
gesetz runs without a cache.

## API

```ts
import { createBetterSqliteStore, registerBetterSqliteDriver } from '@gesetz/sqlite-compat';

// Register explicitly instead of relying on the import side effect.
registerBetterSqliteDriver(); // false when better-sqlite3 is not installed

// Build a store directly.
const store = await createBetterSqliteStore('/path/to/cache.db', { namespace: projectRoot });
```

- `createBetterSqliteStore(path, options?)` — throws with an actionable message
  when `better-sqlite3` cannot be resolved. `options.ctor` and `options.load`
  exist for tests.
- `registerBetterSqliteDriver(load?)` — registers the driver and returns whether
  it succeeded.
