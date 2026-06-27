# `regel init` Command Implementation Plan

> **Status:** IMPLEMENTED
> **Plan folder:** `./.plans/regel-init-command/`
> **Supporting files:** RESEARCH.md, DESIGN.md, TASKS.md, DECISIONS.md

**Goal:** Add a `regel init` command that scaffolds a `regel.config.ts` in the
current project — interactive for humans (3-question wizard), fully
non-interactive for AI agents (flags + auto-detection), with presets (blank /
generic / tanstack-start / react) and auto-detection of installed QA tools.

**Approach:** A new `packages/cli/src/init/` sub-module. Detection (`detect.ts`)
and config generation (`rules.ts`) are pure functions, fully unit-tested. The
interactive wizard (`prompt.ts`) uses the already-installed `@effect/cli`
`Prompt.*` API (no new deps). A `RuleBlueprint` catalog encodes ~20 distilled
rules; presets are mappings from preset-id to blueprint-id lists, so they
compose (react = generic + react-set). The generator emits valid TS source that
imports from `@regeln/core` and the chosen adapter packages.

**Tech stack:** TypeScript, Effect-TS, `@effect/cli` (Prompt API), `@effect/platform-node`
(Terminal service), `bun build` for bundling, `vitest` for tests. Conventions:
2-space indent, `import.meta.dirname` for projectRoot in generated configs
(matches `regel.config.ts` dogfood style).

---

## Context & Orientation

Regel is a unified code-quality gate. A "regel config" is a TS file
(`regel.config.ts`) that `export default defineConfig({ rules: [...] })` where
each rule is built via the `select(...).label().category().guidance().check()`
DSL (`@regeln/core`) or is an adapter rule object (`oxlint()`, `vitest()`, …).
`defineConfig`, `select`, and all primitive checks are exported from
`@regeln/core` (`packages/core/src/index.ts`); TypeScript-AST checks from
`@regeln/typescript`; adapter rules from `@regeln/<tool>`.

`regel init` generates this file. Key existing files:
- `packages/cli/src/main.ts` — CLI entry; registers subcommands via
  `Command.withSubcommands([...])`. `init` plugs in here.
- `packages/cli/src/load-config.ts` — searches `regel.config.{ts,js,mts,mjs}`.
  `init` writes `regel.config.ts`.
- `packages/cli/src/format.ts` — has `AGENT_ENV_VARS` (agent env-var list) and
  `detectFormat`/TTY logic; `init` reuses the agent-detection approach.
- `packages/core/src/engine/config.ts` — `UserConfig` / `defineConfig` shape.
- `packages/core/src/engine/rule.ts` — `Rule`, `RuleCategory`, `RuleGuidance`.
- `packages/core/src/primitives/select.ts` — the `select(...)` DSL.

**Preset source of truth:** the immoui project
(`/Users/mat/.local/share/opencode/worktree/.../brave-tiger/immoui`) — a
TanStack Start app whose `immoui.regel.config.ts` + `.agents/skills/` docs
encode the rules. RESEARCH.md §3 distills which rules generalize vs. are
SDK-specific (excluded per user). See DESIGN.md for the full preset tables.

---

## Scope

**In scope (exact paths):**
- Create: `packages/cli/src/init/detect.ts`
- Create: `packages/cli/src/init/presets.ts`
- Create: `packages/cli/src/init/rules.ts`
- Create: `packages/cli/src/init/prompt.ts`
- Create: `packages/cli/src/init/write.ts`
- Create: `packages/cli/src/init/index.ts`
- Modify: `packages/cli/src/main.ts` (add `init` to subcommands, ~line 18 imports + ~line 180 `withSubcommands`)
- Create: `packages/cli/tests/init-detect.test.ts`
- Create: `packages/cli/tests/init-generate.test.ts`
- Modify: `packages/cli/src/index.ts` (export `initCommand` + types)
- Modify: `packages/cli/src/skill.ts` (document `regel init` in the skill)

**Out of scope:** changes to `@regeln/core` or adapter packages; new rule
primitives; the `check`/`list` commands; a `regel.config.json` format.

