# Research: `gesetz init` command

## Goal of the command

`gesetz init` scaffolds a `gesetz.config.ts` in the current project. It must work:
- **Non-interactively** for AI agents / CI (flags + auto-detection, no stdin reads).
- **Interactively** for humans (guided wizard with prompts, sensible defaults).

It auto-detects installed QA tools (oxlint, vitest, storybook, etc.), offers
**presets** (blank / generic / tanstack-start / react), then lets the user
customize which rules are auto-added — with auto-detected tools preselected.

---

## 1. Current gesetz config format (the thing `init` generates)

**File:** `packages/core/src/engine/config.ts` — `defineConfig`.

```ts
export interface UserConfig {
  readonly projectRoot?: string | undefined;       // defaults to cwd
  readonly tsConfigPath?: string | undefined;      // defaults to 'tsconfig.json'
  readonly rules: Rule[];
  readonly exemptions?: Exemption[] | undefined;
  readonly changedSince?: string | undefined;
  readonly thresholds?: CategoryThreshold[] | undefined;  // { category, minScore } default min 7
}
export function defineConfig(config: UserConfig): ResolvedConfig { ... }
```

**Config file names searched** (`packages/cli/src/load-config.ts`):
`gesetz.config.ts`, `.js`, `.mts`, `.mjs`. The file must `export default defineConfig({...})`.

**Rule shape** (`packages/core/src/engine/rule.ts`):
```ts
interface Rule {
  id: string;                 // slugified from description
  description: string;        // human label
  category?: RuleCategory;    // 'strictness'|'structure'|'cleanup'|'react'|'effect-ts'|...
  guidance?: RuleGuidance;    // { what, do, dont } — shown by `gesetz list`/`gesetz skill`
  run: Effect<Violation[], never, FileSystem|TsAdapter|PhpAdapter|ProjectRoot|FileFilter>;
}
```

**The `select(...)` DSL** (`packages/core/src/primitives/select.ts`) is how rules
are built in config files:
```ts
select('src/**/*.tsx')
  .exclude('**/*.test.tsx')
  .label('All components need Storybook stories')
  .category('structure')
  .guidance({ what: '...', do: '...', dont: '...' })
  .check(requireSibling('.stories.tsx'));
```
- `.label()` → sets `description` verbatim and slugifies to `id`.
- `.category()` / `.guidance()` map 1:1 to the Rule fields.
- Adapter rules (oxlint, vitest, …) are plain `Rule` objects, not selectors —
  called as functions: `oxlint({ pattern: 'src/', category: 'strictness' })`.

**The generated config is pure TS** that imports from `@gesetz/core` and the
adapter packages. So `init` must emit `import` statements matching the chosen
rules — it is a code generator, not a JSON writer.

---

## 2. Available rule primitives (the menu `init` chooses from)

### Language-agnostic (`@gesetz/core`)
`packages/core/src/index.ts` exports:
- **DSL:** `select`, `slugify`
- **FS checks** (`primitives/checks/fs.ts`): `requireSibling(ext)`,
  `requireChildren(files)`, `forbidFile(opts)`, `relativeImports(opts)`
- **Import checks** (`imports.ts`): `noImportFrom(spec, opts)`,
  `requireImportFrom(spec, opts)`
- **Pattern checks** (`patterns.ts`): `noPattern`, `requirePattern`
- **Structure checks** (`structure.ts`): `noGodFile({maxLines})`,
  `noDeepNesting`, `noConsoleLog`, `noEmptyCatch`, `noMagicNumbers`,
  `noTrivialComment`, `noDebuggingResidueFiles`, `noHardcodedSecret`
- **Graph:** `noCycles`
- **Architecture:** `defineArchitecture` (layer-based import boundaries)

### TypeScript AST (`@gesetz/typescript`)
`requireExportPairs(fn)`, `requireExportFactories({pattern,minCount})`,
`requireCallShape(name, requiredProps)`, `noFunctionCalls(names, opts)`,
`noLiteralJsxText`, `noLiteralJsxProp`, `noJsxElements`,
`noHardcodedStrings(opts)`, `requireImportBoundary({source, allowedIn})`,
`noLocalFunctionComponents()`, `noObjectProperty(obj, prop, opts)`,
`noCrossModuleImports({modulePattern, message})`,
`requireDirectoryStructure(files)`, `requireMinTestScore(opts)`.

### Effect-TS (`@gesetz/effect-ts`)
`noRunPromiseScattered({entryPoints})`, `noThrowInEffectGen()`,
`noYieldWithoutStar()`, `noUnboundedEffectAll()`.

