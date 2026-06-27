# Design: `gesetz init` command

## Architecture / data flow

```
gesetz init [--preset <p>] [--tools <t,t,...>] [--rules <r,r,...>] [--force]
           [--no-install] [--format pretty|json] [--project-root <d>]
  │
  1. Detect env: TTY? agent env var? → interactive vs non-interactive mode
  2. Probe project: package.json, binaries, config files, framework, src layout
  3. Resolve answers:
       interactive  → Prompt.* wizard (Q1 preset → Q2 tools → Q3 rules)
       non-interactive → flags, falling back to auto-detection for any omitted
  4. Build a Plan: { preset, tools: Set, rules: Set, install: bool }
  5. Generate gesetz.config.ts source from the plan (string templates)
  6. Write file (refuse overwrite unless --force); optionally run install
  7. Emit summary: human (pretty) or JSON envelope (agent)
```

The generator is a pure function `Plan → string` (the TS source). Detection is
a pure function `cwd → ProjectProfile`. The wizard is the only Effect-ful part
(it reads stdin via `Prompt.*`). This separation makes the whole thing
testable: detection and generation have unit tests; the wizard is thin.

### Module layout (new files under `packages/cli/src/init/`)

```
packages/cli/src/init/
├── detect.ts     # ProjectProfile detection (pure, node-fs based)
├── presets.ts    # Preset definitions: { id, label, rules: RuleBlueprint[] }
├── rules.ts      # RuleBlueprint catalog + generateConfig(plan) → string
├── prompt.ts     # Interactive wizard (Prompt.* Effects)
├── write.ts      # Write config file + optional install
└── index.ts      # initCommand (effect/cli Command) wiring
```

`init/index.ts` exports `initCommand`, imported into `main.ts` and added to
`Command.withSubcommands([...])`.

---

## Data model

### `ProjectProfile` (output of detection)

```ts
interface ProjectProfile {
  cwd: string;
  hasExistingConfig: boolean;          // gesetz.config.ts exists
  packageManager: 'bun' | 'pnpm' | 'npm' | 'yarn' | null;
  framework: 'tanstack-start' | 'react' | 'effect-ts' | 'laravel' | 'generic';
  hasSrc: boolean;
  hasRoutes: boolean;                   // src/routes/ exists
  hasDomains: boolean;                  // src/components/domains/ exists
  detectedTools: DetectedTool[];       // each { tool, via, version? }
  suggestedPreset: PresetId;            // derived from framework
}

interface DetectedTool {
  tool: ToolId;        // 'oxlint'|'oxfmt'|'prettier'|'eslint'|'vitest'|'bun-test'|'storybook'|'typescript'|'phpstan'|'phpunit'|'pest'
  via: 'package.json' | 'binary' | 'config-file';
}
type ToolId = string;  // union of the above
```

### `RuleBlueprint` (the catalog entry — not a `Rule`, a *recipe* to emit one)

The generator emits TS source. A blueprint describes one rule's source code:

```ts
interface RuleBlueprint {
  id: string;                  // stable slug, e.g. 'no-god-files'
  label: string;               // human label shown in wizard
  category: RuleCategory;
  description: string;         // what it checks (wizard help text)
  requiresTools?: ToolId[];    // this rule needs these tools installed (e.g. oxlint adapter needs oxlint)
  appliesTo: PresetId[] | 'all';  // which presets offer it by default
  // Emits the source lines for the rules array (without the surrounding select()/fn call boilerplate handled by `kind`)
  emit: (ctx: EmitContext) => string;
}

interface EmitContext {
  preset: PresetId;
  profile: ProjectProfile;
  maxLines?: number;  // configurable params
}
```

A blueprint's `emit()` returns a complete rule expression string, e.g.:
```
select('src/**/*.{ts,tsx}')
  .label('No console.log')
  .category('cleanup')
  .guidance({ what: '...', do: '...', dont: '...' })
  .check(noConsoleLog())
```
or for an adapter:
```
oxlint({ pattern: 'src/', cwd: import.meta.dirname, category: 'strictness' })
```

### `PresetId` and presets

```ts
type PresetId = 'blank' | 'generic' | 'tanstack-start' | 'react';
```

---

## Preset definitions

Each preset is an ordered list of `RuleBlueprint` references (by `id`) that are
**selected by default** when the user picks that preset. The wizard's rule step
starts from this set ∪ detected-tool rules, then lets the user edit.

### `blank`
Empty rules array. Just `defineConfig({ projectRoot, rules: [] })`. For users
who want to build their config from scratch.

### `laravel` (PHP / Laravel project)
Laravel-opinionated rules from `@gesetz/laravel` + `@gesetz/php`. Framework
detection: `composer.json` present or `artisan` binary. These rules all assume
the standard Laravel layout (`app/**/*.php`, `routes/**/*.php`).