**Forbidden actions:**
- Do NOT add `@inquirer/prompts`, `prompts`, `enquirer`, or any new prompt dep
  (use `@effect/cli` `Prompt.*`).
- Do NOT import adapter packages (`@regeln/oxlint` etc.) at generate-time —
  `init` emits *strings* that import them; it must not bundle them.
- Do NOT overwrite an existing `regel.config.ts` without `--force`.
- Do NOT run `git` commands.

---

## Goal & Acceptance (observable outcomes)

1. **Interactive (human, TTY):** `regel init` walks the user through preset →
   tools → rules → install, writes `regel.config.ts`, prints a summary. Pressing
   Enter through every prompt (accepting detected defaults) produces a working
   config that `regel check` can load.
2. **Non-interactive (agent, piped/`--no-interactive`):**
   `regel init --preset tanstack-start --no-interactive --format=json` writes
   the config and emits a JSON receipt
   `{"v":1,"command":"init","status":"ok",...}` with no stdin reads.
3. **Auto-detection only (no flags, agent):** `regel init --no-interactive` in
   a project with oxlint+vitest+react picks the `react` preset, wires detected
   tools, and includes the react rule set — zero flags needed.
4. **No clobber:** running `regel init` twice without `--force` exits 1 with a
   clear "config exists, use --force" message (or a confirm prompt in
   interactive mode).
5. **Generated config loads:** after `regel init` + install, `regel check`
   runs against the new config without a `ConfigNotFoundError` or import error.
6. **Tests:** `bun run --filter='@regeln/cli' test` includes ≥ 25 new tests
   (detection + generation + preset composition) and all pass; the bundle
   still builds (`bun run --filter='@regeln/cli' build`).

---

## Approach

### Detection (`detect.ts`)
Pure function `detectProject(cwd: string): ProjectProfile`. Uses only
`node:fs`, `node:path`, `node:child_process` (for `which`-style binary checks
via `nodeFs.existsSync` on `node_modules/.bin/<name>` and `vendor/bin/<name>`).
Reads `package.json` (deps + devDeps), probes config files, infers framework
from deps (`@tanstack/react-start` → tanstack-start; else `react`+`react-dom`
→ react; `effect` → effect-ts; `composer.json`/artisan → laravel; else generic).
Suggested preset: tanstack-start→`tanstack-start`, react→`react`,
laravel→`laravel`, effect-ts→`generic`, else→`generic`. Also detects package
manager from lockfile (`bun.lock`/`pnpm-lock.yaml`/`package-lock.json`/
`yarn.lock`) and Laravel via `composer.json`.

### Blueprints & presets (`presets.ts`, `rules.ts`)
`presets.ts` defines `PRESETS: Record<PresetId, RuleBlueprint[]>` by importing
the blueprint catalog from `rules.ts` and composing:
- `generic` = the 9 universal blueprints.
- `react` = generic + 5 react blueprints (storybook-gated ones have
  `requiresTools: ['storybook']`).
- `tanstack-start` = react + 5 route-discipline blueprints (domains-gated ones
  check `profile.hasDomains`).
- `blank` = `[]`.

`rules.ts` defines the `RuleBlueprint` catalog: each has `id`, `label`,
`category`, `description`, optional `requiresTools`/`appliesTo`, and an
`emit(ctx)` returning the source string. A `generateConfig(plan: Plan): string`
function assembles imports (deduped from all blueprints) + grouped rule
expressions into the final file text.

### Wizard (`prompt.ts`)
`runWizard(profile): Effect<Plan, QuitException | Error, Terminal>`.
Three `Prompt.*` calls (select → multiSelect → multiSelect) + a confirm for
install + a confirm-for-overwrite gate. Each prompt's choices derive from the
profile (detected tools marked, suggested preset pre-marked as the default
choice). On `QuitException` (Ctrl-C) → exit cleanly with code 1.

### Non-interactive resolver
`resolvePlanFromFlags(profile, flags): Plan` — pure. For each omitted flag,
fall back to: preset→`suggestedPreset`, tools→`detectedTools`, rules→preset
defaults ∪ tool-derived rule ids, install→true (unless `--no-install`),
qaScript→true (unless `--no-qa-script`), pm→`flags.pm ?? detectedPm`.