### External-tool adapters (each returns a `Rule`)
| Adapter pkg | fn | key options |
|---|---|---|
| `@gesetz/oxlint` | `oxlint()` | `pattern`, `cwd`, `configFile`, `label`, `category` |
| `@gesetz/oxfmt` | `oxfmt()` | `pattern`, `cwd`, `label`, `category` |
| `@gesetz/prettier` | `prettier()` | `pattern`, `cwd`, `configFile`, `label`, `category` |
| `@gesetz/eslint` | `eslint()` | `pattern`, `cwd`, `overrideConfigFile`, `label`, `category` |
| `@gesetz/vitest` | `vitest()` | `pattern`, `cwd`, `project`, `label`, `category` |
| `@gesetz/bun-test` | `bunTest()` | `pattern`, `cwd`, `label`, `category` |
| `@gesetz/storybook` | `storybook()` | `url`, `cwd`, `label`, `category` |
| `@gesetz/phpstan` | `phpstan()` | `pattern`, `bin`, `cwd`, `configFile`, `label`, `category` |
| `@gesetz/phpunit` | `phpunit()` | `pattern`, `cwd`, `configFile`, `label`, `category` |
| `@gesetz/pest` | `pest()` | `pattern`, `cwd`, `label`, `category` |

### The `requireMinTestScore` check (the "tests test important things" rule)
`packages/typescript/src/checks.ts`. This is the metatest that scores test
files: counts assertions, test blocks, async/interaction/error indicators,
penalizes trivial assertions (`toBeTrue`, `toBeTruthy`, `toBeDefined`).
Options: `minScore`, `assertionThresholds`, `testCountThresholds`, bonuses,
`trivialAssertions`, `trivialPenalty`, `asyncIndicators`, `interactionMethods`,
`errorIndicators`. immoui uses `minScore: 50` with the full config.

---

## 3. The immoui reference project (presets source of truth)

**Path:** `/Users/mat/.local/share/opencode/worktree/.../brave-tiger/immoui`
(A TanStack Start + React 19 + Vite app; the project gesetz was born from.)

### Stack detected in its `package.json`
- **Runtime:** Bun, Vite 8, React 19, TanStack Start/Router/Query/Table
- **QA tools (devDeps):** oxlint, oxfmt, eslint (+ eslint-plugin-boundaries),
  vitest (+ @vitest/browser-playwright, coverage-v8), storybook 10,
  @testing-library/react, msw, faker, typescript 6.
- **Scripts:** `lint` (oxlint), `check` (oxlint+oxfmt), `lint:arch` (eslint
  boundaries), `test:component`, `test:storybook`, `typecheck`, `qa` (all).

### immoui's rules (from `immoui.gesetz.config.ts` + skill docs)
Organized by what `init` should generalize:

**A. Universal / framework-agnostic (→ `generic` preset):**
1. `noGodFile({maxLines})` — file length cap (structure)
2. `noConsoleLog()` — no console in lib code (cleanup)
3. `noEmptyCatch()` — no silent error swallowing (strictness)
4. `noTrivialComment()` — no AI-narration comments (cleanup)
5. `relativeImports()` — all relative imports resolve (strictness)
6. `requireSibling` for tests — every module has a sibling test (structure)
7. `requireMinTestScore` — tests aren't trivial (strictness)
8. `noHardcodedSecret()` — no secrets in source (security)
9. `noDebuggingResidueFiles()` — no `.debug.ts` left around (cleanup)
10. `noDeepNesting` / `noMagicNumbers` — optional strictness

**B. External-tool wiring (→ auto-detected, preset-agnostic):**
- `oxlint()`, `oxfmt()` or `prettier()`, `vitest()` or `bunTest()`,
  `storybook()`, `eslint()` (for boundaries/arch). Each gated on detection.

**C. React-specific (→ `react` preset):**
11. `noHardcodedStrings()` — i18n: no user-visible literal strings in JSX (react)
12. `noImportFrom('@tanstack/react-query', {allowedIn: 'src/sdk/**'})` —
    components must use SDK hooks, not raw TanStack (react)
13. `noFunctionCalls(['useQuery','useSuspenseQuery'])` in components (react)
14. `requireSibling('.stories.tsx')` — every component has stories (structure)
15. `noLocalFunctionComponents()` in route files — routes stay thin (react)
16. `noFunctionCalls(['useState'])` in routes — state in domain components (react)

**D. TanStack-Start-specific (→ `tanstack-start` preset, builds on react):**
17. Route discipline: `noImportFrom('~\/components\/ui/')` in routes,
    `noJsxElements` / `noLocalFunctionComponents` in `src/routes/**` — routes
    are thin orchestrators (params → page component, no HTML).
18. `requireDirectoryStructure` for SDK sub-domains (the `index/interface/http/
    memory/types/fakes` convention) — **too SDK-specific; EXCLUDE from preset**
    (user said SDK stuff is not generally useful).
