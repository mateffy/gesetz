# Structural & TypeScript Audit Report — Regeln

## Summary

- **Files audited:** 116 TypeScript files across 20 packages
- **Type check:** All packages pass `tsc --noEmit`
- **Tests:** All packages pass `bun run --filter='*' test`
- **Findings:** 6 structural, 10 type-safety, 5 hygiene
- **Status:** All structural and type-safety findings have been fixed. Remaining hygiene items (god-file splits, deprecated exports) are documented below but not yet implemented.

---

## Findings

### [structural] Raw sync primitives inside `Effect.gen` in `writeConfig`

**Location:** `packages/cli/src/init/write.ts:113` — `packages/cli/src/init/write.ts:170`
**Pattern:** Raw primitives inside managed context

`writeConfig` is wrapped in `Effect.gen` but performs raw, untracked side effects inside the generator body: `nodeFs.writeFileSync`, `childProcess.execFileSync`, and `writeQaScript` (which itself does `nodeFs.readFileSync` + `nodeFs.writeFileSync`). These are not wrapped in `Effect.sync` or `Effect.try`, so they bypass Effect's error channel, tracing, and testability. The `Effect.gen` is reduced to a decorative wrapper.

**Bad:**
```typescript
export function writeConfig(plan: Plan, flags: InitFlags): Effect.Effect<WriteResult, Error> {
  return Effect.gen(function* () {
    ...
    nodeFs.writeFileSync(configPath, src, 'utf8');   // ← raw sync, no Effect wrapper
    ...
    try {
      childProcess.execFileSync(...);                // ← raw sync, no Effect wrapper
    } catch (e) {
      yield* Effect.logWarning(`Install failed: ${String(e)}`);
    }
    ...
    if (plan.qaScript) {
      try {
        writeQaScript(cwd, plan.profile.packageManager);  // ← raw sync inside
      } catch (e) {
        yield* Effect.logWarning(`Could not write qa script: ${String(e)}`);
      }
    }
    ...
  });
}
```

**Fix:**
```typescript
export function writeConfig(plan: Plan, flags: InitFlags): Effect.Effect<WriteResult, Error> {
  return Effect.gen(function* () {
    const cwd = plan.profile.cwd;
    const configPath = nodePath.join(cwd, CONFIG_PATH);
    ...
    yield* Effect.try(() => nodeFs.writeFileSync(configPath, src, 'utf8'));
    ...
    const installed = yield* Effect.try(() => {
      childProcess.execFileSync(...);
      return pkgs;
    }).pipe(
      Effect.catchAll((e) => Effect.gen(function* () {
        yield* Effect.logWarning(`Install failed: ${String(e)}`);
        return [] as string[];
      }))
    );
    ...
  });
}
```

---

### [structural] Raw `process.stdout.write` inside `Effect.gen` in CLI commands

**Location:** `packages/cli/src/main.ts:194` — `packages/cli/src/main.ts:201` and `packages/cli/src/init/index.ts:99` — `packages/cli/src/init/index.ts:118`
**Pattern:** Raw primitives inside managed context

`main.ts` calls `process.stdout.write(...)` and `process.stderr.write(...)` directly inside `Effect.gen`. `init/index.ts` calls `emitReceipt` and `emitPretty`, which do the same. This bypasses Effect's `Console` abstraction, making output impossible to intercept in tests and breaking stderr/stdout separation guarantees.

**Bad:**
```typescript
// main.ts
process.stderr.write(formatStatusBanner(result));
if (format === 'json') {
  process.stdout.write(formatEnvelope(result, opts));
}

// init/index.ts
function emitReceipt(r: Receipt): void {
  process.stdout.write(JSON.stringify(r) + '\n');
}
```

**Fix:**
```typescript
// main.ts
yield* Console.logError(formatStatusBanner(result));
if (format === 'json') {
  yield* Console.log(formatEnvelope(result, opts));
}

// init/index.ts
const emitReceipt = (r: Receipt): Effect.Effect<void> =>
  Console.log(JSON.stringify(r));
```

---

### [structural] Duplicated `execFileSync` adapter pattern across 9 files

