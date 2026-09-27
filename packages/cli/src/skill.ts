/**
 * The `gesetz skill` output — a markdown agent skill file.
 * Pipe to .agents/skills/gesetz/SKILL.md or directly into an agent.
 */
export const SKILL_MARKDOWN = `---
name: gesetz
description: |
  Unified code-quality gate. Use when the user asks to "check quality",
  "fix gesetz issues", "audit code", or before committing a feature.
---

# Gesetz Agent Skill

Gesetz runs deterministic, category-scored quality checks on any codebase.
It orchestrates static analysis tools and AST checks into a single score per category.

## Categories

| Category | What it checks |
|---|---|
| **strictness** | Type safety: \`any\`, \`as\`, \`!\`, floating promises, Effect-TS patterns |
| **structure** | Code shape: file/function size, nesting, magic numbers, empty catch |
| **organization** | Monorepo health: cycles, layer violations, import discipline |
| **cleanup** | Dead code, AI residue: trivial comments, console logs, debugging files |
| **security** | Secrets, SQL injection, unsafe innerHTML, hardcoded tokens |
| **effect-ts** | Effect-TS anti-patterns: scattered runPromise, throw in gen, yield without * |
| **react** | Hooks, keys, accessibility, data-fetching discipline |

## How to Use

### Initialize a config
\`\`\`bash
gesetz init                            # interactive wizard (TTY)
gesetz init --preset tanstack-start    # explicit preset
gesetz init --no-interactive --format=json  # agent mode: auto-detect + JSON receipt
gesetz init --force                    # overwrite an existing gesetz.config.ts
gesetz init --no-install --no-qa-script   # scaffold only, no side effects
\`\`\`

Interactive (5-question wizard: preset, tools, rules, install, qa-script) in a TTY.
Non-interactive when piped or when an agent env var is set (CLAUDE_CODE, CURSOR,
DEVIN, GEMINI_CLI, ...). Auto-detects framework (react, tanstack-start, laravel,
generic) and installed QA tools (oxlint, vitest, phpstan, ...). Installs
@gesetz/* packages and adds a \`"qa"\` script unless \`--no-install\` / \`--no-qa-script\`.
Available presets: blank, generic, react, tanstack-start, laravel.

### Run checks
\`\`\`bash
gesetz check                          # full scan from project root
gesetz check --since HEAD~5           # only changed files
gesetz check --category strictness    # one category
gesetz check --format=json             # machine-readable envelope for agents
gesetz check --no-baseline            # ignore the baseline; full inventory
\`\`\`

Invoke it as \`gesetz\`, \`pnpm exec gesetz\`, or \`npx gesetz\` — those run it under
node, which is the runtime it is built and tested against. \`bun
node_modules/.bin/gesetz\` also works (the violation cache is enabled under Bun
too), but reach for the plain form: a check that cannot use its cache re-checks
every file on every run, and that is the slowest thing this tool can do.

### Several agents, one working tree

\`gesetz check\` coordinates with other checks running in the same worktree. A
second caller waits for the run in flight and reuses its result when that result
already covers the current tree state, so ten agents editing one tree cost one
scan and one run of each external tool — not ten.

Every run says what it did, on stderr:

\`\`\`
cache: .gesetz/cache.db (runtime: node)
coord: ran — no other gesetz check active — 2 other processes waited on this run
coord: reused a run from 2.1s ago — this tree state was already checked
coord: waited 8.4s for pid 1234, then ran — re-checked 4 changed files; this worktree is shared, so some results may not be yours
\`\`\`

If you parse stdout instead, read the \`coordination\` block in the JSON envelope.
**A shared worktree means violations may come from files you did not edit.** When
\`coordination.mode\` is \`reused\`, the result was not computed from your own run.

Escape hatches, when you want a run of your own:

\`\`\`
gesetz check --standalone        # run now: no waiting, no reuse
gesetz check --jobs 2            # allow two runs at once (default 1)
gesetz check --wait-timeout 30   # seconds to wait before running anyway
gesetz check --full              # no cache, and therefore no sharing

### Violation baseline

A legacy codebase reports hundreds of violations from the first day, so the
project records them in \`.gesetz-baseline.json\`. \`gesetz check\` then fails on
new violations only and reports the split:

\`\`\`
gesetz: fail (3 new, 522 baselined, 2 stale)
\`\`\`

- Read \`baseline\` in the JSON envelope for \`new\`, \`baselined\` and \`stale\` counts.
- Fix every new violation. It is not in the baseline.
- A new file is fully enforced. It has no baseline entries, so every violation
  in it fails. Do not expect an allowance for code you add.
- A stale entry means a baselined violation was fixed. Report it; a maintainer
  deletes the entry.
- **Never run \`gesetz baseline\`.** Re-baselining is a maintainer action. An agent
  that can re-baseline can erase its own failure.

### Read the rule catalog
\`\`\`bash
gesetz list                           # all rules with guidance
gesetz list --category cleanup        # filter by category
\`\`\`

### Agent fix workflow
1. Run \`gesetz check --format=json\` to get the machine envelope
2. Read \`summary\` for the lowest-scoring category, then \`categories[]\`
3. For each failing rule in that category, read the guidance:
   \`gesetz list --category <cat>\`
4. Apply the fix structurally \u2014 never silence diagnostics
5. Re-run \`gesetz check\` to confirm the score improved and \`baseline.new\` is 0
6. Repeat until all categories are at or above threshold and no violation is new

> When stdout is not a TTY or an agent env var is set, \`gesetz check\`
> automatically emits the JSON envelope \u2014 no flag needed.

## Key Principles

- \`any\` is never acceptable. Replace with \`unknown\` + type guard or Zod parse.
- \`as T\` is a lie to the compiler. Use \`satisfies\` or parse with Zod.
- \`throw\` inside \`Effect.gen\` creates untyped Defects. Use \`yield* Effect.fail()\`.
- \`Effect.runPromise\` belongs at the boundary only \u2014 never inside library code.
- Empty \`catch\` swallows errors. Classify and handle, or rethrow.
- Every TODO needs a tracking issue, or it is debt, not a plan.
- Cycles between packages are architectural emergencies. Extract shared code.

## Scoring

Each category scores 0\u201310:
  \`score = max(0, 10 - (errors \u00d7 1.0 + warnings \u00d7 0.5 + infos \u00d7 0.1))\`

Default pass threshold is 7/10 per category. Configure in \`gesetz.config.ts\`.
`;
