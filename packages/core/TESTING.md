# @gesetz/core Testing Guide

## Runner & Conventions

- **Runner**: Vitest (`vitest run` / `vitest`)
- **Colocation**: Tests live in `tests/**/*.test.ts`, parallel to `src/`
- **Mocking**: Use `makeFile`, `makeCheckServices`, and `runCheck` from `@gesetz/core` for unit-testing checks. For adapter-style tests that run real tools, mock `child_process`.

## Tested Areas Map

| Source File                                | Test File                                                                                                        | Status | Notes                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `src/engine/config.ts`                     | `tests/engine/config.test.ts`                                                                                    | ✅     | `defineConfig` and `GesetzStorageConfig`                                     |
| `src/engine/errors.ts`                     | —                                                                                                                | ❌     | Error constructors — tested implicitly                                       |
| `src/engine/exec.ts`                       | `tests/engine/exec.test.ts`                                                                                      | ✅     | `execTool`, `runWithTempFile`, `extractLocation`                             |
| `src/engine/rule.ts`                       | —                                                                                                                | ❌     | Types only                                                                   |
| `src/engine/runner.ts`                     | `tests/engine/runner.test.ts` — `tests/engine/runner-incremental.test.ts` — `tests/engine/project-rules.test.ts` | ✅     | `runAll`, `applyExemptions`, incremental scanning                            |
| `src/backend/compile.ts`                   | `tests/backend/compile.test.ts`                                                                                  | ✅     | Compilation of rules to netzwerk extensions                                  |
| `src/backend/check-services.ts`            | `tests/backend/check-services.test.ts`                                                                           | ✅     | `createCheckServices`                                                        |
| `src/backend/violation-markers.ts`         | `tests/backend/violation-markers.test.ts`                                                                        | ✅     | Marker creation and deserialization                                          |
| `src/backend/syntax-extension.ts`          | `tests/backend/syntax-extension.test.ts`                                                                         | ✅     | Syntax-backed per-file checks                                                |
| `src/primitives/select.ts`                 | `tests/primitives/select.test.ts`                                                                                | ✅     | `select`, `slugify`, chaining API                                            |
| `src/primitives/checks/fs.ts`              | `tests/primitives/checks/fs.test.ts`                                                                             | ✅     | `requireSibling`, `requireChildren`, `forbidFile`, `relativeImports`         |
| `src/primitives/checks/imports.ts`         | `tests/primitives/checks/imports.test.ts`                                                                        | ✅     | `noImportFrom`, `requireImportFrom`                                          |
| `src/primitives/checks/patterns.ts`        | `tests/primitives/checks/patterns.test.ts`                                                                       | ✅     | `noPattern`, `requirePattern`                                                |
| `src/primitives/checks/structure.ts`       | `tests/primitives/checks/structure.test.ts`                                                                      | ✅     | `noGodFile`, `noDeepNesting`, `noDebuggingResidueFiles`, `noHardcodedSecret` |
| `src/primitives/checks/debug-logging.ts`   | `tests/primitives/checks/debug-logging.test.ts`                                                                  | ✅     | `noDebugLogging`                                                             |
| `src/primitives/checks/calls.ts`           | `tests/primitives/checks/calls.test.ts`                                                                          | ✅     | `noDirectCalls`                                                              |
| `src/primitives/checks/naming.ts`          | `tests/primitives/checks/naming.test.ts`                                                                         | ✅     | `requireNamingConvention`, `noForbiddenNames`                                |
| `src/primitives/checks/docstrings.ts`      | `tests/primitives/checks/docstrings.test.ts`                                                                     | ✅     | `requireDocstrings`                                                          |
| `src/primitives/checks/exports.ts`         | `tests/primitives/checks/exports.test.ts`                                                                        | ✅     | `requireExportsMatching`, `requireRelatedExports`                            |
| `src/primitives/checks/structure-count.ts` | `tests/primitives/checks/structure-count.test.ts`                                                                | ✅     | `requireMinStructureCount`                                                   |
| `src/primitives/graph.ts`                  | `tests/primitives/checks/cycles.test.ts`                                                                         | ✅     | `noCycles` — project-level, uses netzwerk import edges                       |
| `src/architecture.ts`                      | `tests/primitives/architecture.test.ts`                                                                          | ✅     | `defineArchitecture`                                                         |
| `src/reporters/*.ts`                       | `tests/reporters/reporters.test.ts`                                                                              | ✅     | `TestRunnerReporter`                                                         |
| `src/services/fs.ts`                       | `tests/services/fs.test.ts`                                                                                      | ✅     | `FileSystemLive`, `MemoryFileSystem`                                         |
| `src/services/syntax-tree.ts`              | `tests/services/syntax-tree.test.ts`                                                                             | ✅     | `SyntaxTreeLive`                                                             |
| `src/test-helpers.ts`                      | —                                                                                                                | ❌     | Tested implicitly through the entire check test suite                        |