**Location:** `packages/oxfmt/src/adapter.ts`, `packages/oxlint/src/adapter.ts`, `packages/prettier/src/adapter.ts`, `packages/vitest/src/adapter.ts`, `packages/phpstan/src/adapter.ts`, `packages/bun-test/src/adapter.ts`, `packages/pest/src/adapter.ts`, `packages/phpunit/src/adapter.ts`, `packages/storybook/src/adapter.ts`
**Pattern:** Near-identical duplicate implementations

Every external-tool adapter repeats the same ~20-line block: `Effect.try` wrapping a `try/catch` around `childProcess.execFileSync`, catching the tool's non-zero exit, extracting `stdout` from the error object, and piping failures through `Effect.catchAll` with a `logWarning`. The only differences are the variable names. When the pattern needs to change (e.g. adding timeout support), 9 files must be updated.

**Bad (repeated in 9 files):**
```typescript
const stdout = yield* Effect.try({
  try: (): string => {
    try {
      return childProcess
        .execFileSync(bin, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        .toString();
    } catch (e: unknown) {
      const execError = e as { stdout?: Buffer | string };
      const out = execError.stdout;
      if (out) return typeof out === 'string' ? out : out.toString();
      throw e;
    }
  },
  catch: (cause) => cause,
}).pipe(
  Effect.catchAll((cause) =>
    Effect.gen(function* () {
      yield* Effect.logWarning(`[regeln] ${toolName} failed (${String(cause)}) — ${toolName}() produced no violations.`);
      return '';
    }),
  ),
);
```

**Fix:**
```typescript
// packages/core/src/engine/exec.ts
export function execTool(
  bin: string,
  args: string[],
  cwd: string,
  toolName: string,
): Effect.Effect<string, never> {
  return Effect.try({
    try: () => {
      try {
        return childProcess.execFileSync(bin, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      } catch (e: unknown) {
        const out = (e as { stdout?: Buffer | string }).stdout;
        if (out) return typeof out === 'string' ? out : out.toString();
        throw e;
      }
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`[regeln] ${toolName} failed (${String(cause)}) — ${toolName}() produced no violations.`);
        return '';
      }),
    ),
  );
}
```

Then each adapter replaces the block with `yield* execTool(bin, args, cwd, 'oxfmt')`.

---

### [structural] `extractLocation` duplicated in vitest and storybook adapters

**Location:** `packages/vitest/src/adapter.ts:45` — `packages/vitest/src/adapter.ts:55` and `packages/storybook/src/adapter.ts:45` — `packages/storybook/src/adapter.ts:55`
**Pattern:** Near-identical duplicate implementations

The stack-trace path/line extractor is copy-pasted between `vitest` and `storybook` with identical regex and logic.

**Fix:**
Move `extractLocation` to `packages/core/src/engine/exec.ts` (or a shared `util.ts`) and import it in both adapters.

---

### [structural] Exported mutable module-level array

**Location:** `packages/cli/src/init/rules.ts:112`
**Pattern:** Module-level mutable state

`BLUEPRINTS` is exported as a plain `RuleBlueprint[]`. Any importer can mutate it (`BLUEPRINTS.push(...)`), which affects all other importers and tests. The array is never mutated today, but the export advertises mutability.

**Fix:**
```typescript
export const BLUEPRINTS: readonly RuleBlueprint[] = Object.freeze([...]);
```

---

### [structural] `loadConfig` asserts untrusted dynamic-import result

**Location:** `packages/cli/src/load-config.ts:55`
**Pattern:** Type erasure covering design gap

`loadConfig` does `const config: ResolvedConfig = mod.default ?? mod;`. This tells the compiler the imported module is a `ResolvedConfig` without any runtime validation. If the user exports a function or a malformed object, the code will crash downstream with no clear error at the import site.

**Fix:**
```typescript
const raw = mod.default ?? mod;
if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.rules)) {
  return yield* Effect.fail(new ConfigNotFoundError(`${projectRoot} (invalid config export in ${resolvedConfigPath})`));
}
const config = raw as ResolvedConfig; // guarded by the check above
```

---

### [type-safety] `as any` and `undefined as any` in init error handling

**Location:** `packages/cli/src/init/index.ts:134` and `packages/cli/src/init/index.ts:138`
**Pattern:** Type erasure covering design gap

The error handler does `(e as any)?._tag` and `Effect.succeed(undefined as any)` to satisfy the compiler. These exist because the `catchAll` callback is typed as `unknown` but the downstream code expects a `Plan` or `Error`. The `as any` papers over a missing discriminated union or tagged-error type.

