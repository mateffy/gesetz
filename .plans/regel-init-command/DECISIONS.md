# Decisions: `gesetz init` Command

1. **3-question wizard, not 7.** Minimal: preset → tools → rules → (confirm install).
   Everything else derives from detection. Avoids the eslint-init "too many
   questions" failure mode (eslint issue #11105).
2. **`@effect/cli` `Prompt.*` over a new prompt dep.** Already a dependency;
   covers select/multiSelect/confirm/text. Avoids `@inquirer/prompts`/`prompts`/
   `enquirer`. `multiSelect` lacks preselect — worked around via message text +
   deterministic non-interactive path.
3. **Presets compose via blueprint catalog.** `PRESETS` maps preset-id →
   blueprint-id list; `react = generic + react-set`, `tanstack-start = react +
   ts-set`. DRY, easy to test superset invariants.
4. **Generator is pure `Plan → string`.** Trivially unit-testable, no Effect,
   no adapter imports at generate-time (emit strings only — bundler-safe).
5. **Detection is pure `cwd → ProjectProfile`.** Same.
6. **Generated config is TS, not JSON.** Gesetz's loader expects a TS/JS module
   calling `defineConfig`; the `select(...)` DSL and adapter fns are TS-native.
7. **Install is optional + prompted.** `--no-install` skips; agent mode
   defaults to install (`--install` semantics). Idempotent `<pkgmanager> add`.
8. **JSON receipt on `--format=json`.** Matches the CLI-output envelope
   contract from the redesign; agents get a machine-parseable confirmation.
9. **Exclude SDK-specific immoui rules** (sub-domain file conventions,
   useX/useSuspenseX pairs, mutation lifecycle, storybook test-runner) — per
   user note they're not generally useful. Presets keep the *structural
   discipline* (route thinness, domain isolation, test/story coverage, test
   quality scoring).
10. **`--rules` can pull blueprints outside the chosen preset** (with a warning)
    — power-user escape hatch. `--tools` includes undetected tools (with a
    warning) rather than silently dropping them.
11. **Laravel preset included** (`requireStrictTypes`, `requirePsrNamespaces`,
    `noRawDbQueries`, `noEnvOutsideConfig`, `noDebugHelpers` from
    `@gesetz/laravel` + detected PHP tools). Framework detection: `composer.json`
    or `artisan`. Install uses `composer require`.
12. **`qa` script added to `package.json`** (`scripts.qa = "gesetz check"`) as
    part of init unless `--no-qa-script`; `composer.json` `scripts.qa` for Laravel.
    Idempotent (only adds if missing).
13. **`--pm` flag** overrides package-manager auto-detection (lockfile-based);
    Laravel uses `composer` regardless of `--pm`.
14. **Bundle target is `bun`, not `node`.** Root cause of the persistent
    mojibake: `bun build --target node` emits a bundle whose UTF-8 string
    literals (both ours and transitive `@effect/*` deps that got bundled in)
    are double-encoded when the bundle is loaded by `bun` at runtime (each
    byte of a multi-byte UTF-8 sequence is mis-decoded as Latin-1 then
    re-encoded as UTF-8, e.g. `e2 94 80` → `c3 a2 c2 94 c2 80`). Fix:
    `--target bun` (the CLI is always run by `bun` via its `#!/usr/bin/env bun`
    shebang) **and** externalize `@effect/cli`, `@effect/platform-*`,
    `@effect/printer*` so their correctly-encoded source loads from
    `node_modules` at runtime. Non-ASCII literals in our own source use
    `\u` escapes (which `bun build` handles correctly) as a belt-and-suspenders
    measure. Regression tests in `tests/bundle-mojibake.test.ts` run the built
    binary under a PTY and assert no double-encoded byte sequences appear.
