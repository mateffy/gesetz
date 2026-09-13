# Plan: Migrate Checks from Effect to Async/Await

## Goal

Change the public `Check` type from returning `Effect.Effect<Violation[], never, ...>` to returning `Promise<Violation[]>`. Services (`FileSystem`, `SyntaxTree`, `ImportResolver`) are passed as a second argument bag instead of pulled via `yield*` from Effect context.

Effect stays internal — the runner, services, and `Rule.run` remain Effect-based. Only the per-file check functions become plain async.

## Why

Every check in the codebase uses Effect as a **service-access ceremony** (`yield* FileSystem`) and an **error-catching wrapper**. Neither provides concrete value over async/await for check authors. The `Check` type's error channel is literally `never`, so Effect's signature feature (structured errors) is prohibited at this layer.

## What stays as Effect (internal)

- `Rule.run` — the runner orchestrates rules with `Effect.all(..., { concurrency: 5 })`
- `FileSystem`, `SyntaxTree`, `ImportResolver` services — still Effect service tags
- `runAll` — top-level orchestration
- `defineArchitecture`, `noCycles` — they construct `Rule` objects internally; no public API change
- Adapters (`typescriptSyntaxBackend`, `phpSyntaxBackend`) — still export plain `SyntaxBackend` objects

## What changes (public API)

### New `Check` type

```ts
export interface CheckServices {
  fs: {
    glob(pattern: string | string[], options?: GlobOptions): Promise<File[]>;
    readFile(absolutePath: string): Promise<string>;
    exists(absolutePath: string): Promise<boolean>;
  };
  syntaxTree: {
    canProcess(file: File): boolean;
    process(file: File, options: SyntaxTreeProcessOptions): Promise<SyntaxBackendProcessResult>;
  };
  importResolver: {
    resolve(fromFile: File, specifier: string): string | null;
  };
  projectRoot: string;
}

export type Check = (file: File, services: CheckServices) => Promise<Violation[]>;
```

### Bridge in `buildRule`

Inside `buildRule`, we already have `FileSystem`, `SyntaxTree`, `ImportResolver`, `ProjectRoot` in scope via `yield*`. We build a `CheckServices` bag using `Effect.runtime` to bridge service calls back into the current fiber context:

```ts
const runtime = yield* Effect.runtime<...>();

const services: CheckServices = {
  fs: {
    glob: async (p, o) => Runtime.runPromise(runtime)(fs.glob(p, o)),
    readFile: async (p) => Runtime.runPromise(runtime)(fs.readFile(p)),
    exists: async (p) => Runtime.runPromise(runtime)(fs.exists(p)),
  },
  syntaxTree: {
    canProcess: (f) => st.canProcess(f),
    process: async (f, o) => Runtime.runPromise(runtime)(st.process(f, o)),
  },
  importResolver: {
    resolve: (ff, s) => ir.resolve(ff, s),
  },
  projectRoot: root,
};
```

Each check is executed via `Effect.tryPromise(() => check(file, services))` with `.pipe(Effect.catchAll(() => Effect.succeed([])))` for error absorption.

## Files to change

### Core — type system

| File                                           | Change                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/core/src/engine/rule.ts`             | New `CheckServices` interface; `Check` becomes `async (file, services) => Promise<Violation[]>` |
| `packages/core/src/primitives/select.ts`       | `buildRule` builds services bag + bridge; `.check()` accepts new `Check` type                   |
| `packages/core/src/primitives/simple-check.ts` | **Delete** — no longer needed                                                                   |
| `packages/core/src/index.ts`                   | Remove `simpleCheck` and `Simple*` exports; add `CheckServices`                                 |

### Core — built-in checks (rewrite Effect → async)

| File                                                     | Functions                                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/primitives/checks/fs.ts`              | `requireSibling`, `requireChildren`, `forbidFile`, `relativeImports`                                                                               |
| `packages/core/src/primitives/checks/patterns.ts`        | `noPattern`, `requirePattern`                                                                                                                      |
| `packages/core/src/primitives/checks/structure.ts`       | `noGodFile`, `noDeepNesting`, `noConsoleLog`, `noEmptyCatch`, `noMagicNumbers`, `noTrivialComment`, `noDebuggingResidueFiles`, `noHardcodedSecret` |
| `packages/core/src/primitives/checks/imports.ts`         | `noImportFrom`, `requireImportFrom`                                                                                                                |
| `packages/core/src/primitives/checks/calls.ts`           | `noDirectCalls`                                                                                                                                    |
| `packages/core/src/primitives/checks/debug-logging.ts`   | `noDebugLogging`                                                                                                                                   |
| `packages/core/src/primitives/checks/docstrings.ts`      | `requireDocstrings`                                                                                                                                |
| `packages/core/src/primitives/checks/exports.ts`         | `requireExportsMatching`, `requireRelatedExports`                                                                                                  |
| `packages/core/src/primitives/checks/naming.ts`          | `requireNamingConvention`, `noForbiddenNames`                                                                                                      |
| `packages/core/src/primitives/checks/structure-count.ts` | `requireMinStructureCount`                                                                                                                         |

### TypeScript adapter checks

All files under `packages/typescript/src/checks/` (~20 functions) — rewrite `Effect.sync/Effect.gen` to `async () =>`.

### Effect-TS adapter checks

`packages/effect-ts/src/checks.ts` — 4 functions — rewrite to async.

### Tests

All test files that call `Effect.runPromise(check(file))` or `Effect.provide(check(file), layer)` must change to `await check(file, mockServices)`.

Files:

- `packages/core/tests/primitives/checks/*.test.ts` (8 files)
- `packages/core/tests/primitives/simple-check.test.ts` → **Delete**
- `packages/core/tests/primitives/select.test.ts`
- `packages/core/tests/primitives/architecture.test.ts`
- `packages/typescript/tests/**/*.test.ts`
- `packages/effect-ts/tests/**/*.test.ts`

### Test helpers

Create a `makeCheckServices` helper in `packages/core/tests/helpers/` that builds a `CheckServices` bag from a `Layer` or from direct mock objects, so tests don't need to manage Effect context.

## Migration pattern (per check)

### Before

```ts
export function noGodFile(options = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const count = file.content.split("\n").length;
      if (count <= maxLines) return [];
      return [{ rule: "", severity: "warn", source: "core", message: "...", path: file.path }];
    });
}
```

### After

```ts
export function noGodFile(options = {}): Check {
  return async (file) => {
    const count = file.content.split("\n").length;
    if (count <= maxLines) return [];
    return [{ severity: "warn", source: "core", message: "...", path: file.path }];
  };
}
```

Note: `rule` field is optional — builder injects it.

### Before (service-requiring)

```ts
export function requireSibling(suffix): Check {
  return (file) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const exists = yield* fs.exists(siblingPath);
      // ...
    });
}
```

### After (service-requiring)

```ts
export function requireSibling(suffix): Check {
  return async (file, { fs }) => {
    const exists = await fs.exists(siblingPath);
    // ...
  };
}
```

## Order of implementation

1. Update `rule.ts` with new `CheckServices` and `Check` type
2. Update `select.ts` with bridge logic
3. Delete `simple-check.ts`, update `index.ts`
4. Rewrite all core built-in checks
5. Rewrite all TypeScript adapter checks
6. Rewrite all Effect-TS adapter checks
7. Update all tests
8. Typecheck → fix errors
9. Run full test suite
10. Update tutorials

## Rollback risk

Low. The change is mechanical. If issues arise, the bridge in `buildRule` can be adjusted without touching check implementations.