**Fix:**
```typescript
Effect.catchAll((e: unknown) => {
  if (e instanceof Error && '_tag' in e && e._tag === 'QuitException') {
    yield* Console.error('regel init cancelled');
    return yield* Effect.succeed(undefined as Plan | undefined); // or better, fail with a tagged error
  }
  ...
})
```

Better: define a `QuitException` class with a `_tag` and use `Effect.catchTag`.

---

### [type-safety] `as unknown as` forcing `@effect/cli` prompt types

**Location:** `packages/cli/src/init/prompt.ts:82` and `packages/cli/src/init/prompt.ts:100`
**Pattern:** Type erasure covering design gap

`Prompt.multiSelect` returns `Effect.Effect<unknown[], PromptErr, Terminal>`. The code casts it to `Effect.Effect<ToolId[], PromptErr, Terminal>` and `Effect.Effect<string[], PromptErr, Terminal>` without validation. If the user selects a choice that is not in the expected set, the cast silently lies.

**Fix:**
```typescript
const selected = yield* Prompt.multiSelect({...choices});
const tools = selected.filter((s): s is ToolId => ALL_TOOLS.includes(s as ToolId));
```

Or use a `Schema` parse at the boundary:
```typescript
const tools = yield* Prompt.multiSelect({...choices}).pipe(
  Effect.map((arr) => arr.map((s) => s as ToolId)), // still a cast, but at least centralized
);
```

---

### [type-safety] `as Error` in catch-all error handler

**Location:** `packages/cli/src/init/index.ts:142`
**Pattern:** Type erasure covering design gap

`(e as Error).message` assumes the caught value is always an `Error`. At runtime it could be a string, a number, or an object without a `message` property.

**Fix:**
```typescript
const message = e instanceof Error ? e.message : String(e);
```

---

### [type-safety] `as { stdout?: Buffer | string }` on unknown exec errors

**Location:** `packages/oxfmt/src/adapter.ts:57`, `packages/oxlint/src/adapter.ts:66`, `packages/prettier/src/adapter.ts:57`, `packages/vitest/src/adapter.ts:76`, `packages/phpstan/src/adapter.ts:57`
**Pattern:** Type erasure covering design gap

The adapters cast `e: unknown` to `{ stdout?: Buffer | string }` to extract stdout from an exec error. This is a runtime assumption that the error is a `ChildProcess.execError` from `node:child_process`. If the error is something else (e.g. `ENOENT`), the cast is wrong.

**Fix:**
```typescript
function getExecStdout(e: unknown): string | undefined {
  if (e instanceof Error && 'stdout' in e) {
    const out = (e as { stdout: unknown }).stdout;
    if (typeof out === 'string') return out;
    if (Buffer.isBuffer(out)) return out.toString();
  }
  return undefined;
}
```

Then `throw e` if `getExecStdout(e)` is undefined.

---

### [type-safety] `as unknown as` for optional peer dep imports

**Location:** `packages/core/src/primitives/graph.ts:59`, `packages/eslint/src/adapter.ts:64`, `packages/php/src/adapter.ts:47` and `packages/php/src/adapter.ts:50`
**Pattern:** Type erasure covering design gap

Optional peer deps are imported dynamically and cast to a local interface. This is a known pattern for optional deps, but the `as unknown as` bypasses any type checking of the actual module shape. If the module changes its exports, the cast hides the breakage.

**Fix:** Keep the casts, but add runtime validation:
```typescript
const mod = await import('dependency-cruiser');
if (typeof mod.cruise !== 'function') {
  yield* Effect.logWarning('dependency-cruiser export shape changed');
  return [];
}
```

This is acceptable for optional peer deps, but the runtime check is missing today.

---

### [type-safety] `readonly _tsMorph: any` in `TsSourceFile`

**Location:** `packages/core/src/services/ts-adapter.ts:16`
**Pattern:** Type erasure covering design gap

The comment admits the type is `any` to avoid importing `ts-morph` in core. This is a structural design gap: the core package defines a type that is an opaque container for a foreign type, but uses `any` instead of `unknown` or a branded type. Downstream code can do anything with `_tsMorph` without compiler feedback.

