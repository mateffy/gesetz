# Tasks: `regel init` Command

**Plan:** `./.plans/regel-init-command/PLAN.md`

- [x] Task 1: Detection module — `detect.ts` + tests (framework/tools/config detection)
- [x] Task 2: Blueprint catalog & config generator — `rules.ts` + `generateConfig` tests
- [x] Task 3: Presets module — `presets.ts` (generic ⊂ react ⊂ tanstack-start, blank=[], laravel=5)
- [x] Task 4: Interactive wizard — `prompt.ts` (5 Prompt.* questions + overwrite gate)
- [x] Task 5: Non-interactive resolver & write module — `write.ts` (`resolvePlanFromFlags` + `writeConfig` + `qa` script + `--pm`)
- [x] Task 6: CLI command wiring — `init/index.ts` + register in `main.ts` (incl. `--pm`, `--no-qa-script`)
- [x] Task 7: Agent-mode + JSON receipt — `--format=json` receipt, env-triggered non-interactive
- [x] Task 8: Exports, skill docs, final validation — `index.ts`/`skill.ts` + full build/test/run