| blueprint id | rule | category |
|---|---|---|
| `laravel-strict-types` | `requireStrictTypes` (`strictTypes()` on `app/**/*.php`,`src/**/*.php`) | strictness |
| `laravel-psr-namespaces` | `requirePsrNamespaces` (`psrNamespace({baseNamespace:'App',basePath:'app'})`) | organization |
| `laravel-no-raw-db` | `noRawDbQueries` (no `DB::statement/raw/select`) | security |
| `laravel-no-env-outside-config` | `noEnvOutsideConfig` (`env()` only in `config/**`) | security |
| `laravel-no-debug-helpers` | `noDebugHelpers` (no `dd`/`dump`/`ray`) | cleanup |

Plus detected PHP tools auto-added: `phpstan()` (if `vendor/bin/phpstan` or
`phpstan.neon`), `pest()` or `phpunit()` (if detected), each as adapter rules.
`@gesetz/laravel` re-exports `phpstan()` for convenience, but the generator
emits explicit imports from `@gesetz/phpstan`/`@gesetz/pest`/`@gesetz/phpunit`
to keep the import graph explicit.

### `generic` (framework-agnostic TS/JS project)
Universal structural & cleanup rules. No React, no framework assumptions.

| blueprint id | rule | category |
|---|---|---|
| `no-god-files` | `noGodFile({maxLines:600})` | structure |
| `no-console-log` | `noConsoleLog()` | cleanup |
| `no-empty-catch` | `noEmptyCatch()` | strictness |
| `no-trivial-comment` | `noTrivialComment()` | cleanup |
| `no-hardcoded-secret` | `noHardcodedSecret()` | security |
| `no-debugging-residue` | `noDebuggingResidueFiles()` | cleanup |
| `relative-imports` | `relativeImports()` | strictness |
| `require-tests-sibling` | `requireSibling('.test.ts')` on `src/**/*.{ts,tsx}` excl tests | structure |
| `test-quality-score` | `requireMinTestScore({minScore:50, ...defaults})` | strictness |

Plus any **detected tools** auto-added: oxlint/oxfmt/prettier/eslint/vitest/
bun-test, each as an adapter rule with `category: 'strictness'`.

### `react` (generic React app — Vite/Next/CRA, not TanStack Start)
Everything in `generic`, **plus** React-specific rules:

| blueprint id | rule | category |
|---|---|---|
| `no-hardcoded-strings` | `noHardcodedStrings()` on `src/**/*.tsx` | react |
| `component-has-stories` | `requireSibling('.stories.tsx')` | structure |
| `component-has-tests` | `requireSibling('.test.tsx')` | structure |
| `storybook-no-meta-title` | `noObjectProperty('meta','title')` on `*.stories.tsx` | cleanup |
| `no-direct-tanstack-query` | `noImportFrom('@tanstack/react-query',{allowedIn:'src/sdk/**'})` *only if react-query detected* | react |

Note: `component-has-stories` only makes sense if storybook is detected; the
blueprint's `requiresTools: ['storybook']` gates it.

### `tanstack-start` (TanStack Start specifically)
Everything in `react`, **plus** route-discipline rules (the immoui route rules,
generalized — no SDK-specifics):