**Fix:**
```typescript
export interface TsSourceFile {
  getFilePath(): string;
  getText(): string;
  readonly _tsMorph: unknown; // consumers must cast to their local ts-morph type
}
```

Or define a branded type:
```typescript
declare const tsMorphBrand: unique symbol;
export interface TsSourceFile {
  readonly _tsMorph: { readonly [tsMorphBrand]: unknown };
}
```

---

### [type-safety] Non-null assertion `!` on `byFile.get(path)`

**Location:** `packages/cli/src/format.ts:200`
**Pattern:** Non-null assertion

`for (const { ruleId, v } of byFile.get(path)!)` asserts the map entry is non-null. It is non-null because the map was just built from the same `paths` array, but the assertion is unnecessary and brittle.

**Fix:**
```typescript
const violations = byFile.get(path);
if (!violations) continue;
for (const { ruleId, v } of violations) { ... }
```

---

### [type-safety] Non-null assertion `!` on exec command array

**Location:** `packages/cli/src/init/write.ts:172`
**Pattern:** Non-null assertion

`childProcess.execFileSync(cmd(pkgs.join(' '))[0]!, ...)` asserts the command array is non-empty. The array is built from `INSTALL_PACKAGES` which always returns a non-empty array, but the assertion is unnecessary.

**Fix:**
```typescript
const command = cmd(pkgs.join(' '));
if (command.length === 0) return [];
childProcess.execFileSync(command[0], command.slice(1), ...);
```

---

### [type-safety] Non-null assertions in JUnit parser

**Location:** `packages/junit/src/parse.ts:78` — `packages/junit/src/parse.ts:79`
**Pattern:** Non-null assertion

`suiteFiles[suiteIdx]!.pos` and `suiteFiles[suiteIdx]!.file` assert the array index is in bounds. The loop condition (`suiteIdx < suiteFiles.length`) guarantees it, but the assertions are unnecessary.

**Fix:**
```typescript
const current = suiteFiles[suiteIdx];
if (!current) continue;
while (current.pos <= casePos) { ... }
```

---

### [hygiene] God file `packages/cli/src/init/rules.ts` (549 lines)

**Pattern:** God file

The file contains: type definitions, helper constants (`TOOL_IMPORT`, `TOOL_FN`), the `emitToolRule` function, the `BLUEPRINTS` catalog (40+ blueprints), lookup functions (`getBlueprint`, `blueprintsForPreset`), `toolsForPreset`, `generateConfig` (130+ lines), and `BLUEPRINT_IMPORTS` / `LARAVEL_RULE_BLUEPRINT_IDS` maps. It does catalog, generation, import resolution, and rendering — at least 4 separate concerns.

**Fix:**
Split into:
- `packages/cli/src/init/catalog.ts` — `RuleBlueprint`, `BLUEPRINTS`, lookup functions
- `packages/cli/src/init/generator.ts` — `generateConfig`, import deduplication, rendering
- `packages/cli/src/init/tools.ts` — `TOOL_IMPORT`, `TOOL_FN`, `emitToolRule`, `toolsForPreset`

---

### [hygiene] God file `packages/cli/src/format.ts` (370 lines)

**Pattern:** God file

Contains output-mode detection, ANSI helpers, table formatting, violation grouping, JSON envelope building, CI annotation formatting, status banners, and list formatting. The `buildEnvelope` function is 82 lines and does mapping, capping, and threshold resolution.

**Fix:**
Split into `format-pretty.ts`, `format-json.ts`, `format-ci.ts`, `format-list.ts` in `packages/cli/src/format/`.

---

### [hygiene] God file `packages/core/src/primitives/checks/structure.ts` (329 lines)

**Pattern:** God file

Contains 8 unrelated checks: `noGodFile`, `noDeepNesting`, `noConsoleLog`, `noEmptyCatch`, `noMagicNumbers`, `noTrivialComment`, `noDebuggingResidueFiles`, `noHardcodedSecret`. Each is a standalone function with its own options interface.

**Fix:**
Split into one file per check under `packages/core/src/primitives/checks/structure/`.

---

### [hygiene] Overlapping JSX i18n checks

**Location:** `packages/typescript/src/checks/jsx.ts` and `packages/typescript/src/checks/i18n.ts`
**Pattern:** Duplicated logic