19. `requireExportPairs` (useX + useSuspenseX) — **SDK-specific; EXCLUDE.**
20. `noCrossModuleImports({modulePattern: /domains\/([^/]+)\//})` — domain
    isolation (structure). Useful for any domain-organized React app.
21. `requireChildren(['index.ts'])` for domain dirs — barrel enforcement
    (structure). Useful when using a domains/ layout.

### immoui skill docs (`.agents/skills/`) — distilled principles
- **`tests/SKILL.md`:** every component needs tests; min 2 happy + 2 bad path
  + 1 interaction + 1 async; no `expect(true).toBe(true)`; no snapshot-only.
  Enforced by `requireMinTestScore` + `requireSibling('.test.tsx')`.
- **`storybook/SKILL.md`:** every component needs stories; cover default/empty/
  loading/error/interactive states; no explicit meta `title` (path-based
  grouping) → enforced by `noObjectProperty('meta','title')`.
- **`file-structure/SKILL.md`:** layer stack (lib→sdk→ui→generic→layout→
  domains→bridges→routes); `index.ts` barrels at domain/feature roots;
  `pure/` for domain-internal presentational components; bridges for
  cross-domain composition; routes are thin (no HTML, no useState).
- **`code-quality/SKILL.md`:** the `bun run qa` pipeline = oxlint + oxfmt +
  eslint-boundaries + structural vitest tests + tsc.

### What to EXCLUDE from presets (per user's note)
- SDK sub-domain file conventions (`index/interface/http/memory/types/fakes`)
- `requireExportPairs` / `requireExportFactories` (SDK hook pairs)
- `requireCallShape` for mutation lifecycle (SDK-specific)
- Storybook `url`-based test runner (requires a running server; opt-in only)
These are immoui-specific. The presets generalize the *structural discipline*,
not the SDK pattern.

---

## 4. Interaction / prompt infrastructure

**No prompt library is currently a dependency.** But `@effect/cli` (already a
`@gesetz/cli` dep) ships a `Prompt` module (`packages/cli/node_modules/@effect/cli/dist/dts/Prompt.d.ts`):
- `Prompt.text({message, default})` → `Prompt<string>`
- `Prompt.select({message, choices:[{title,value,description?}]})` → `Prompt<A>`
- `Prompt.confirm({message, initial})` → `Prompt<boolean>`
- `Prompt.multiSelect({message, choices, selectAll?, selectNone?})` → `Prompt<Array<A>>`
- `Prompt.toggle`, `Prompt.list`, `Prompt.password`

`Prompt.*` is an `Effect<Output, QuitException, Terminal>`. The `Terminal`
service is provided by `NodeContext.layer` (already in `main.ts`).

**Critical limitation:** `Prompt.multiSelect` has **no `initial`/preselect
field** — it cannot start with some boxes checked. This matters because the
user wants auto-detected tools "preselected" in the rule-customization step.

**Resolution options:**
- (a) For the *tool-selection* step, present detection results in the prompt
  message text ("detected: oxlint, vitest") and default `multiSelect` to
  "Select All", letting the user deselect. The non-interactive path applies the
  detected set directly.
- (b) Build a tiny custom prompt. Overkill for v1.
- → Go with (a). The agent/non-interactive path is where exact preselection
  matters, and there it's deterministic from flags/detection.

**Non-interactive trigger:** when stdin is not a TTY, `Prompt.*` fails with
`QuitException`. `init` should detect this up front (`process.stdin.isTTY`)
and either (a) require flags or (b) run fully on auto-detection + defaults —
never hang on stdin. Agent env vars (`CLAUDE_CODE` etc., already enumerated in
`format.ts` `AGENT_ENV_VARS`) also force non-interactive.

---

## 5. How other init CLIs do it (research)