| blueprint id | rule | category |
|---|---|---|
| `route-no-ui-imports` | `noImportFrom(~\/components\/ui/)` in `src/routes/**` | react |
| `route-no-local-components` | `noLocalFunctionComponents()` in `src/routes/**` | react |
| `route-no-usestate` | `noFunctionCalls(['useState'])` in `src/routes/**` | react |
| `domain-isolation` | `noCrossModuleImports({modulePattern:/domains\/([^/]+)\//})` *only if domains/ layout* | structure |
| `domain-barrel` | `requireChildren(['index.ts'])` on `src/components/domains/*/` *only if domains/* | structure |

**Explicitly EXCLUDED** (immoui-specific, per user): SDK sub-domain file
conventions, `requireExportPairs` (useX/useSuspenseX), mutation lifecycle
`requireCallShape`, storybook test-runner (server-based).

**Laravel preset rules** come from `packages/laravel/src/checks.ts`
(`requireStrictTypes`, `requirePsrNamespaces`, `noRawDbQueries`,
`noEnvOutsideConfig`, `noDebugHelpers`) + `@gesetz/phpstan`/`@gesetz/pest`/
`@gesetz/phpunit` adapters. All assume the standard Laravel `app/`+`routes/`
layout. RESEARCH.md §6 has the detection table for PHP tools.

---

## The wizard: questions `init` asks (interactive mode)

Up to 5 questions, in order. Each is a `Prompt.*` Effect. Defaults derive
from detection so a human can just press Enter through everything.

### Q1 — Preset selection
```
Prompt.select({
  message: 'Choose a preset (detected framework: <framework>)',
  choices: [
    { title: 'blank',          value: 'blank',          description: 'Empty config — build from scratch' },
    { title: 'generic',        value: 'generic',        description: 'Framework-agnostic TS/JS quality rules' },
    { title: 'react',          value: 'react',          description: 'Generic React app (Vite/Next)' },
    { title: 'tanstack-start', value: 'tanstack-start', description: 'TanStack Start: route discipline + domains' },
    { title: 'laravel',        value: 'laravel',        description: 'Laravel/PHP: strict types, PSR-4, no raw DB' },
  ],
})
```
Default (cursor position) = `suggestedPreset` from detection. Non-interactive:
`--preset` flag or `suggestedPreset`.

### Q2 — Tool selection (multi-select)
```
Prompt.multiSelect({
  message: 'Select QA tools to wire in (detected: oxlint, vitest — press space to toggle)',
  choices: [
    { title: 'oxlint',     value: 'oxlint',     description: '✓ detected' },
    { title: 'oxfmt',      value: 'oxfmt',      description: '✓ detected' },
    { title: 'prettier',   value: 'prettier',   description: 'not detected' },
    ...
  ],
})
```
All tools are listed; detected ones marked in description. Since `multiSelect`
can't pre-check, the message tells the user detected = recommended. The
non-interactive default = the detected set verbatim. `--tools` flag overrides.

### Q3 — Rule customization (multi-select)
```
Prompt.multiSelect({
  message: 'Select rules to include (<N> from preset, <M> from tools — space to toggle)',
  choices: [
    { title: '[structure] no-god-files — Files over 600 lines', value: 'no-god-files' },
    { title: '[cleanup]  no-console-log — No console.log in lib code', value: 'no-console-log' },
    ... (all blueprints for the chosen preset ∪ tool rules, each labeled [cat])
  ],
})
```
The full catalog for the preset is shown. Non-interactive default = preset's
default rule set ∪ tool-derived rules. `--rules` flag overrides (comma-separated ids).

### (implicit Q4) — Install dependencies
```
Prompt.confirm({
  message: 'Install @gesetz/* packages now via <pkgManager>? (recommended)',
  initial: true,
})
```
Skipped if `--no-install`. Non-interactive: default `true` unless `--no-install`.
Package manager: `--pm <bun|pnpm|npm|yarn>` overrides; otherwise auto-detected
from lockfile (`bun.lock`→bun, `pnpm-lock.yaml`→pnpm, `package-lock.json`→npm,
`yarn.lock`→yarn; none→npm). For Laravel (composer), install is `composer
require @gesetz/core @gesetz/laravel ...` — the `--pm` flag is ignored and
`composer` is used.

### (implicit Q5) — Add `qa` script to package.json
```
Prompt.confirm({
  message: 'Add a "qa": "gesetz check" script to package.json? (recommended)',
  initial: true,
})
```
Skipped if `--no-qa-script`. Non-interactive: default `true` unless
`--no-qa-script`. For Laravel (`composer.json`), the equivalent is adding a
`scripts.qa` entry to `composer.json`.

### Refuse-overwrite gate (before writing)
If `hasExistingConfig` and not `--force`:
```
Prompt.confirm({ message: 'gesetz.config.ts exists. Overwrite?', initial: false })
```
Non-interactive: error + exit 1 unless `--force`.

---

## Non-interactive contract (agent mode)

`gesetz init` is fully scriptable. Every prompt has a flag equivalent:

| Prompt | Flag | If flag omitted (agent mode) |
|---|---|---|
| Q1 preset | `--preset <id>` | use detected `suggestedPreset` |
| Q2 tools | `--tools <a,b,...>` | use detected tools verbatim |
| Q3 rules | `--rules <id,id,...>` | use preset defaults ∪ tool rules |
| Q4 install | `--no-install` (or `--install`) | `--install` (run it) |
| Q5 qa-script | `--no-qa-script` | add the script |
| overwrite | `--force` | error if exists |

Package manager for install: `--pm <bun|pnpm|npm|yarn>` overrides auto-detection.

**Agent auto-detection** (same logic as `check`): non-TTY stdout OR any
`AGENT_ENV_VARS` (`CLAUDE_CODE`, `CURSOR`, `DEVIN`, `GEMINI_CLI`, …) set →
non-interactive. `--interactive`/`--no-interactive` forces a mode.

**JSON output** (`--format=json`): after writing, emit a single JSON document:
```json
{"v":1,"command":"init","status":"ok","preset":"tanstack-start",
 "tools":["oxlint","oxfmt","vitest"],"rules":["no-god-files",...],
 "configPath":"gesetz.config.ts","installed":["@gesetz/core","@gesetz/oxlint"],
 "qaScript":true,"pm":"bun"}
```
This is the agent's confirmation receipt. `--format=pretty` (default) prints a
human summary.

---

## Generated config shape (example: tanstack-start preset)

```ts
/**
 * gesetz config — generated by `gesetz init` (preset: tanstack-start).
 * Run: gesetz check
 */