### Write (`write.ts`)
`writeConfig(plan, profile, flags): Effect<void, Error>`. Refuses overwrite
unless `--force` (or interactive confirm). Writes the file via `nodeFs.writeFileSync`.
If `install` and not `--no-install`, runs `<pkgManager> add @regeln/core
@regeln/<tool>...` via `child_process.execFileSync` (idempotent; `composer require`
for Laravel). If `qaScript`, writes `scripts.qa = "regel check"` into
`package.json` (or `composer.json` for Laravel) — idempotent (only adds if
missing).

### CLI wiring (`index.ts`, `main.ts`)
`initCommand = Command.make('init', {options}, handler)`. Options:
`--preset`, `--tools`, `--rules`, `--force` (boolean, default false),
`--install`/`--no-install` (boolean), `--no-qa-script` (boolean, default false),
`--pm` (text optional: `bun|pnpm|npm|yarn`), `--interactive`/`--no-interactive`
(boolean), `--format` (text, optional — reuses `detectFormat`/agent logic),
`--project-root` (text, optional). Handler: detect → resolve (interactive or
flag-based) → write → emit summary (pretty or JSON receipt). Added to
`Command.withSubcommands([checkCommand, listCommand, skillCommand, initCommand])`.

---

## Tasks

### Task 1: Detection module

**Files:**
- Create: `packages/cli/src/init/detect.ts`
- Test: `packages/cli/tests/init-detect.test.ts`

- [ ] **Step 1: Write the failing test for framework detection**
      Create `packages/cli/tests/init-detect.test.ts`. Test `detectProject`
      against a temp dir with a crafted `package.json` (react+react-dom →
      `react`; +`@tanstack/react-start` → `tanstack-start`; `effect` →
      `effect-ts`; none → `generic`). Use `nodeFs.mkdtempSync` + write files.
      ```ts
      it('detects tanstack-start from deps', () => {
        const dir = mkdtemp();
        writePkg(dir, { dependencies: { '@tanstack/react-start': '1', react: '19' } });
        const p = detectProject(dir);
        expect(p.framework).toBe('tanstack-start');
        expect(p.suggestedPreset).toBe('tanstack-start');
      });
      ```
- [ ] **Step 2: Run the test, confirm it fails**
      Run: `bun run --filter='@regeln/cli' test init-detect`
      Expected: FAIL — `detectProject is not defined` (module not created yet).
- [ ] **Step 3: Implement `detectProject` in `detect.ts`**
      Implement `detectProject(cwd)`: read `package.json`, probe
      `node_modules/.bin/*` and `vendor/bin/*`, probe config files, infer
      framework + suggestedPreset. Export `ProjectProfile`, `DetectedTool`,
      `ToolId` types. Pure (no Effect).
- [ ] **Step 4: Run the test, confirm it passes**
      Run: `bun run --filter='@regeln/cli' test init-detect`
      Expected: PASS.
- [ ] **Step 5: Add tests for tool detection (oxlint via devDep, vitest via
      binary, storybook via `.storybook/`) and existing-config detection.**
      Confirm all pass.

### Task 2: Blueprint catalog & config generator

**Files:**
- Create: `packages/cli/src/init/rules.ts`
- Test: `packages/cli/tests/init-generate.test.ts`

- [ ] **Step 1: Write the failing test for `generateConfig`**
      ```ts
      it('generates a valid generic preset config', () => {
        const plan = { preset: 'generic' as const, tools: new Set(['oxlint']), rules: new Set(['no-god-files','no-console-log','oxlint']), install: false, profile: fakeProfile };
        const src = generateConfig(plan);
        expect(src).toContain("import { defineConfig");
        expect(src).toContain("noGodFile({ maxLines: 600 })");
        expect(src).toContain("from '@regeln/oxlint'");
        expect(src).toContain("projectRoot: import.meta.dirname");
        expect(() => TS.parse // not executed, just string checks).toBeTruthy();
      });
      it('blank preset emits empty rules', () => {
        expect(generateConfig(blankPlan)).toContain('rules: []');
      });
      ```