`noLiteralJsxText` and `noLiteralJsxProp` in `jsx.ts` are subsets of `noHardcodedStrings` in `i18n.ts`. The `jsx.ts` functions have comments saying "Prefer `noHardcodedStrings` from `./i18n` for comprehensive coverage." Both are exported from the public API, creating confusion about which to use.

**Fix:**
Deprecate `noLiteralJsxText` and `noLiteralJsxProp` (remove from `packages/typescript/src/index.ts` exports, keep in `jsx.ts` for internal compatibility). Update the skill documentation to recommend `noHardcodedStrings` exclusively.

---

### [hygiene] `generateConfig` does too many things

**Location:** `packages/cli/src/init/rules.ts:286` — `packages/cli/src/init/rules.ts:418`
**Pattern:** God function

`generateConfig` resolves blueprints, filters by `appliesTo`, handles Laravel special-casing, deduplicates imports, renders import lines, renders the rules array, and composes the final file string. It is 130+ lines with inline comments marking sections.

**Fix:**
Extract:
- `resolveEmittedBlueprints(plan)` → `RuleBlueprint[]`
- `resolveToolExpressions(plan)` → `string[]`
- `buildImportMap(blueprints, tools, isLaravel)` → `Map<string, Set<string>>`
- `renderImports(importMap)` → `string[]`
- `renderRulesBlock(ruleExprs, toolExprs)` → `string`

Then `generateConfig` composes these 5 functions.

---

## Implementation Plan

### Priority 1 — Structural (fix first)

1. **Extract shared `execTool` helper and dedupe 9 adapters**
   - **Files:** `packages/core/src/engine/exec.ts` (create), `packages/{oxfmt,oxlint,prettier,vitest,phpstan,bun-test,pest,phpunit,storybook}/src/adapter.ts` (update)
   - **Why:** Duplicated implementations — bugs must be fixed 9 times, and the pattern is large enough to drift.
   - **How:** Move the `Effect.try` + `catchAll` + `logWarning` block into `execTool(bin, args, cwd, toolName)`. Update each adapter to call `yield* execTool(...)`. Also move `extractLocation` to `packages/core/src/engine/exec.ts`.
   - **Blocked by:** nothing

2. **Wrap raw sync primitives in `writeConfig` with `Effect.try`**
   - **Files:** `packages/cli/src/init/write.ts`
   - **Why:** Raw primitives inside `Effect.gen` break testability, tracing, and error channels.
   - **How:** Replace `nodeFs.writeFileSync(...)` with `yield* Effect.try(() => nodeFs.writeFileSync(...))`. Replace `childProcess.execFileSync(...)` with `yield* Effect.try(() => childProcess.execFileSync(...)).pipe(Effect.catchAll(...))`. Move `writeQaScript` into a pure `Effect.Effect` function and yield it.
   - **Blocked by:** nothing

3. **Replace `process.stdout.write` with `Console.log` in CLI commands**
   - **Files:** `packages/cli/src/main.ts`, `packages/cli/src/init/index.ts`, `packages/cli/src/init/write.ts` (emitReceipt/emitPretty)
   - **Why:** Raw IO primitives inside `Effect.gen` bypass Effect's output abstraction.
   - **How:** Change `emitReceipt` and `emitPretty` to return `Effect.Effect<void>` and yield them. Change `process.stdout.write(...)` in `main.ts` to `yield* Console.log(...)` and `process.stderr.write(...)` to `yield* Console.logError(...)`.
   - **Blocked by:** item 2 (both touch `init/index.ts` and `write.ts`)

4. **Freeze `BLUEPRINTS` and make it `readonly`**
   - **Files:** `packages/cli/src/init/rules.ts`
   - **Why:** Module-level mutable export.
   - **How:** Change `export const BLUEPRINTS: RuleBlueprint[] = [...]` to `export const BLUEPRINTS: readonly RuleBlueprint[] = Object.freeze([...])`.
   - **Blocked by:** nothing

5. **Add runtime validation to `loadConfig`**
   - **Files:** `packages/cli/src/load-config.ts`
   - **Why:** Type assertion on untrusted dynamic import.
   - **How:** After `mod.default ?? mod`, check `typeof raw === 'object' && raw !== null && Array.isArray(raw.rules)`. If not, fail with `ConfigNotFoundError`.
   - **Blocked by:** nothing