import { defineConfig, select, noGodFile, noConsoleLog, noEmptyCatch, noTrivialComment, noHardcodedSecret, noDebuggingResidueFiles, relativeImports, requireSibling } from '@gesetz/core';
import { requireMinTestScore, noHardcodedStrings, noObjectProperty, noImportFrom, noFunctionCalls, noLocalFunctionComponents, noCrossModuleImports, requireChildren } from '@gesetz/typescript';
import { oxlint } from '@gesetz/oxlint';
import { oxfmt } from '@gesetz/oxfmt';
import { vitest } from '@gesetz/vitest';

export default defineConfig({
  projectRoot: import.meta.dirname,
  rules: [
    // ── Structure ──
    select('src/**/*.{ts,tsx}')
      .label('No god files (max 600 lines)')
      .category('structure')
      .guidance({ what: '...', do: '...', dont: '...' })
      .check(noGodFile({ maxLines: 600 })),

    // ... (all selected blueprints) ...

    // ── React / TanStack Start ──
    select('src/routes/**/*.tsx')
      .label('Route files must not use useState')
      .category('react')
      .guidance({ ... })
      .check(noFunctionCalls(['useState'], { message: () => '...' })),

    // ── External tools ──
    oxlint({ pattern: 'src/', cwd: import.meta.dirname, category: 'strictness', label: 'oxlint' }),
    oxfmt({ pattern: 'src/**/*.{ts,tsx}', cwd: import.meta.dirname, category: 'strictness', label: 'oxfmt' }),
    vitest({ cwd: import.meta.dirname, project: 'unit', category: 'strictness', label: 'Vitest' }),
  ],
});
```

The generator:
1. Collects `import` specifiers from all emitted blueprints (dedup).
2. Groups emitted rules by category with comment headers.
3. Writes `projectRoot: import.meta.dirname` (matches dogfood style).
4. Indents with 2 spaces; ends with a trailing newline.

---

## Alternatives considered (rejected)

- **JSON config instead of TS.** Rejected: gesetz's `loadConfig` already expects
  a TS/JS module that calls `defineConfig`; the whole ecosystem (select DSL,
  adapter fns) is TS-native. Emitting JSON would need a separate loader.
- **A `gesetz.config.json` schema + generator from JSON.** Rejected for v1: too
  much surface area; TS config is more expressive (predicates, fns). Keep TS.
- **A huge rule catalog with 50+ blueprints.** Rejected: YAGNI. Ship the ~20
  distilled from immoui + research; the catalog is extensible later.
- **`@inquirer/prompts` instead of `@effect/cli` Prompt.** Rejected: avoids a
  new dep; `@effect/cli` Prompt already covers select/multiSelect/confirm/text
  and integrates with the Effect runtime. The preselect limitation is worked
  around by message text + non-interactive determinism.
- **Auto-running `npm install`.** Rejected as default for interactive (prompt
  first); but `--install` flag and agent-mode default-yes make it smooth.

---

## Decisions

1. **5-question wizard, not 7.** Minimal: preset → tools → rules → (confirm install) → (confirm `qa` script).
   Everything else derives from detection. Avoids the eslint-init "too many
   questions" failure mode.
2. **`multiSelect` preselect via message, not API.** `@effect/cli` lacks an
   `initial` field; non-interactive path is deterministic so this is cosmetic.
3. **Presets are blueprints, not hardcoded rule arrays.** A blueprint catalog
   + preset→[blueprint-id] mapping means presets compose (react = generic +
   react-set; tanstack-start = react + ts-set).
4. **Generator is pure `Plan → string`.** Trivially unit-testable; no Effect.
5. **Detection is pure `cwd → ProjectProfile`.** Same.
6. **Install is optional and prompted.** `--no-install` skips; agent mode runs
   it by default (idempotent `bun add`/`pnpm add`).
7. **JSON receipt on `--format=json`.** Matches the CLI-output envelope
   contract; agents get a machine-parseable confirmation. Includes `qaScript`
   and `pm` fields.
8. **Add a `qa` script to package.json** as part of init (unless `--no-qa-script`),
   so `npm run qa` / `bun run qa` runs `gesetz check`. For Laravel, writes
   `composer.json` `scripts.qa`. Idempotent (only adds if missing).
9. **`--pm` flag for package manager** overrides auto-detection (lockfile-based);
   Laravel uses `composer` regardless.