## Known Coverage Gaps

1. **`noCycles`** — tested through integration-level mocks. The DFS implementation is unit-tested, but the netzwerk `resolveImportEdges` integration is tested at the smoke level.
2. **`TsAdapter` / `PhpAdapter`** — deleted in v1.2.0. Replaced by `typescriptSyntaxBackend` / `phpSyntaxBackend`, tested through their respective packages.
3. **Error branches in `execTool`** — the "command not found" path is tested; the "stdout in error" path is tested via adapter tests.

## Testing Patterns

Gesetz ships three test helpers exported from `@gesetz/core`: `makeFile`, `makeCheckServices`, and `runCheck`. They are plain functions — no Effect, no runtime, no dependency injection.

### Pattern 1 — Pure sync checks (regex, text scanning)

Checks that only read `file.content` or `file.path`. No services needed.

```ts
import { describe, it, expect } from 'vitest';
import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';

describe('noDebugLogging', () => {
  it('flags console.log in TypeScript files', async () => {
    const violations = await runCheck(
      noDebugLogging(),
      makeFile('src/foo.ts', 'console.log("hi");'),
      makeCheckServices(), // all safe defaults
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
  });
});
```

### Pattern 2 — File-system checks (`requireSibling`, `requireChildren`)

Checks that call `fs.exists` or `fs.readFile`. Pass a `files` map to `makeCheckServices`.

```ts
import * as nodePath from 'node:path';
import { makeCheckServices } from '@gesetz/core';

const CWD = process.cwd();

describe('requireSibling', () => {
  it('passes when the sibling file exists', async () => {
    const services = makeCheckServices({
      projectRoot: CWD,
      files: {
        [nodePath.resolve(CWD, 'src/Button.stories.tsx')]: '',
      },
    });
    const violations = await runCheck(
      requireSibling('.stories.tsx'),
      makeFile('src/Button.tsx'),
      services,
    );
    expect(violations).toHaveLength(0);
  });

  it('fails when the sibling is missing', async () => {
    const services = makeCheckServices({ projectRoot: CWD });
    const violations = await runCheck(
      requireSibling('.stories.tsx'),
      makeFile('src/Button.tsx'),
      services,
    );
    expect(violations).toHaveLength(1);
  });
});
```

### Pattern 3 — Syntax-tree checks (`noDirectCalls`, `requireNamingConvention`, `noImportFrom`)

Checks that call `syntax.process` and `syntax.canProcess`. Pass mock data via the `syntax` option.

```ts
describe('noDirectCalls', () => {
  it('flags calls whose name is in the banned set', async () => {
    const services = makeCheckServices({
      syntax: {
        calls: [
          { name: 'eval', line: 3 },
          { name: 'fetch', line: 7 },
        ],
      },
    });
    const violations = await runCheck(noDirectCalls(['eval']), makeFile('src/foo.ts'), services);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });

  it('returns no violations when canProcess is false', async () => {
    const services = makeCheckServices({
      overrides: { syntax: { canProcess: () => false } },
    });
    const violations = await runCheck(noDirectCalls(['eval']), makeFile('src/foo.rb'), services);
    expect(violations).toHaveLength(0);
  });
});
```

### Pattern 4 — Project-level rules (adapters, architecture, noCycles)

Rules that use the `project` descriptor can be tested by constructing a minimal `ProjectRuleContext` with mock glob and file methods. See `tests/engine/project-rules.test.ts` for full examples.

## Watch-Outs

1. **`makeCheckServices` defaults.** `fs.exists` returns `false` for all paths; `fs.readFile` returns `''`; `syntax.canProcess` returns `true` for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.php`; `syntax.process` returns empty arrays. Override only what your check needs.
2. **Always use absolute paths in `files`.** `fs.exists` receives absolute paths from checks. Build keys with `nodePath.resolve(projectRoot, relativePath)` or use `makeFile().absolutePath`.
3. **Use `overrides` for dynamic mocks.** When you need `canProcess` that varies per file, or `process` that throws for specific files, use `makeCheckServices({ overrides: { syntax: { ... } } })`.
4. **Structure checks cap violations per file.** `noDeepNesting` caps at 10, `noMagicNumbers` caps at 20. Tests must not expect more violations than the cap.
5. **`noEmptyCatch`** checks the 3 lines after `catch {` for real content. If the catch body is on the same line as the opening brace, it is not detected.
6. **Scoring formula.** `weighted = errors*1.0 + warnings*0.5 + infos*0.1`, then `score = max(0, 10 - weighted)`. Tests for violations must match the declared severity — a test that expects a `warn` violation to count as 1.0 toward the score is wrong.