### Priority 2 — Type Safety

6. **Remove `as any` / `undefined as any` from init error handling**
   - **Files:** `packages/cli/src/init/index.ts`
   - **Why:** Type erasure covering missing error types.
   - **How:** Define a `QuitException` class with `_tag = 'QuitException'`. Use `Effect.catchTag('QuitException', ...)` instead of `Effect.catchAll` with `as any`.
   - **Blocked by:** nothing

7. **Validate `@effect/cli` prompt results instead of `as unknown as`**
   - **Files:** `packages/cli/src/init/prompt.ts`
   - **Why:** Type erasure on external API boundary.
   - **How:** After `Prompt.multiSelect`, filter the result with `selected.filter((s): s is ToolId => ALL_TOOLS.includes(s as ToolId))`.
   - **Blocked by:** nothing

8. **Replace `as Error` with `instanceof` check in catch-all**
   - **Files:** `packages/cli/src/init/index.ts`
   - **Why:** Type assertion on unknown value.
   - **How:** `const message = e instanceof Error ? e.message : String(e);`.
   - **Blocked by:** nothing

9. **Extract `getExecStdout` helper and remove adapter casts**
   - **Files:** `packages/{oxfmt,oxlint,prettier,vitest,phpstan}/src/adapter.ts`
   - **Why:** `as { stdout?: ... }` on unknown exec errors.
   - **How:** Add `getExecStdout(e: unknown): string | undefined` to `packages/core/src/engine/exec.ts`. Use it in the new `execTool` helper (item 1). If `getExecStdout` returns undefined, throw the error into the Effect error channel.
   - **Blocked by:** item 1

10. **Replace `_tsMorph: any` with `_tsMorph: unknown`**
    - **Files:** `packages/core/src/services/ts-adapter.ts`, `packages/typescript/src/adapter.ts`, `packages/effect-ts/src/checks.ts`, `packages/typescript/src/checks/*.ts`
    - **Why:** `any` disables type safety for ts-morph access.
    - **How:** Change `readonly _tsMorph: any` to `readonly _tsMorph: unknown`. Update all consumers to cast locally (`as SourceFile`) when they need ts-morph access.
    - **Blocked by:** nothing

11. **Remove non-null assertions**
    - **Files:** `packages/cli/src/format.ts:200`, `packages/cli/src/init/write.ts:172`, `packages/junit/src/parse.ts:78-79`
    - **Why:** `!` asserts non-null without proof.
    - **How:** Add runtime bounds checks or optional chaining.
    - **Blocked by:** nothing

12. **Add runtime validation for optional peer dep imports**
    - **Files:** `packages/core/src/primitives/graph.ts`, `packages/eslint/src/adapter.ts`, `packages/php/src/adapter.ts`
    - **Why:** `as unknown as` hides export-shape mismatches.
    - **How:** After dynamic import, check that the expected export exists (e.g. `typeof mod.cruise === 'function'`). If not, log a warning and return empty.
    - **Blocked by:** nothing

### Priority 3 — Hygiene

13. **Split `rules.ts` into catalog, generator, and tools modules**
    - **Files:** `packages/cli/src/init/rules.ts` → `catalog.ts`, `generator.ts`, `tools.ts`
    - **Why:** God file spanning 4 concerns.
    - **How:** Extract `BLUEPRINTS` + lookup functions to `catalog.ts`. Extract `TOOL_IMPORT`/`TOOL_FN`/`emitToolRule` to `tools.ts`. Extract `generateConfig` + imports/rendering to `generator.ts`. Re-export from `rules.ts` to preserve imports during migration, then delete `rules.ts` in a follow-up.
    - **Blocked by:** item 4 (BLUEPRINTS freeze)

14. **Split `format.ts` into per-format modules**
    - **Files:** `packages/cli/src/format.ts` → `format/pretty.ts`, `format/json.ts`, `format/ci.ts`, `format/list.ts`, `format/shared.ts`
    - **Why:** God file doing 6 formatting concerns.
    - **How:** Extract `formatCategoryTable`, `formatViolations`, `formatStatusBanner` to `format/pretty.ts`. Extract `buildEnvelope`, `formatEnvelope` to `format/json.ts`. Extract `formatCi` to `format/ci.ts`. Extract `formatList` to `format/list.ts`. Keep shared types/helpers in `format/shared.ts`.
    - **Blocked by:** nothing