- [ ] **Step 2: Run, confirm FAIL** (`generateConfig is not defined`).
- [ ] **Step 3: Implement the `RuleBlueprint` catalog in `rules.ts`**
      Define ~25 blueprints (ids: `no-god-files`, `no-console-log`,
      `no-empty-catch`, `no-trivial-comment`, `no-hardcoded-secret`,
      `no-debugging-residue`, `relative-imports`, `require-tests-sibling`,
      `test-quality-score`, `no-hardcoded-strings`, `component-has-stories`,
      `component-has-tests`, `storybook-no-meta-title`,
      `no-direct-tanstack-query`, `route-no-ui-imports`,
      `route-no-local-components`, `route-no-usestate`, `domain-isolation`,
      `domain-barrel`, `laravel-strict-types`, `laravel-psr-namespaces`,
      `laravel-no-raw-db`, `laravel-no-env-outside-config`,
      `laravel-no-debug-helpers`, plus tool-adapter blueprints `oxlint`/`oxfmt`/
      `prettier`/`eslint`/`vitest`/`bun-test`/`storybook`/`phpstan`/`pest`/
      `phpunit`). Each `emit(ctx)` returns the rule source string. Laravel
      blueprints emit `select('app/**/*.php')...` rules importing from
      `@regeln/laravel` (which re-exports the check fns). Implement
      `generateConfig(plan)` to dedupe imports, group by category, assemble the
      file.
- [ ] **Step 4: Run, confirm PASS.**
- [ ] **Step 5: Add tests for preset composition** — assert `tanstack-start`
      preset's rule-id set is a superset of `react`'s, which is a superset of
      `generic`'s. Assert react-only blueprints (`no-hardcoded-strings`) appear
      in `react` but not `generic`.

### Task 3: Presets module

**Files:**
- Create: `packages/cli/src/init/presets.ts`

- [ ] **Step 1: Define `PRESETS` and `PRESET_CHOICES`**
      `presets.ts` imports the blueprint catalog from `rules.ts` and exports
      `PRESETS: Record<PresetId, RuleBlueprint[]>` (generic = 9; react =
      generic + 5; tanstack-start = react + 5; laravel = 5 PHP rules;
      blank = []) and `PRESET_CHOICES` (the `Prompt.select` choices array with
      descriptions, including the `laravel` choice).
- [ ] **Step 2: Add a test asserting preset composition invariants**
      (tanstack-start ⊇ react ⊇ generic; blank = []). Confirm pass.

### Task 4: Interactive wizard

**Files:**
- Create: `packages/cli/src/init/prompt.ts`

- [ ] **Step 1: Implement `runWizard(profile, flags): Effect<Plan, ...>`**
      Five `Prompt.*` calls (Q1 select preset, Q2 multiSelect tools, Q3
      multiSelect rules, Q4 confirm install, Q5 confirm `qa` script). Derive
      choices from `profile`. Tool choices list all supported tools; detected
      ones get `description: '✓ detected'`. Rule choices =
      `PRESETS[resolvedPreset]` ∪ tool-derived blueprints, each `title`
      prefixed `[cat]`. Handle `QuitException` → `Effect.fail`. Return a `Plan`
      (including `pm` from `flags.pm ?? profile.detectedPm`).
- [ ] **Step 2: Add an overwrite-confirm branch** — if
      `profile.hasExistingConfig && !flags.force`, prepend a
      `Prompt.confirm('Overwrite?')`; on false, exit without writing.
- [ ] **Step 3: Manual smoke test** (no automated test for the TTY path —
      the pure resolver + generator are tested; the wizard is thin glue).
      Document in TASKS that the wizard is verified manually in the validation
      step.

### Task 5: Non-interactive resolver & write module

**Files:**
- Create: `packages/cli/src/init/write.ts`

- [ ] **Step 1: Implement `resolvePlanFromFlags(profile, flags): Plan`**
      Pure. preset = `flags.preset ?? profile.suggestedPreset`; tools =
      `flags.tools ?? profile.detectedTools`; rules = `flags.rules ??
      (presetDefaults ∪ toolRuleIds)`; install = `flags.install ?? true`.
