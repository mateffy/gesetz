# CLI Output Redesign — Implementation Plan

## Context & goal

`regel check`'s terminal output is currently broken (box-drawing chars `─ █ ░ ✓ ✗`
show as `âââ` mojibake) and is built for humans only. We want a **dual-mode
output** — gorgeous for humans (`--pretty`), compact and parseable for LLM/AI
agents (the default when an agent is detected) — modeled on Laravel PAO,
`clispec.dev`, and the `ai-native-cli-spec` envelope convention.

This plan covers: (1) the encoding bug, (2) the dual-mode output design, and
(3) the implementation steps. **Do not implement until the design section is
approved.**

---

## Part 1 — Root cause of the mojibake (already diagnosed)

### What's actually happening

The emitted bytes for `─` are `c3 a2 c2 94 c2 80` — i.e. the correct UTF-8
bytes `e2 94 80` have been **decoded as Latin-1, then re-encoded as UTF-8**
(double-encoded). The corrupted string lives in memory (verified via
`JSON.stringify` of `formatCategoryTable`'s return value) before any stdout
write.

### Proven facts from the investigation

| Probe | Result |
|---|---|
| Source file `packages/cli/src/format.ts` bytes | Clean UTF-8 (`e2 94 80`) |
| Bundled `packages/cli/dist/main.js` bytes at rest | Clean UTF-8 (verified: 3 correct `─`, 0 double-encoded) |
| Minimal `bun -e "console.log('─')"` | Clean output |
| `formatCategoryTable()` called in **isolation** (no `runAll`) | Clean output (both bun-source and bundled-node) |
| `bun run packages/cli/src/main.ts check` (source, **no bundling**) | **Clean output** |
| `./packages/cli/dist/main.js check` (bundled) | **Corrupted** — but a literal `'─'` injected into `main.ts` next to the call is clean, while the literal inside the bundled `format.ts` returns `â` |
| Effect `Console.log`, `process.stdout.write`, `process.stderr.write` | All clean for literals defined in `main.ts`; the corruption is in the *string returned by `formatCategoryTable`* |

### Conclusion

The bug is triggered by **`bun build` bundling `format.ts` combined with
something loaded during `runAll`** (a transitive dep — candidates: `ts-morph`,
`tree-sitter`, `tree-sitter-php`, `dependency-cruiser`, `eslint` — the bundle
contains 5× `TextDecoder` and 20× `binary` references). The exact mechanism is a
Bun-bundler/runtime interaction around how the literal `"\xe2\x94\x80"` in the
bundled module gets its codepoints assigned at eval time. **We do not need to
fully root-cause the Bun internals** because the redesign removes the failure
mode entirely by:

1. Not relying on non-ASCII literals surviving the bundler (use explicit
   `\u2500`/`\u2588`/`\u2591`/`\u2713`/"\u2717" escapes, which the bundler
   preserves verbatim — proven by the clean `PROBE-REPEAT-IN-HANDLER` probe).
2. Routing agent output through a **structured JSON envelope** that contains
   zero non-ASCII, zero ANSI — so the bug class cannot affect agents at all.
3. Guarding all ANSI / box-drawing behind `isTTY` so piped output is always
   plain ASCII.

> Note: even after the redesign, we should keep one regression test that builds
> the bundle and asserts the box chars survive (see Part 3, step 7). If Bun
> fixes the underlying bundler issue, the escapes + TTY guards still leave us
> correct.

---

## Part 2 — Output design (for approval)

### Mode selection

`regel check` selects an output mode in this priority order:

1. `--format=<pretty|json|github>` flag (explicit, wins always)
2. `--json` flag (legacy alias for `--format=json`, kept for back-compat)
3. **Auto-detection** (no flag): if stdout is **not a TTY** OR a known agent
   env var is set → `json`. Else → `pretty`.

Agent env vars to detect (PAO-style, expandable):
`CLAUDE_CODE`, `CURSOR_TRACE_ID`/`CURSOR`, `DEVIN`, `GEMINI_CLI`,
`AGENT_TASK_ID`, `AIDER_CHAT`, `CLAUDECODE` (any truthy value).

### Stream contract (both modes)

| Stream | Contents |
|---|---|
| **stdout** | The result payload only. Pretty = the human table + violations. JSON = one JSON document (envelope). Never progress, never the PASS/FAIL banner. |
| **stderr** | Status line (`Quality Assurance: 21 violation(s) found.` / `PASS`), the exit summary, and the `regel check failed:` error on crash. Currently `ProcessReporter` already does this — extend the pattern. |
| **exit code** | `0` if `result.passing`, `1` otherwise. (Unchanged.) |

Rationale: stdout is the API contract; an agent can `regel check | jq` safely.

### A. Pretty mode (humans, `--format=pretty` or TTY default)

Same visual design as today, but:

- Box-drawing chars **kept** (`─ █ ░ ✓ ✗`) per the user's request — but
  written via `\u2500`/`\u2588`/`\u2591`/`\u2713`/"\u2717" escapes, and
  **only emitted when `process.stdout.isTTY`**. When piped, fall back to
  ASCII (`-`, `#`, `.`, `+`/`-`, `PASS`/`FAIL`) — this also kills the
  mojibake class for anyone who pipes pretty output.
- ANSI colors gated on `isTTY` too (today they leak into pipes).
- Violations **grouped by file** (see "Violation grouping" below) instead of
  by rule — matches how a human/agent fixes code.
- The PASS/FAIL / totals banner moves to **stderr**.

### B. JSON mode (agents, `--format=json` or auto-selected)

A **single JSON document** on stdout — the versioned envelope:

```json
{
  "v": 1,
  "status": "fail",
  "passing": false,
  "total": 21,
  "summary": { "cleanup": 7.9, "structure": 10, "strictness": 10, "effect-ts": 10 },
  "categories": [
    { "name": "cleanup", "score": 7.9, "errors": 0, "warnings": 0, "infos": 21,
      "passing": true, "threshold": 7 }
  ],
  "violations": [
    { "sev": "info", "rule": "no-ai-narration-comments",
      "path": "packages/core/src/architecture.ts", "line": 130, "col": null,
      "msg": "Trivial or narrative comment." }
  ],
  "truncated": 0,
  "hint": null
}
```

Design rules (all PAO/clispec-aligned):

1. **Flat violation array**, one object per violation. Stable short keys
   (`sev`, `rule`, `path`, `line`, `col`, `msg`). `sev` is the enum
   `"error"|"warn"|"info"` — no prose brackets.
2. **`summary` is a compact `{category: score}` map** — ~15 tokens gives the
   whole pass/fail picture. Categories that pass but have infos still appear.
3. **Passing run compacts hard**: `{"v":1,"status":"pass","passing":true,
   "total":0,"summary":{...},"categories":[...],"violations":[],
   "truncated":0,"hint":null}` — ~20 tokens if you only read the top fields
   (the PAO target).
4. **Capping**: if `total` > `MAX_VIOLATIONS` (default 50), include only the
   first 50 violations, set `"truncated": <remaining>`, and
   `"hint": "regel check --format=json --all"`. Mirrors PAO/PHPStan capping.
   `--all` disables the cap.
5. **Zero-violation rules omitted entirely** (today `--json` dumps them all).
6. `col` is `null` when absent (consistent types — never omit keys).
7. **No ANSI, no non-ASCII** anywhere in JSON mode. Makes the bundler bug
   irrelevant for agents.

### Violation grouping (pretty mode only)

Switch from group-by-rule to **group-by-file**, file paths sorted, lines sorted
within file:

```
packages/core/src/architecture.ts
  L130  info    no-ai-narration-comments  Trivial or narrative comment.
  L142  info    no-ai-narration-comments  Trivial or narrative comment.
packages/typescript/src/checks/call-shape.ts
  L36   info    no-ai-narration-comments  Trivial or narrative comment.
```

JSON mode stays a flat array (no grouping) — agents sort themselves.

### `regel list`

- `--format=json` / auto → array of `{id, description, category, guidance}`
  (today's shape, but only emitted on stdout; no leading prose).
- `--format=pretty` → keep current look, gate ANSI/box on `isTTY`.

### `regel skill`

Unchanged (markdown to stdout, no mode detection needed).

---

## Part 3 — Implementation steps

### Step 1 — New `format.ts` internals (no API change yet)

File: `packages/cli/src/format.ts`

- Replace literal `'─'/'█'/'░'/'✓'/'✗'` with `'\u2500'` / `'\u2588'` /
  `'\u2591'` / `'\u2713'` / `'\u2717'` everywhere (comments included, for
  consistency — or leave comment dividers as-is since they don't reach output;
  pick: escape them too, low cost).
- Add `const isTTY = process.stdout.isTTY ?? false` and a `decorate()` helper:
  returns the ANSI/box version when `isTTY`, else an ASCII fallback.
- Gate every `color(...)` call behind `isTTY` (no-op wrapper when not TTY).
- Box-drawing: TTY → `\u2500` etc.; non-TTY → `-`/`#`/`.`/`+`/`-`/`PASS`/`FAIL`.
- Reorder `formatViolations` to **group by file** (see design B). Keep rule id
  in each line.
- This single step fixes the mojibake for the bundled `dist/main.js` because
  `\uXXXX` escapes survive the bundler verbatim (proven by probes).

### Step 2 — Add the JSON envelope formatter

File: `packages/cli/src/format.ts` — new `formatEnvelope(result, opts)`.

- Produces the envelope object from Part 2-B.
- Applies capping (`MAX_VIOLATIONS = 50` const) unless `opts.all`.
- Maps `Violation` → flat `{sev, rule, path, line, col, msg}` (omit zero-viol
  rules).
- `JSON.stringify` once, no indentation (token-efficient). Add trailing `\n`.

### Step 3 — Mode detection

File: `packages/cli/src/format.ts` — new `detectFormat(opts)`.

- Precedence: explicit `--format` > `--json` (legacy) > auto.
- Auto = `!process.stdout.isTTY || AGENT_ENV_VARS.some(k => process.env[k])`.
- Export `AGENT_ENV_VARS` list.

### Step 4 — Wire into `main.ts`

File: `packages/cli/src/main.ts`

- Add `--format` option (`text('format')`, choices `pretty|json|github`,
  optional) to `check` and `list`.
- Keep `--json` as deprecated alias → maps to `--format=json`.
- Add `--all` flag (disables violation cap in JSON).
- In the handler: compute `format = detectFormat(opts)`.
  - `json` → `process.stdout.write(formatEnvelope(result, {all}))`.
  - `pretty` → current `formatCategoryTable` + `formatViolations` (now
    file-grouped, TTY-gated) to stdout.
  - `github` → reuse `GitHubActionsReporter` logic (or a thin `formatGithub`
    that writes `::error` lines to stdout). (Already exists as a reporter;
    surface it as a format for parity.)
- Move the `PASS`/`FAIL` + totals banner to **stderr** (both modes). For JSON
  mode this is a single stderr line: `regel: fail (21 violations)`.
- Keep `if (!result.passing) Effect.fail(...)` for exit code 1.

### Step 5 — Stdout/stderr discipline in `ProcessReporter`

File: `packages/core/src/reporters/process.ts`

- Already writes the violation count to stderr. Keep, but make the message
  match the new banner (`regel: <pass|fail> (N violations)`).

### Step 6 — `regel list` mode support

File: `packages/cli/src/main.ts` (`listCommand`)

- Add `--format` (same choices minus `github`). `json` → `JSON.stringify(entries)`
  to stdout (no indent). `pretty` → current `formatList`, TTY-gated.

### Step 7 — Tests

File: `packages/core/tests/reporters/reporters.test.ts` (extend) and a new
`packages/cli/tests/format.test.ts`.

- `format.test.ts`:
  - `formatEnvelope` on a passing result → `status:"pass"`, `total:0`,
    `violations:[]`, no `truncated`.
  - `formatEnvelope` on a failing result → flat violations, `sev` enum
    correct, `col:null` when absent, zero-viol rules omitted.
  - Capping: 60 violations → 50 in output, `truncated:10`, `hint` set.
  - `--all` → no cap.
  - Pretty `formatViolations` groups by file (assert order).
  - **Bundle regression**: a test that shells out to `bun build` +
    `node dist/main.js check` and asserts the divider bytes are
    `\xe2\x94\x80` (not `c3 a2 c2 94 c2 80`). This catches the Bun-bundler
    regression if it resurfaces.
  - `detectFormat`: explicit > legacy > auto; auto picks `json` when
    `!isTTY` and when `CLAUDE_CODE=1`.

### Step 8 — Docs

- `API-DESIGN.md`: document the output contract (envelope schema, stream
  rules, mode precedence, env vars, capping).
- `packages/cli/src/skill.ts` (`SKILL_MARKDOWN`): tell agents to run
  `regel check` (auto-detects JSON) and how to read the envelope.

---

## Out of scope (deliberately)

- NDJSON streaming (Option A3 from research) — not now; single document is the
  PAO/clispec norm. Can revisit if streaming is needed.
- TOON/GCF token encodings — risky, not standard for stdout contracts.
- Replacing `@effect/cli`'s `Console` — not needed; the bug is in the literal,
  not the Console layer.
- Fully root-causing the Bun bundler interaction — the escapes + TTY guard +
  JSON-is-ASCII combination makes it moot. The regression test guards us.

---

## Open questions for the user

1. **Default cap value**: 50 violations in JSON mode — OK, or prefer 25/100?
2. **`github` format**: surface as a `--format=github` choice (parallel to
   json/pretty), or keep GitHub-actions output only via the existing
   `GitHubActionsReporter` layer (CI-only, not a CLI format)? I lean
   "surface it" for symmetry, but it's optional.
3. **`--json` legacy flag**: keep as alias indefinitely, or deprecate-with-
   warning now and remove in v0.2? Lean: keep silent alias for now.
4. **Banner to stderr**: confirm you're OK with the `PASS/FAIL` line living on
   stderr (so `regel check | jq .summary` works cleanly). This is the
   clispec recommendation but is a behavior change for anyone scraping stdout
   today.

---

## Sequencing (once approved)

1. Step 1 (escapes + TTY gate + file grouping) — **ships the bug fix alone**,
   can go out first.
2. Steps 2–4 (envelope + detection + wiring) — the agent-mode feature.
3. Steps 5–6 (reporter/list parity).
4. Step 7 (tests, incl. bundle regression).
5. Step 8 (docs).

Each step is independently shippable; Step 1 is the highest-value/lowest-risk.

---

## Status: IMPLEMENTED (2026-06-26)

All steps done. Decisions applied per user:
- Cap = 50. ✅
- `--format=ci` (GitHub Actions annotations). ✅
- `--json` removed entirely (no back-compat shims). ✅
- Banner to stderr. ✅

### Key implementation note (root cause refined)

The `\u2500` escapes did **not** survive `bun build` — the bundler rewrites
them to raw UTF-8 bytes in the output, which then get mis-decoded at module-
eval time under loaded transitive deps. The actual fix is building glyphs via
`String.fromCharCode(0x2500)` etc., which the bundler cannot fold into a
literal. Verified: 0 double-encoded bytes in both TTY and piped pretty mode
under the built bundle. Regression test (`bundle-mojibake.test.ts`) runs the
built binary under a PTY to guard against resurfacing.

### Files changed
- `packages/cli/src/format.ts` — full rewrite (escapes→fromCharCode, TTY gate,
  file-grouping, JSON envelope, ci format, status banner, detectFormat).
- `packages/cli/src/main.ts` — `--format`/`--all`, `--json` removed, banner to
  stderr via `process.stderr.write`, stream discipline.
- `packages/cli/src/index.ts` — updated exports.
- `packages/cli/src/skill.ts` — `--format=json` references + envelope guidance.
- `packages/cli/package.json` — added `test`/`test:watch` + vitest devDep.
- `packages/cli/tests/format.test.ts` — 20 unit tests for envelope/ci/banner/
  grouping/detection.
- `packages/cli/tests/bundle-mojibake.test.ts` — PTY-based regression test.
- `packages/core/src/reporters/process.ts` — banner shape aligned, exit-code
  logic keyed on violations (not just passing).
- `packages/core/src/reporters/json.ts` — doc note re: CLI envelope supersedes.
