# @gesetz/core Testing Guide

## Runner & Conventions

- **Runner**: Vitest (`vitest run` / `vitest`)
- **Colocation**: Tests live in `tests/**/*.test.ts`, parallel to `src/`
- **Mocking**: Prefer in-memory `MemoryFileSystem` over real disk I/O. Use `vi.mock('node:child_process')` for adapter-style tests.

## Tested Areas Map

| Source File | Test File | Status | Notes |
|---|---|---|---|
| `src/engine/config.ts` | — | ❌ | `defineConfig` is trivial object merging — tested implicitly via runner tests |
| `src/engine/errors.ts` | — | ❌ | Error constructors — tested implicitly |
| `src/engine/exec.ts` | `tests/engine/exec.test.ts` | ✅ | `execTool`, `runWithTempFile`, `extractLocation` |
| `src/engine/rule.ts` | — | ❌ | Types only |
| `src/engine/runner.ts` | `tests/engine/runner.test.ts` | ✅ | `runAll`, `applyExemptions` |
| `src/primitives/select.ts` | `tests/primitives/select.test.ts` | ✅ | `select`, `slugify`, chaining API |
| `src/primitives/checks/fs.ts` | `tests/primitives/checks/fs.test.ts` | ✅ | `requireSibling`, `requireChildren`, `forbidFile`, `relativeImports` |
| `src/primitives/checks/imports.ts` | `tests/primitives/checks/imports.test.ts` | ✅ | `noImportFrom`, `requireImportFrom` |
| `src/primitives/checks/patterns.ts` | `tests/primitives/checks/patterns.test.ts` | ✅ | `noPattern`, `requirePattern` |
| `src/primitives/checks/structure.ts` | `tests/primitives/checks/structure.test.ts` | ✅ | `noGodFile`, `noDeepNesting`, `noConsoleLog`, `noEmptyCatch`, `noMagicNumbers`, `noTrivialComment`, `noDebuggingResidueFiles`, `noHardcodedSecret` |
| `src/primitives/graph.ts` | — | ❌ | `noCycles` — requires `dependency-cruiser` peer dep; tested at integration level |
| `src/architecture.ts` | `tests/primitives/architecture.test.ts` | ✅ | `defineArchitecture` |
| `src/reporters/*.ts` | `tests/reporters/reporters.test.ts` | ✅ | `TestRunnerReporter`, `Reporter` service |
| `src/services/fs.ts` | `tests/services/fs.test.ts` | ✅ | `MemoryFileSystem`, `FileSystemLive` |
| `src/services/ts-adapter.ts` | — | ❌ | `TsAdapter` — tested implicitly via typescript/effect-ts adapter tests |
| `src/services/php-adapter.ts` | — | ❌ | `PhpAdapter` — tested implicitly via php adapter tests |

## Known Coverage Gaps

1. **`noCycles`** (`src/primitives/graph.ts`) — needs `dependency-cruiser` installed to run. Integration-level test would require mocking the dep-cruiser API.
2. **`TsAdapter`** / **`PhpAdapter`** — tested implicitly through downstream packages (`@gesetz/typescript`, `@gesetz/effect-ts`, `@gesetz/php`).
3. **Error branches in `execTool`** — the "command not found" path is tested; the "stdout in error" path is tested via adapter tests.
4. **`defineConfig`** — trivial object merging; covered implicitly by runner and architecture tests.

## Testing Patterns

### In-memory FileSystem

```ts
const files = {
  '/project/src/foo.ts': 'export const foo = 1;',
};
const layer = Layer.mergeAll(
  MemoryFileSystem(files),
  TsAdapterStub,
  PhpAdapterStub,
  ProjectRootLive('/project'),
  FileFilterLive(null),
);
const result = await Effect.provide(effect, layer).pipe(Effect.runPromise);
```

### Mocking child_process for adapter-style tests

```ts
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});
```

### Creating a File object

```ts
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
```

## Watch-Outs

1. **`MemoryFileSystem.glob`** uses `micromatch` (not `fast-glob`) for in-memory matching. Do not expect real filesystem traversal.
2. **`ProjectRoot`** must be provided when testing rules that call `fs.glob()` without an explicit `cwd`. The `architecture.ts` rule was fixed to read `ProjectRoot` after a bug where it defaulted to `process.cwd()`.
3. **Architecture import resolution** uses `nodePath.normalize()` to resolve relative imports (`../b/foo` → `b/foo`). Tests must use realistic relative paths.
4. **Structure checks** cap violations per file (e.g., `noDeepNesting` at 10, `noMagicNumbers` at 20). Tests should not expect more violations than the cap.
5. **`noEmptyCatch`** checks the 3 lines after `catch {` for real content. If the catch body is on the same line as the opening brace, it won't be detected.