- [ ] **Step 2: Implement `writeConfig(plan, profile, flags): Effect<void>`**
      Overwrite gate (refuse unless `--force`), `writeFileSync`, optional
      `<pkgManager> add ...` via `execFileSync`. Return the written path +
      installed packages for the receipt.
- [ ] **Step 3: Add tests for `resolvePlanFromFlags`** — omitted flags fall
      back to detection; explicit flags win. Confirm pass.

### Task 6: CLI command wiring

**Files:**
- Modify: `packages/cli/src/init/index.ts` (create)
- Modify: `packages/cli/src/main.ts` (import + register subcommand)

- [ ] **Step 1: Create `initCommand` in `packages/cli/src/init/index.ts`**
      `Command.make('init', {options}, handler)`. Options: `--preset` (text,
      optional), `--tools` (text comma, optional), `--rules` (text comma,
      optional), `--force` (boolean default false), `--no-install` (boolean),
      `--no-qa-script` (boolean default false), `--pm` (text optional:
      `bun|pnpm|npm|yarn`), `--interactive`/`--no-interactive` (boolean),
      `--format` (text optional), `--project-root` (text optional). Handler: detect → decide interactive
      (TTY + agent-env + `--interactive` flag) → runWizard OR
      resolvePlanFromFlags → writeConfig → emit summary (pretty or JSON receipt
      on `--format=json`). Provide `NodeContext.layer` (already at runtime).
- [ ] **Step 2: Wire into `main.ts`**
      Add `import { initCommand } from './init';` and add `initCommand` to
      `Command.withSubcommands([...])`.
- [ ] **Step 3: Build and verify `regel init --help`**
      Run: `bun run --filter='@regeln/cli' build`
      Run: `./packages/cli/dist/main.js init --help`
      Expected: shows `--preset`, `--tools`, `--rules`, `--force`, `--no-install`,
      `--no-qa-script`, `--pm`, `--interactive`, `--format`, `--project-root`.

### Task 7: Agent-mode + JSON receipt

**Files:**
- Modify: `packages/cli/src/init/index.ts`

- [ ] **Step 1: Implement the JSON receipt emitter**
      On `--format=json` (or auto-detected agent env), after writeConfig emit:
      `{"v":1,"command":"init","status":"ok","preset":...,"tools":[...],
      "rules":[...],"configPath":"...","installed":[...],"qaScript":true,
      "pm":"bun"}`. On error (exists/no-force),
      `{"status":"error","error":"..."}` exit 1.
- [ ] **Step 2: Verify agent env triggers non-interactive**
      `CLAUDE_CODE=1 ./dist/main.js init --format=json` (piped) runs with zero
      stdin reads and emits the JSON receipt. Manual check.

### Task 8: Exports, skill docs, final validation

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/skill.ts`

- [ ] **Step 1: Export from `packages/cli/src/index.ts`**
      Add `export { initCommand } from './init';` and re-export the public
      types (`PresetId`, `RuleBlueprint`, `Plan`, `ProjectProfile`).
- [ ] **Step 2: Update `skill.ts`**
      Add `regel init` to the "Setup" section of the skill markdown, with the
      non-interactive agent example:
      `regel init --preset tanstack-start --no-interactive --format=json`.
- [ ] **Step 3: Full validation** (see Validation section below).

---

## Validation & Acceptance

- Run: `bun run --filter='@regeln/cli' typecheck`
  Expected: 0 errors.
- Run: `bun run --filter='@regeln/cli' test`
  Expected: all green, ≥ 25 new tests (detect + generate + resolve + presets).
- Run: `bun run --filter='@regeln/cli' build`
  Expected: bundles clean, `dist/main.js` written.
- Run: `cd /tmp && mkdir init-test && cd init-test && npm init -y &&
  npm i oxlint vitest react react-dom && /path/to/dist/main.js init
  --no-interactive --format=json`
  Expected: writes `regel.config.ts`, JSON receipt with
  `preset:"react"`, `tools:["oxlint","vitest"]`, `qaScript:true`, exit 0.
- Run: `cat /tmp/init-test/package.json | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['scripts'].get('qa'))"`
  Expected: prints `regel check`.