- **`npm init @eslint/config`** (eslint.org): interactive wizard → problem-type
  → module type → framework → style guide → installs deps + writes config.
  Heavily criticized (GitHub issue #11105) for forcing a style-guide choice.
  Lesson: **don't force irrelevant questions**; let presets skip them.
- **`create-vite`** (`vitejs/vite/packages/create-vite/src/index.ts`): runs
  interactive mode **only when stdout is a TTY**; `-t/--template` + flags for
  non-interactive; `--interactive/--no-interactive` to force. Lesson: TTY-gate
  interactivity, mirror our `--format` auto-detection approach.
- **`antfu/eslint-config`** wizard (deepwiki): framework selection →
  dependency install → config generation → IDE setup, as 3 staged updates.
  Detects existing configs to prevent overwrite. Lesson: **detect & don't
  clobber** existing `gesetz.config.ts`; offer `--force`.
- **Agent-CLI best practices** (infoq, dev.to, agentao, openstatus):
  - Every command needs a machine escape hatch: `--no-interactive` /
    `--no-prompt` flags, env vars, semantic exit codes.
  - Support `--json` for parseable agent output. (We already have the envelope
    pattern from the CLI-output redesign — `init` should emit a JSON summary
    of what it did when `--format=json`.)
  - `--help` is the agent's tool description — keep it accurate.
  - Destructive ops need `--confirm` as a flag, not an interactive prompt.

---

## 6. Detection heuristics (what `init` probes)

For each QA tool, detect by **(dependency in package.json) OR (binary on PATH)
OR (config file present)**. Order: package.json devDep → local binary → global
binary → config file. This is robust across pnpm/npm/yarn/bun.

| Tool | package.json key | binary | config files |
|---|---|---|---|
| oxlint | `oxlint` (dep/devDep) | `node_modules/.bin/oxlint` | `.oxlintrc.json` |
| oxfmt | `oxfmt` | `node_modules/.bin/oxfmt` | `.oxfmtrc.json` |
| prettier | `prettier` | `node_modules/.bin/prettier` | `.prettierrc*`, `prettier.config.*` |
| eslint | `eslint` | `node_modules/.bin/eslint` | `eslint.config.*`, `.eslintrc*` |
| vitest | `vitest` | `node_modules/.bin/vitest` | `vitest.config.*` |
| bun-test | (bun runtime) | `bun` | `bunfig.toml` |
| storybook | `storybook` | — | `.storybook/`, `*.stories.tsx` exists |
| typescript | `typescript` | `node_modules/.bin/tsc` | `tsconfig.json` |
| phpstan | (composer) | `vendor/bin/phpstan` | `phpstan.neon*` |
| phpunit | (composer) | `vendor/bin/phpunit` | `phpunit.xml*` |
| pest | (composer) | `vendor/bin/pest` | `Pest.php` |

**Framework detection (for preset auto-suggestion):**
- TanStack Start: `@tanstack/react-start` in deps → `tanstack-start`.
- React (generic): `react` + `react-dom` in deps (and not TanStack Start) → `react`.
- Laravel/PHP: `composer.json` present or `artisan` binary → `laravel`.
- Effect-TS: `effect` in deps → `generic` (effect-ts rules are opt-in blueprints).
- Generic fallback.

**Package manager detection** (for the install step):
- `bun.lock` present → `bun add`.
- `pnpm-lock.yaml` → `pnpm add`.
- `package-lock.json` → `npm install`.
- `yarn.lock` → `yarn add`.
- `composer.json` (Laravel) → `composer require` (ignores `--pm`).
- None → `npm install`. `--pm <bun|pnpm|npm|yarn>` overrides.

**Source-tree detection** (for rule relevance): does `src/` exist? `src/routes/`?
`src/components/`? `src/components/domains/`? This tunes which structural rules
apply (e.g. domain-isolation rules only if `domains/` layout is used). For
Laravel: does `app/` exist? `routes/`? `config/`?

---

## 7. CLI command surface (effect/cli patterns already in repo)

`packages/cli/src/main.ts` uses `@effect/cli` `Command.make(name, options, handler)`.
Options via `Options.text('x').pipe(Options.optional)`, `Options.boolean('x').pipe(Options.withDefault(false))`.
Subcommands registered on root via `Command.withSubcommands([...])`.
Handler returns `Effect`. Runtime: `Command.run(...)(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)`.

So `init` is a new `Command.make('init', {...options}, handler)` added to the
subcommands list. It shares `NodeContext.layer` (which provides `Terminal` for
`Prompt.*` and `FileSystem`/`Path`).

---

## 8. Constraints / gotchas

- The generated config imports from adapter packages; the target project must
  have `@gesetz/core` + chosen adapters installed. `init` should offer to write
  the install command (and optionally run it with `--install`).
- `defineConfig` requires `rules: Rule[]`. A "blank" preset = empty array.
- Generated file is `.ts` → needs `// @ts-nocheck`? No — it should typecheck.
  But the target project may not have `@gesetz/*` types until installed. The
  generator should emit valid TS and the install step makes it typecheck.
- Must not overwrite an existing `gesetz.config.ts` without `--force`.
- The CLI is bundled via `bun build` with `--external @gesetz/*`. The `init`
  command runs in the bundled binary; detection code must use only Node APIs
  (`node:fs`, `node:child_process`, `node:path`) — no adapter imports at
  generate-time (we generate *strings* that import adapters, we don't import them).
- `projectRoot` for the new config defaults to `process.cwd()`, written as
  `import.meta.dirname` in the emitted file (matches the dogfood config style).