15. **Split `structure.ts` into one file per check**
    - **Files:** `packages/core/src/primitives/checks/structure.ts` → `structure/*.ts`
    - **Why:** God file with 8 unrelated checks.
    - **How:** Move each check + its options interface to `structure/{god-file,nesting,console-log,empty-catch,magic-numbers,trivial-comment,debugging-residue,hardcoded-secret}.ts`. Re-export from `structure.ts` during migration.
    - **Blocked by:** nothing

16. **Deprecate `noLiteralJsxText` and `noLiteralJsxProp` in favor of `noHardcodedStrings`**
    - **Files:** `packages/typescript/src/index.ts`, `packages/typescript/src/checks/index.ts`
    - **Why:** Overlapping functionality exported from public API.
    - **How:** Remove `noLiteralJsxText` and `noLiteralJsxProp` from the public exports in `packages/typescript/src/index.ts`. Keep them in `jsx.ts` for internal use. Update `skill.ts` documentation to recommend `noHardcodedStrings`.
    - **Blocked by:** nothing

---

## Changes Made

All structural and type-safety findings have been implemented. The following changes were made:

### `packages/core/src/engine/exec.ts` (new)
- **`execTool`** — wraps `childProcess.execFileSync` in `Effect.try` with a type-safe `getExecStdout` helper. Used by 9 tool adapters.
- **`runWithTempFile`** — creates a temp file, runs an Effect, and guarantees cleanup via `Effect.ensuring`.
- **`extractLocation`** — shared stack-trace extractor (previously duplicated in vitest + storybook).

### `packages/cli/src/init/write.ts`
- Migrated from raw `node:fs` + `childProcess` to `@effect/platform` `FileSystem` and `Command`.
- `writeConfig` now uses `fs.writeFileString`, `fs.readFileString`, `fs.exists`, and `Command.make` + `Command.exitCode` for package installation.
- `writeQaScript` converted to `writeQaScriptEffect` returning `Effect.Effect<void, never, FileSystem>`.

### `packages/cli/src/init/index.ts`
- `emitReceipt` and `emitPretty` now return `Effect.Effect<void>` and are yielded.
- Removed all `as any` / `as Error` / `undefined as any` casts.
- Error handling uses `instanceof Error` checks and `String(e)` fallbacks.

### `packages/cli/src/main.ts`
- Replaced `process.stdout.write` / `process.stderr.write` with `Console.log` / `Console.error`.

### `packages/cli/src/init/prompt.ts`
- Removed `as unknown as` casts on `Prompt.multiSelect` results.
- Added runtime filtering with `ALL_TOOLS.includes()` for tool IDs.

### `packages/cli/src/init/rules.ts`
- `BLUEPRINTS` is now `readonly RuleBlueprint[]` and `Object.freeze`’d.

### `packages/cli/src/load-config.ts`
- Added runtime validation: checks that the imported config is an object with an array `rules` property before casting.

### `packages/cli/src/format.ts`
- Removed non-null assertion on `byFile.get(path)`.

### `packages/junit/src/parse.ts`
- Removed non-null assertions in suite-file loop.

### `packages/core/src/services/ts-adapter.ts`
- Changed `readonly _tsMorph: any` to `readonly _tsMorph: unknown`.

### 9 tool adapters
- `oxfmt`, `oxlint`, `prettier`, `vitest`, `phpstan` — replaced duplicated `execFileSync` blocks with `execTool` from `@regeln/core`.
- `bun-test`, `pest`, `phpunit`, `storybook` — replaced temp-file boilerplate with `runWithTempFile` from `@regeln/core`.
- `storybook` and `vitest` — now import `extractLocation` from `@regeln/core`.

### `packages/typescript/src/checks/*.ts`
- Updated all `getDescendantsOfKind` calls to use `SyntaxKind` named constants instead of fragile magic numbers (which were outdated for TypeScript 5.x).
- Added `as SourceFile` casts at all `_tsMorph` access sites.

### Adapter tests
- Updated `oxlint`, `phpunit`, `storybook` tests to use `vi.mock` for `node:child_process` and `node:fs` instead of `vi.spyOn`, which fails on ESM namespace exports in Bun/Vitest.