- Run: `cat /tmp/init-test/regel.config.ts`
  Expected: valid TS, imports from `@regeln/core`+`@regeln/typescript`+
  `@regeln/oxlint`+`@regeln/vitest`, `projectRoot: import.meta.dirname`,
  ≥ 10 rules in the array.
- Run: `cd /tmp && mkdir init-laravel && cd init-laravel &&
  echo '{"name":"x","require":{"php":"^8.2"}}' > composer.json &&
  /path/to/dist/main.js init --no-interactive --format=json`
  Expected: writes `regel.config.ts`, JSON receipt with `preset:"laravel"`,
  config imports from `@regeln/laravel`+`@regeln/php`, ≥ 5 PHP rules.
- Run: `./packages/cli/dist/main.js init` (second time, same dir, no `--force`)
  Expected: exit 1, message "regel.config.ts exists — use --force to overwrite".
- Run (interactive, in a real TTY): `./packages/cli/dist/main.js init`
  Expected: up to 5 prompts shown; Enter through all → writes config using detected
  defaults; summary printed.
- Run: `CLAUDE_CODE=1 ./packages/cli/dist/main.js init --format=json |
  python3 -m json.tool`
  Expected: parses as JSON, `command:"init"`, no stdin hang.

State which tests fail before this change and pass after: there are no `init`
tests before (the command doesn't exist); after, the detect/generate/resolve
suites pass.

---

## Risks & Rollback

- **Risk: `Prompt.multiSelect` can't preselect.** Likelihood: certain.
  Mitigation: detected tools shown in message text; non-interactive path is
  deterministic. Cosmetic only.
- **Risk: generated config doesn't typecheck in target project** because
  `@regeln/*` isn't installed yet. Likelihood: medium. Mitigation: the
  `--install` step (default in agent mode, prompted in interactive) installs
  before the user runs `regel check`; the generated file is valid TS that
  typechecks once packages resolve.
- **Risk: framework mis-detection** (e.g. a Next.js app with react in deps →
  picks `react` preset, which is fine, but `tanstack-start` rules won't apply).
  Likelihood: low. Mitigation: `react` preset is a safe superset; user can
  `--preset` override; detection is transparent (shown in Q1 message).
- **Risk: `bun build` externalizes `@regeln/*`** so the bundled `init` can't
  import adapter packages at runtime. Likelihood: none — by design `init`
  emits strings, never imports adapters. Validated in Task 6 step 3.
- **Rollback:** `init` is additive — remove the `init/` dir, the import line
  in `main.ts`, the `initCommand` from `withSubcommands`, and the
  `index.ts`/`skill.ts` edits. No core/adapter changes to revert. Generated
  configs are user files (delete the file).

---

## Open Questions

All resolved per user feedback (2026-06-26):

1. **`--tools` for undetected tools:** warn but include the adapter rule anyway
   (so it surfaces at `regel check` time until the user installs the tool).
   Decided — recorded in DECISIONS.md.
2. **Package manager:** `--pm <bun|pnpm|npm|yarn>` flag overrides auto-detection
   (lockfile-based); Laravel uses `composer` regardless. Decided.
3. **`--rules` outside the chosen preset:** yes — explicit override that can
   pull any catalog blueprint, printing a warning if outside the preset's
   default set. Decided.
4. **Laravel preset:** included (framework detection → `laravel` preset with
   `requireStrictTypes`/`requirePsrNamespaces`/`noRawDbQueries`/
   `noEnvOutsideConfig`/`noDebugHelpers` + detected PHP tools). Decided.
5. **`qa` script in package.json:** added as part of init unless `--no-qa-script`
   (writes `scripts.qa = "regel check"`; `composer.json` for Laravel). Decided.

---

## Out of Scope (explicitly)

- A `regel.config.json` format or JSON-schema.
- Migration from an existing `regel.config.ts` (only overwrite-via-`--force`).
- IDE integration / `.vscode/` scaffolding.
- Generating *other* `package.json` scripts beyond `qa` (only `qa` is added).
- New rule primitives (the catalog uses only existing checks).
