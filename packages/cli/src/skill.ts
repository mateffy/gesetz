/**
 * The `regel skill` output — a markdown agent skill file.
 * Pipe to .agents/skills/regel/SKILL.md or directly into an agent.
 */
export const SKILL_MARKDOWN = `---
name: regel
description: |
  Unified code-quality gate. Use when the user asks to "check quality",
  "fix regel issues", "audit code", or before committing a feature.
---

# Regel Agent Skill

Regel runs deterministic, category-scored quality checks on any codebase.
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
regel init                            # interactive wizard (TTY)
regel init --preset tanstack-start    # explicit preset
regel init --no-interactive --format=json  # agent mode: auto-detect + JSON receipt
regel init --force                    # overwrite an existing regel.config.ts
regel init --no-install --no-qa-script   # scaffold only, no side effects
\`\`\`

Interactive (5-question wizard: preset, tools, rules, install, qa-script) in a TTY.
Non-interactive when piped or when an agent env var is set (CLAUDE_CODE, CURSOR,
DEVIN, GEMINI_CLI, ...). Auto-detects framework (react, tanstack-start, laravel,
generic) and installed QA tools (oxlint, vitest, phpstan, ...). Installs
@regeln/* packages and adds a \`"qa"\` script unless \`--no-install\` / \`--no-qa-script\`.
Available presets: blank, generic, react, tanstack-start, laravel.

### Run checks
\`\`\`bash
regel check                          # full scan from project root
regel check --since HEAD~5           # only changed files
regel check --category strictness    # one category
regel check --format=json             # machine-readable envelope for agents
\`\`\`

### Read the rule catalog
\`\`\`bash
regel list                           # all rules with guidance
regel list --category cleanup        # filter by category
\`\`\`

### Agent fix workflow
1. Run \`regel check --format=json\` to get the machine envelope
2. Read \`summary\` for the lowest-scoring category, then \`categories[]\`
3. For each failing rule in that category, read the guidance:
   \`regel list --category <cat>\`
4. Apply the fix structurally \u2014 never silence diagnostics
5. Re-run \`regel check\` to confirm the score improved
6. Repeat until all categories are at or above threshold (default: 7/10)

> When stdout is not a TTY or an agent env var is set, \`regel check\`
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

Default pass threshold is 7/10 per category. Configure in \`regel.config.ts\`.
`;
