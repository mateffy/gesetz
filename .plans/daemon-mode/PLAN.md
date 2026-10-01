# Daemon mode (`gesetz daemon`) Implementation Plan

> **Status:** DRAFT — Phases 0–2 are executable today; Phases 3–7 are a design with
> decision gates, because two of them depend on Phase 0's audit results.
> **Plan:** `./.plans/daemon-mode/PLAN.md`
> **Research:** `./.plans/daemon-mode/RESEARCH.md` (raw codebase findings)
> **Last updated:** 2026-09-30

---

## ⚠️ Instructions for the implementing agent

**READ THIS SECTION BEFORE TOUCHING ANY CODE.**

You are an executor. Your job is to implement this plan exactly as written. This
plan was written with full context from a prior research and design session. You do
not have that context. The plan is your complete specification.

**Rules you must follow without exception:**

1. **Phases 0, 1 and 2 are specified to the line — implement them exactly.** They
   are prerequisites for everything else and they are independently useful, so they
   must land even if the daemon never gets built.

2. **Phases 3–7 are a design, not a specification.** They contain decisions already
   made (transport, single writer, staleness semantics) and decisions deliberately
   left open (see [Open questions](#open-questions)). When you reach a phase and find
   a choice the plan does not make, **stop and ask the user**. Do not guess.

3. **Phase 0 is an audit whose result changes Phase 5.** Do not start Phase 5 before
   Phase 0's table is filled in and the user has seen it.

4. **Do not change the plan.** If you believe a decision is wrong, stop and say why.

5. **Work phase by phase.** Each phase must leave the repository green (`pnpm
   typecheck`, `pnpm test`, `pnpm dogfood`). Do not leave a phase half-wired.

6. **Update the Progress section** as you work: phase checkboxes, task checkboxes,
   and a session-log entry after each phase. A compacted session must be able to
   resume from that section alone.

---

## Goal

A per-project background process that watches the files the config selects, keeps
the cache hot, recomputes what changed, and answers agents' check requests — so that
twenty agents in one worktree share one scan and one run of each tool instead of
twenty of each, and so that an agent can ask for one rule group ("just the type
checker") and be answered from that same hot state.

## Approach

The daemon is the **single writer** of the existing cache and a **server of the
existing envelope**. Everything it needs to be incremental already exists: the cache
is per-file and keyed by `mtimeMs:size`; `matchesPerFile` answers "does rule R care
about file F" in O(rules); `toolWatchPatterns` says which files each tool owns;
`rulePatterns(config)` is the watch set; `treeStateFor` is a change authority that
does not depend on fs events; `narrowRunResult` slices a whole-tree result to a
scope; and the coordination files already implement wait-and-reuse. The daemon is
what those pieces become when one process holds them open.

Alternatives considered and rejected:

- **Do nothing; keep file-based coordination.** Rejected: measured 2,528 s for one
  scoped check under a twenty-agent fleet, ~360 MB RSS per process, and twenty runs
  of every tool. Coordination can share a result *after* the fact, but it cannot
  avoid the work: the first agent's scope does not cover the second's.
- **Rely purely on each tool's own watch mode.** Rejected as the primary design:
  vitest, tsc and eslint have watch modes, but oxfmt, phpstan, phpunit, pest and the
  core AST rules do not, so a fleet would still spawn N processes for the rest — and
  a tool watch mode knows nothing about *gesetz* rules, baselines or scopes. It is a
  per-adapter acceleration (Phase 5), not the architecture.
- **One daemon per worktree vs one per machine.** Per-project chosen: the cache is
  already namespaced per project root, and a shared daemon would need cross-project
  scheduling, security and lifecycle answers for no benefit.
- **HTTP on localhost vs a unix socket.** Unix socket chosen: no port allocation, no
  network surface, no firewall prompts, and a file permission model that matches the
  cache's. A path is also a *discoverable* rendezvous point, which is what lets the
  client fall back cleanly when the daemon is absent.
- **chokidar (or any watcher dependency).** Rejected: `node:fs` plus a reconciliation
  walk covers it — see Phase 4 — and this project has spent real effort removing a
  dependency tree from its install.

## Tech stack & conventions

- TypeScript, Effect for the core, `@effect/cli` for commands, vitest for tests.
- **No new runtime dependencies** without asking the user first. The socket, queue
  and fs-event layer must be built from `node:net`, `node:fs`, `node:child_process`.
- `packages/core/src/cache/**` may import only `node:*` and its own siblings (there
  is a purity test enforcing this — `packages/core/tests/cache/purity.test.ts`).
- Tests mirror `src`: `packages/<pkg>/tests/<mirror-of-src>.test.ts`.
- **Fail closed, never open.** A rule that cannot run must not report success; a tool
  whose report cannot be read is an error, not "no violations"; a scope that cannot
  be read as a scope must be skipped, not widened. This is the project's most
  important invariant and the daemon must not weaken it.
- **Nothing silent.** Every reduction in what was checked is reported: on stderr for
  humans, in the envelope for machines.
- A failure that cannot be tested is unfinished. Non-trivial logic leaves one
  runnable check behind.
- Wording in user-facing output is plain language, not jargon.

---

## Context & orientation

Read `./.plans/daemon-mode/RESEARCH.md` for the raw inventory. The orientation below
is the minimum needed to follow this plan.

**How a run works today** (`packages/core/src/engine/runner.ts`): a run discovers
candidate files (`discovery.ts`), reads the cache, computes the files whose stamp
moved, runs per-file rules file-major over those, runs project and file-system rules,
then aggregates (`engine/aggregate.ts`) into a `RunResult`. `packages/cli/src/main.ts`
wraps that in coordination (`engine/run-lock.ts`), narrows a reused whole-tree result
(`narrowRunResult`), and prints either `format.ts`'s human output or
`envelope.ts`'s JSON.

**Terms used below.**

- **rule** — a named check. `rule.perFile` (runs on files it matches), `rule.project`
  (runs once), or neither (runs unconditionally).
- **file-system rule** — a rule that reads neighbouring files to decide
  (`requireTest` asks whether a sibling test exists). `ruleReadsFileSystem(rule)`
  identifies these; they cannot be cached per file alone.
- **scope / request** — the `--files` and `--since` filters. `requestKeyFor` in
  `packages/cli/src/check-coordination.ts` splits identity into an instance (rules,
  thresholds, baseline, storage) and a scope (paths, `--since`).
- **tree state** — `treeStateFor(root)`: a comparable `path → mtime:size` map. Two
  runs may share a result only when their tree states match.
- **envelope** — the `--format=json` output (`v`, `status`, `total`, `violations`,
  `summary`, `categories`, `baseline`, `coordination`). Agents already parse it. The
  daemon must serve the same shape, not a new one.
- **marks** — per-rule, per-file results in the cache (`synced.values`), including
  the rule having been *skipped*, which is different from having passed.

---

## Scope

**In scope (exact paths, by phase):**

- `packages/cli/src/main.ts` — check options, daemon command, client wiring
- `packages/cli/src/check-options.ts` — option definitions (extracted helper)
- `packages/cli/src/daemon.ts` — new: client and lifecycle commands
- `packages/cli/src/daemon-protocol.ts` — new: request/response types and framing
- `packages/core/src/engine/rule-execution.ts` — reuse `matchesPerFile`
- `packages/core/src/engine/daemon/server.ts` — new: the server
- `packages/core/src/engine/daemon/queue.ts` — new: request queue and scheduling
- `packages/core/src/engine/daemon/invalidation.ts` — new: change → work
- `packages/core/src/engine/daemon/watcher.ts` — new: fs events + reconciliation
- `packages/core/src/backend/rule-filter.ts` — new: rule-group filtering
- `packages/tsc/**` — new package: the type-check adapter (Phase 2)
- `packages/cli/src/skill.ts` — briefs (Phase 7)
- Tests beside each: `packages/<pkg>/tests/**`

**Out of scope:**

- The immocore repository and any other consumer repo. This plan changes gesetz only.
- Anything under `packages/*/dist/**` (build output).

**Forbidden actions (do not do these under any circumstances):**

- Do NOT add a runtime dependency (chokidar, ws, express, a daemon library) without
  asking the user.
- Do NOT bind a network port. The transport is a unix socket.
- Do NOT make the daemon required: `gesetz check` must keep working, correctly, with
  no daemon running.
- Do NOT let a daemon failure produce a pass. If the daemon cannot be reached, fall
  back to a direct run; if it errors, the exit code must reflect that.
- Do NOT change the JSON envelope's existing fields or their meaning. New fields are
  additive only.
- Do NOT weaken the cache's single-writer guarantee. If the daemon is running, it is
  the writer; a direct run while the daemon is alive must either be refused or use a
  separate storage, not race it.

---

## Acceptance criteria

Observable, each with a command.

1. **Rule filtering, without a daemon.**
   `node packages/cli/dist/main.js check --rule no-god-files` runs only that rule;
   the envelope's `total` equals that rule's violation count, and other rules' ids
   are absent from `violations[].rule`.
2. **Type checking as a gesetz rule.**
   With `tsc({ pattern: 'packages' })` in `gesetz.config.ts`,
   `… check --rule tsc` reports type errors as violations with file and line, and
   `… check` (no filter) includes them.
3. **One daemon per project, discoverable.**
   `… daemon start` prints the socket path and exits only once the socket answers;
   `… daemon status` prints `running`, the pid, the tree state's file count, and the
   number of queued/committed requests; `… daemon stop` removes the socket and exits
   the process.
4. **Agents are served, and the work is shared.**
   Two `check --files <scope>` requests for different scopes, issued while the daemon
   runs, both return `status` from the same recompute — the daemon's log shows one
   tool invocation, not two.
5. **The daemon's absence changes nothing about correctness.**
   With the daemon stopped, the same two commands produce the same `total` as they
   did with it running. (Same numbers, same rules, same exit code.)
6. **No silent reduction.**
   A daemon-scoped response that could not decide a rule says so: `checksNotRun` (or
   the equivalent) is present and non-empty, and a rule that needs a neighbour outside
   the scope is listed there rather than reported as passing.
7. **Memory is one process.**
   With the daemon running, N concurrent `check` clients do not add N gesetz
   processes: `ps -eo rss,command | grep -c "[g]esetz"` stays at 1 plus the clients,
   and the daemon's RSS does not grow with the number of clients.

---

## Architecture

### Data flow

```
        agents (N)                      daemon (1)                        tools
  ┌────────────────────┐        ┌──────────────────────────┐      ┌──────────────┐
  │ gesetz check       │        │ watcher (fs events)      │      │ vitest       │
  │  --files …         │  unix  │   + reconciliation walk  │      │ tsc --watch  │
  │  --rule …    ──────┼───────▶│ queue (dedupe, priority) │─────▶│ oxlint       │
  │  --since …         │ socket │ recompute (per-file)     │      │ phpstan      │
  │  (waits)     ◀─────┼────────│ cache (single writer)    │      └──────────────┘
  └────────────────────┘        │ envelope (same contract) │
        │                       └──────────────────────────┘
        │ no socket?                       ▲
        └───────────▶ direct run ───────────┘ (fallback: today's path, unchanged)
```

### Request model

A daemon request is exactly what `check` already accepts, plus rule filters:

```ts
interface DaemonRequest {
  readonly id: string;                    // client-generated, echoed back
  readonly scope: {
    readonly files: readonly string[] | null;   // --files, expanded
    readonly since: string | null;              // --since
  };
  readonly rules: readonly string[] | null;     // --rule ids, expanded from groups
  readonly categories: readonly string[] | null;// --category
  readonly baseline: 'apply' | 'ignore';        // --baseline / --no-baseline
  readonly wantStale: boolean;                  // report entries that no longer fire
  readonly waitMs: number;                      // how long the client may wait
}
```

The response is the existing envelope, plus three additive fields:

```ts
interface DaemonResponse {
  // The envelope exactly as `buildEnvelope` (packages/cli/src/envelope.ts:110) returns it:
  // unchanged shape, unchanged meaning.
  readonly envelope: ReturnType<typeof buildEnvelope>;
  readonly servedFrom: 'recomputed' | 'cache' | 'mixed';
  readonly checksNotRun: readonly string[];     // rules this response cannot decide
  readonly computedAt: number;                  // ms epoch of the tree state answered
}
```

`checksNotRun` is the load-bearing field. A rule that needs a neighbour outside the
requested scope, or a tool whose report was not produced for this request, must be
named there. An empty `checksNotRun` is a claim that every rule was decided — and
that claim must be earned, never assumed.

### The five invariants

1. **No request is answered from a state older than the tree.** The queue tracks the
   tree state. A response carries `computedAt` and the client may not serve it if the
   file it asked about changed since. Reuse is only ever from a matching tree state
   (this is `treeStatesMatch`, already in the codebase).
2. **Single writer.** The daemon owns the cache while it lives. A direct run either
   refuses while the daemon is alive or uses `GESETZ_DB` at a different path.
3. **A missing daemon is not a failure.** The client falls back to today's direct run
   (coordination files and all). Correctness is identical; only the cost differs.
4. **A daemon error is never a pass.** Transport failure, protocol error, or a rule
   that threw: the exit code reflects it.
5. **Everything skipped is named.** In the response and on stderr.

### What is incremental, and what is not

| Kind | Recompute on change | Why |
|---|---|---|
| Per-file rules (`rule.perFile`, `!ruleReadsFileSystem`) | Only for the changed files | The cache is per file; `matchesPerFile` maps the change to rules |
| External per-file tools (oxlint, oxfmt, phpstan) | Only the changed files the tool owns | `scopedPatterns(changed, toolWatchPatterns)` |
| File-system rules (`requireTest`, `requireSibling`) | For the changed file **and** its neighbours' covered path set | The answer depends on the file set, not one file |
| Whole-project tools (vitest, tsc, storybook) | As a unit, batched | Their answer is about the project |
| Architecture rules (`noCycles`) | As a unit, batched | Reads the whole import graph |

---

## Phases & tasks

### Phase 0: capability audit (no production code)

**Why:** Phase 5's design depends entirely on which tools will actually run cheaper
in a long-lived mode. Guessing here produces a fleet of half-watched tools.

**Deliverable:** a table filled in and shown to the user, with a decision per tool.

- [ ] **Task 0.1:** For each tool in this table, run the command and record the
      result. Run them in a real repository, not in gesetz's own tree (the immocore
      worktree at
      `/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger`
      is read-only: run, never edit).

      ```bash
      for bin in vitest tsc eslint oxlint oxfmt phpstan preacher pest phpunit; do
        printf '%s: ' "$bin"
        node_modules/.bin/$bin --help 2>&1 | grep -iE "watch|incremental|cache|changed" | head -3
      done
      ```
      Expected: a line per tool naming its watch/incremental/cache flags, or nothing.

- [ ] **Task 0.2:** Measure the claim, for the two tools that matter most. With a
      real project loaded, compare one-shot against watch mode for the *time to the
      first result after a one-file edit*:

      ```bash
      # one-shot, warm: time a scoped run
      time bun x gesetz check --files "$SCOPE" >/dev/null
      # watch mode: start it, touch one file, and measure until the output appears
      ```

      Expected: two numbers per tool. This is the only evidence that decides Phase 5.

- [ ] **Task 0.3:** Fill in a table in `./.plans/daemon-mode/RESEARCH.md` §3 with the
      verdict per tool: `native watch`, `incremental cache only`, or `none`, plus the
      measured milliseconds. **Then stop and show the user.** Phase 5 does not start
      without this.

### Phase 1: rule filters (`--rule`)

**Why:** The daemon is useless as a "violations server" until an agent can ask for a
subgroup. Today `check` has `--category` but no rule filter, so "run only the type
checker" is inexpressible. This phase is independently valuable and small.

**Files:**

- Create: `packages/core/src/backend/rule-filter.ts` (the pure filter, exported from
  `@gesetz/core` so the daemon can reuse it server-side)
- Modify: `packages/cli/src/check.ts` — `resolveCheckScope` (~line 27–53), which
  already narrows the rule list and the thresholds for `--category`
- Modify: `packages/cli/src/main.ts` — the check option list (~line 48–116) and the
  `resolveCheckScope` call (~line 142) that produces `filteredConfig` (~line 148)
- Test: `packages/core/tests/backend/rule-filter.test.ts`,
  `packages/cli/tests/check.test.ts` (exists)

**Design:** a filter is a list of ids, globbed — so `--rule 'no-*'` works, and a
group name can be added later without a new flag. Filtering happens inside
`resolveCheckScope`, which is where `--category` already filters and which already
returns `{ rules, thresholds }`: the flag is one more input, not a new code path.
That means the existing request key already distinguishes it (rules are part of the
instance key), the cache scopes already separate it, and no runner change is needed.

- [ ] **Step 1 (failing test first):**

      ```ts
      // packages/core/tests/backend/rule-filter.test.ts
      import { describe, expect, it } from 'vitest';
      import { filterRules } from '../../src/backend/rule-filter';

      const rule = (id: string) => ({ id, description: id, run: null }) as never;

      describe('filterRules', () => {
        const rules = [rule('no-god-files'), rule('no-empty-catch'), rule('tsc'), rule('vitest')];

        it('keeps only the named rules', () => {
          expect(filterRules(rules, ['tsc']).map((r) => r.id)).toEqual(['tsc']);
        });
        it('accepts globs, so a family is one flag', () => {
          expect(filterRules(rules, ['no-*']).map((r) => r.id)).toEqual([
            'no-god-files',
            'no-empty-catch',
          ]);
        });
        it('throws for a filter that matches nothing, naming what it tried', () => {
          // Silent no-match is how an agent believes it checked something. The rule
          // ids that exist are listed so the mistake is one line long.
          expect(() => filterRules(rules, ['typo'])).toThrowError(/no rule matches 'typo'.*tsc/s);
        });
        it('passes every rule through when the filter is null', () => {
          expect(filterRules(rules, null)).toHaveLength(4);
        });
      });
      ```

      Note there is **no** test for parsing `--rule` values: `parseFileRequest`
      (`packages/cli/src/check.ts:19`) already splits a repeated option's values on
      commas, trims, drops empties and returns null when there is nothing — the exact
      behaviour a rule filter needs, and it is covered by
      `packages/cli/tests/check.test.ts`. Reuse it (Step 5) rather than adding a
      near-duplicate.
      ```

- [ ] **Step 2:** Run it and confirm it fails for the right reason.
      ```bash
      cd packages/core && npx vitest run tests/backend/rule-filter.test.ts
      ```
      Expected: FAIL — `Failed to resolve import "../../src/backend/rule-filter"`.

- [ ] **Step 3 (implement):**

      ```ts
      // packages/core/src/backend/rule-filter.ts
      /**
       * Rule filtering, for `--rule`.
       *
       * A filter is globbed, so `--rule 'no-*'` names a family and a tool name names
       * the rule that tool contributed. A filter matching no rule is an error, not an
       * empty run: an agent that believes it checked something must not be told a
       * quiet nothing.
       */
      import micromatch from 'micromatch';
      import type { Rule } from '../engine/rule';

      export function filterRules(rules: readonly Rule[], filter: readonly string[] | null): Rule[] {
        if (filter === null) return [...rules];
        const kept = rules.filter((rule) => micromatch.some([rule.id], [...filter]));
        if (kept.length === 0) {
          const known = rules.map((rule) => rule.id).sort().join(', ');
          throw new Error(
            `no rule matches '${filter.join(', ')}'. Rules in this config: ${known}`,
          );
        }
        return kept;
      }
      ```

- [ ] **Step 4:** Run the test again.
      ```bash
      cd packages/core && npx vitest run tests/backend/rule-filter.test.ts
      ```
      Expected: PASS (6 tests).

- [ ] **Step 5:** Wire the flag, mirroring `--files` exactly (`packages/cli/src/main.ts:~76`
      uses `Options.text(...).pipe(Options.repeated)`). Add to the check options after
      `category`:

      ```ts
      rule: Options.text('rule').pipe(
        Options.withDescription(
          'Only run these rules (comma-separated, globs allowed, repeatable)',
        ),
        Options.repeated,
      ),
      ```

      Then `packages/cli/src/check.ts`: `resolveCheckScope` gains
      `ruleFilter: readonly string[] | undefined`, applies it to the already
      category-filtered list, and throws the no-match error from `filterRules`. Its
      caller at `packages/cli/src/main.ts:142` passes it the same way the file request
      is parsed at `packages/cli/src/main.ts:126`:

      ```ts
      const ruleFilter = parseFileRequest(opts.rule);   // same comma/repeat handling
      ```

      and passes `ruleFilter` into `resolveCheckScope`. `filterRules` is exported from
      `@gesetz/core` (`packages/core/src/index.ts`).

- [ ] **Step 6 (end-to-end test):** in `packages/cli/tests/rule-filter.test.ts`, run
      the built CLI in a temp project with two rules and assert that `--rule <one>`
      reports only that rule's violations, that `--rule nomatch` exits non-zero with
      the message above, and that no `--rule` still reports both.

- [ ] **Step 7:** Update the brief in `packages/cli/src/skill.ts`: one sentence under
      "Run checks" naming `--rule` and giving the pattern
      `gesetz check --rule tsc` as "only the type checker".

- [ ] **Step 8:** Document it under `README.md`'s `### 3. Run checks` heading (line 63)
      and in the `check --help` description, in plain language — and, in the same
      breath, that `--rule` is a *scope*: a rule the filter excluded has **not** been
      checked, and no output may imply it was. The envelope's `checksNotRun` (Phase 4)
      is where that becomes machine-readable; until then the human output must say so.

### Phase 2: a type-check rule (`@gesetz/tsc`)

**Why:** This is the tool agents spawn most and the one that is least shared. Without
it, "gesetz is the only way to check" cannot be true, and the daemon has nothing
expensive worth serving.

**Files:**

- Create: `packages/tsc/package.json`, `packages/tsc/src/index.ts`,
  `packages/tsc/src/adapter.ts`, `packages/tsc/README.md`
- Create: `packages/tsc/tests/adapter.test.ts`
- Modify: `packages/core/src/engine/exec.ts` only if a timeout knob is missing

**Design:** a **project** rule (not per-file): the type checker answers about the
project, and pretending otherwise would produce a rule that reports "clean" for a
file whose types depend on another file. It runs the configured binary with
`--noEmit` (defaults: `tsc`; `vue-tsc` and a custom `bin`/`args` are supported so a
repository can point it at its own script), parses `file(line,col): error TSxxxx:
message` into violations with `path` and `line`, and is **scoped by
`toolWatchPatterns`** like every other adapter.

- [ ] **Step 1 (failing test first):** a test that feeds a captured tsc output
      fixture through the parser and asserts one violation per diagnostic with path,
      line and message; plus a test that an *unparseable* report is an error
      violation, not silence.
- [ ] **Step 2:** Confirm both fail (no module yet).
- [ ] **Step 3:** Implement the parser as a pure exported function
      (`parseTscOutput(output, cwd)`) so it is testable without spawning anything,
      then the adapter around it, modelled on `packages/oxlint/src/adapter.ts`
      (same shape: `toolWatchPatterns`, `execTool`, an unreadable report is an error).
- [ ] **Step 4:** Confirm the tests pass.
- [ ] **Step 5:** No workspace edit is needed — `pnpm-workspace.yaml` declares
      `packages/*`, so a new directory is picked up automatically. Bump the package's
      version to match the others (currently `3.0.0-rc.7`) and add it to the root
      `package.json`'s publish list if one exists.
- [ ] **Step 6 (manual acceptance):** in a scratch project with one type error,
      `check --rule tsc` reports exactly that error with its line, and `check`
      includes it alongside the other rules. **This adapter is a confirmed
      requirement, not a nice-to-have**: without it, the tool agents spawn most sits
      outside gesetz entirely, and "gesetz is the only way to check" cannot be true.

### Phase 3: adapters declare what they replace

**Why:** An adapter knows the command it makes unnecessary — `tsc --noEmit` becomes
`gesetz check --rule tsc`. That knowledge belongs in the adapter, next to the code
that runs the tool, and it should reach the agent automatically: a project prints the
recipe for *the adapters it actually configured*, and an agent injects that output
into its prompt. This is what turns `gesetz check` from a tool the agent *could* use
into the one it reaches for.

**Files:**

- Modify: `packages/core/src/engine/rule.ts` (additive field on `Rule`)
- Modify: `packages/tsc/src/adapter.ts`, and the same field for `packages/oxlint`,
  `packages/vitest`, `packages/phpstan`, `packages/eslint`, `packages/oxfmt`,
  `packages/prettier`, `packages/phpunit`, `packages/pest`
- Create: `packages/cli/src/replacements.ts`
- Modify: `packages/cli/src/skill.ts`, `packages/cli/src/main.ts` (the `skill`
  command builds the static markdown plus the generated section)
- Test: `packages/cli/tests/replacements.test.ts`, `packages/cli/tests/skill.test.ts`

**Design:** the declaration rides on the rule, because the rule is what the config
already carries and what the filter (`--rule`) already selects. It is one additive
optional field, so third-party adapters get it for free and adapters that say nothing
keep working.

```ts
// packages/core/src/engine/rule.ts
/**
 * A command this rule makes unnecessary.
 *
 * Declared by the adapter that runs the tool, so the agent-facing recipe is
 * generated from what a project actually configured rather than hand-maintained.
 */
export interface ToolReplacement {
  /** What an agent would otherwise run. Shown verbatim, in backticks. */
  readonly instead: string;
  /** What to run so gesetz does it instead. */
  readonly use: string;
  /** A one-line caveat, when the equivalence is not exact. */
  readonly note?: string | undefined;
}

// and on Rule:
readonly replaces?: readonly ToolReplacement[] | undefined;
```

```ts
// packages/tsc/src/adapter.ts
tsc({ pattern: 'packages' })
// contributes a rule whose `replaces` is:
[
  { instead: 'tsc --noEmit', use: 'gesetz check --rule tsc' },
  {
    instead: 'bun run typecheck',
    use: 'gesetz check --rule tsc',
    note: 'when that script runs tsc',
  },
]
```

- [ ] **Step 1 (failing test first):** a pure renderer, tested without a CLI:

      ```ts
      // packages/cli/src/replacements.ts
      /**
       * The agent-facing recipe for the adapters this project configured.
       *
       * Generated, never hand-maintained: a project that installs an adapter gets its
       * recipe. The closing line about what is *not* covered is deliberate — a list of
       * replacements reads as "everything is covered" otherwise, and an agent that
       * assumes coverage stops looking.
       */
      export function renderReplacements(rules: readonly Rule[]): string {
        const seen = rules.flatMap((rule) => rule.replaces ?? []);
        if (seen.length === 0) {
          return 'No configured adapter replaces a command yet, so run the tools directly.';
        }
        const lines = seen.map(
          (entry) => `- \`${entry.instead}\` → \`${entry.use}\`${entry.note ? ` (${entry.note})` : ''}`,
        );
        return [
          'Run these through gesetz instead of running the tool yourself:',
          '',
          ...lines,
          '',
          'Tools not listed here are not covered by gesetz: run them directly, and',
          'say so if one of them deserves an adapter.',
        ].join('\n');
      }
      ```

      Test: an empty rule list renders the "nothing configured" sentence; one rule
      with two replacements renders both with their notes; and the last line about
      uncovered tools is always present.

- [ ] **Step 2:** run it, confirm it fails to import.
      ```bash
      cd packages/cli && npx vitest run tests/replacements.test.ts
      ```
      Expected: FAIL — cannot resolve `../src/replacements`.
- [ ] **Step 3:** implement the renderer, then the `Rule.replaces` field, then the
      declarations in the adapters, each with a test asserting the *ids and commands*
      (not the prose).
- [ ] **Step 4:** generate it in `gesetz skill`. The `skill` command currently prints
      a constant; make it load the project config and append
      `renderReplacements(config.rules)`. A project with no config keeps working and
      prints only the static part plus the "nothing configured" sentence.
- [ ] **Step 5 (manual acceptance):** in the pilot repo, run
      `bun x gesetz skill` and confirm the *configured* tools appear, in plain
      language, with the exact command to run — and that a tool with no adapter is
      absent, and the closing caveat about uncovered tools is there.
- [ ] **Step 6:** update `packages/cli/src/skill.ts`'s prose so the generated section
      is introduced rather than duplicated: one sentence saying the list below is
      generated from this project's configuration.

**Note on scope:** this phase ships no daemon dependency. It works with a direct
`gesetz check` today, which is why it comes before the daemon: it is the cheapest way
to change what agents reach for, and it is the prerequisite for the enforcement in
Phase 8.

### Phase 4: the daemon core

**Why:** One process to hold the cache open, own the queue, and answer requests. This
is where the fleet's twenty runs become one.

**Files:**

- Create: `packages/core/src/engine/daemon/server.ts`, `.../queue.ts`,
  `.../lifecycle.ts`
- Create: `packages/cli/src/daemon.ts` (client + `daemon start|stop|status|run`)
- Create: `packages/cli/src/daemon-protocol.ts` (framing, shared by both sides)
- Test: `packages/core/tests/engine/daemon/server.test.ts`,
  `packages/cli/tests/daemon.test.ts`

**Decisions already made** (do not re-litigate):

- Transport: a unix socket at `<root>/.gesetz/daemon.sock`, mode `0600`, with a
  JSON-lines protocol (one request per line, one response per line). Length-capped
  reads; a malformed line is answered with an error, never ignored.
- Rendezvous: the socket's existence is the discovery mechanism. No pid file is
  authoritative for liveness; the socket answering is.
- The daemon is the only cache writer while it lives.
- The client always has the fallback: no socket, or a socket that fails to answer
  within `waitMs`, means "run it directly".

- [ ] **Step 0 (the tri-state, decide before the server):** the daemon must be
      controllable three ways, and the precedence must be explicit and tested:

      ```ts
      // config:  daemon: true | false | undefined   (undefined = false, off by default)
      // flag:    --daemon     force it on, whatever the config says
      // flag:    --no-daemon  force it off, whatever the config says
      // existing: --standalone  means "no daemon and no coordination": one process,
      //                         one run, no waiting, no reuse
      ```

      Resolution order, first match wins: `--no-daemon` → off; `--daemon` → on;
      `--standalone` → off (and no coordination either); config `daemon: true` → on;
      otherwise off. "On" means: if a daemon is running, use it; if none is running,
      **run directly** — `check` must never start a daemon behind the user's back,
      because a background process nobody asked for is a surprise, and a surprise
      that outlives the command is worse. `daemon start` is the only thing that starts
      one. A new test in `packages/cli/tests/daemon.test.ts` covers all five rows of
      that table.

- [ ] **Step 1 (protocol, testable in isolation):** write
      `packages/cli/src/daemon-protocol.ts` with `encodeRequest`, `decodeRequest`,
      `encodeResponse`, `decodeResponse` and a length cap; test round-trips,
      malformed input, and an oversized line.
- [ ] **Step 2 (queue, testable without a socket):** `queue.ts` holds pending
      requests and produces a plan: dedupe identical requests, merge overlapping file
      scopes into one recompute, order by "the request that unblocks the most
      clients" then by arrival, and cap concurrency at `jobs`. Test the merge and
      dedupe rules directly — no socket, no processes.
- [ ] **Step 3 (server):** accept connections, hand each line to the queue, and
      answer each client with the envelope for its own request, narrowed by
      `narrowRunResult` when the recompute was wider. Test with a real socket on a
      temp dir.
- [ ] **Step 4 (lifecycle):** `daemon start` (fork the daemon, wait until the socket
      answers, print the path), `daemon stop`, `daemon status` (pid, tree-state file
      count, queue depth, last recompute), `daemon run` (foreground, for debugging).
      Stale socket handling: if the socket file exists but nothing answers, the
      client falls back *and* says so on stderr.
- [ ] **Step 5 (client wiring):** in `main.ts`, resolve the tri-state from Step 0;
      when it is "on" and a socket exists and answers, send the request instead of
      running; on any transport failure, fall back to the direct path and say so on
      stderr. `--jobs`/`--wait-timeout` keep their meaning, and the failure modes are
      unchanged: a request is a scope, and a scope that cannot be read is skipped,
      never widened.
- [ ] **Step 6 (acceptance):** the criteria 3 and 5 above, by hand, in a scratch
      repo: daemon up, two scoped requests, one recompute; daemon down, same totals.

### Phase 5: change → work, incrementally

**Why:** Without this the daemon is a server that re-runs everything per request. Its
point is that a burst of edits produces the *smallest* recompute that covers them.

**Files:** `.../daemon/watcher.ts`, `.../daemon/invalidation.ts`, tests.

**Design:**

- **Two mechanisms, deliberately.** `fs.watch` gives latency, but its `recursive`
  option has historically been macOS/Windows-only and it drops events under load —
  **verify recursive support on the target Node version before relying on it**, and
  write the per-directory path regardless, because the reconciliation walk is needed
  either way. `treeStateFor` is the authority: it is a stat walk (289 ms for 13,711
  files) that cannot miss a change. The watcher uses events to schedule a prompt
  reconciliation, and the reconciliation decides what actually changed. Neither alone
  is sufficient: events alone miss, walking alone is late.
- **Invalidation** is pure: `changedPaths → work`. For each changed path: per-file
  rules where `matchesPerFile(path, rule.perFile)`, file-system rules whose covered
  set contains the path *or a neighbour of it*, project rules whose patterns match,
  and adapters where `micromatch.some([path], toolWatchPatterns(rule))`. All of these
  primitives exist; the new code is the mapping and its tests.
- **Config and rule-source invalidation.** Watch `gesetz.config.ts` and every file
  the config imports (in a pilot repo, the rules themselves are edited constantly).
  A change to either re-plans the run from scratch. `ruleFingerprint` already makes
  the *cache* correct; the watcher makes it timely.
- **Debounce** is the existing 150 ms (`packages/cli/src/watch.ts`), reused.

- [ ] **Step 1:** write `invalidation.ts` as a pure function with its tests first:
      given a set of changed paths and the resolved config, return the rules to re-run
      and the files to re-run them for. Cover: a per-file rule, a rule whose patterns
      do not match, a file-system rule whose neighbour changed, a whole-project tool,
      and a config change (everything).
- [ ] **Step 2:** the watcher: `fs.watch` on the project root **per directory** when
      recursive is unavailable, plus a reconciliation timer. Test the ignore rules and
      the "one burst is one recompute" behaviour with a temp dir.
- [ ] **Step 3:** connect: on a settled change, compute the work, run it, update the
      cache, and answer any queued client whose request is now decidable.
- [ ] **Step 4:** staleness. A response carries `computedAt`; a client that asked
      about a file that changed during the recompute must be told, not silently served
      an older answer. Reuse `treeStatesMatch` for the comparison.
- [ ] **Step 5 (acceptance):** criterion 4, and: editing one file in a project with
      10k files produces a recompute that mentions that file and its neighbours only
      (the daemon's log lists the work; the test asserts it).

### Phase 6: native tool modes (gated on Phase 0)

**Why:** For tools that have a good watch mode, the daemon should hold *that process*
rather than spawn a one-shot run. It is tighter integration and, for the tools where
it exists, less work.

**Design, per the Phase 0 verdict:**

- A tool with a **native watch mode** (likely vitest, tsc, eslint) is started once by
  the daemon, kept alive, and read from in its incremental output mode (vitest's JSON
  reporter to a temp file, tsc's `--watch --pretty false`, eslint's `--format json`).
  The daemon forwards the changed paths that tool owns and parses each report.
- A tool with **only an incremental cache** (phpstan's result cache) keeps the
  one-shot invocation but passes the cache directory, so the tool's own incrementality
  is preserved between runs.
- A tool with **neither** (oxfmt, phpunit, pest) is invoked per recompute as today.
- **Capability declaration:** each adapter exports whether it can be watched
  (`watchable: boolean` plus a start/read function). No daemon-side special cases for
  tool names: the daemon asks the adapter.
- **Failure modes:** a watched tool that dies is restarted, and the restart is
  reported; for the requests it could not answer, `checksNotRun` names it. A watched
  tool whose output cannot be parsed is an error, never a pass.

- [ ] **Step 1:** with the user, choose which tools Phase 0 proved worth holding open.
      **Stop and ask.**
- [ ] **Step 2:** add the capability to one adapter end-to-end (the simplest of the
      chosen set), with tests for: a report parsed into violations, a crashed process,
      and an unparseable report.
- [ ] **Step 3:** wire it into the daemon behind the capability flag; a tool without
      the capability keeps working exactly as before.
- [ ] **Step 4:** repeat for the remaining chosen tools, one at a time, each leaving
      the repo green.

### Phase 7: the dependency graph

**Why:** Edits ripple. A change to a type that thirty files import should re-check
those thirty, not just the file. This is the user's explicitly-later step; it is here
so the plan holds the place without pretending it is next.

**Design (not yet decided in detail):**

- Build a file → imports map and its reverse (dependents) once per tree state, from
  `ImportResolver.resolve` over the candidate files. Keep it in memory; it is derivable
  and cheap to rebuild.
- Extend `invalidation.ts`: changed paths → dependents (transitively, capped by depth
  and by a budget) → work. The graph only *adds* work, so it cannot cause a false pass;
  the risk is time, not correctness.
- Make it opt-in per config (`graph: { dependents: true }`) until measured, because
  on a large repo the transitive closure can be the whole project.

- [ ] **Step 1:** measure first: build the map in the pilot repo, and record its
      size, build time and the typical dependent closure for a one-line change in a
      widely imported file. **Show the numbers to the user before implementing.**
- [ ] **Step 2:** if the numbers justify it, implement the reverse index with its
      tests, then extend invalidation behind the config flag.

### Phase 8: adoption

**Why:** A daemon nobody uses saves nothing. The end state the user described is that
every check — and every direct call to a tool — goes through gesetz.

- [ ] **Step 1:** update `packages/cli/src/skill.ts`: start the daemon, ask it, the
      two-loop shape (`--rule tsc` / `--files <dir>` in the loop, everything before
      review), and the one sentence that matters: *do not call the tools directly;
      gesetz holds them hot*. The generated replacements section from Phase 3 is part
      of this document already — do not duplicate it by hand.
- [ ] **Step 2:** provide the blocking hook for the coding agents the user runs, as
      documented config (a deny rule for `tsc`, `vitest`, `phpstan`, `eslint`
      invocations). This is the user's environment, not gesetz's code: document the
      hook in the skill and in `README.md`, ship no hook by default.
      **Partly done already:** `packages/cli/src/skill.ts` has a `Reading the output`
      section with the recipes below, added on the `daemon-mode` branch. This step is
      about the README half, and about extending those recipes with `--rule` once
      Phase 1 lands — never documenting a flag before it exists.

- [ ] **Step 3:** document the recipes agents actually need, since "filter and group
      across tools" is the real ask and the envelope already carries the data:
      `--format=json --all` plus `jq 'group_by(.path)'` for grouping by file,
      `[.violations[] | select(.path | startswith("src/"))]` for a path prefix, and
      the same envelope's `summary`/`categories` for a one-line status. Put these in
      `README.md` and in the skill, as copy-pasteable one-liners — an agent that has
      to invent the jq stops using the JSON.
- [ ] **Step 4:** measure and report: the fleet's wall-clock for a scoped check with
      and without the daemon, RSS per process before/after, the number of tool
      invocations in a fixed workload, and whether agents actually stopped calling the
      tools directly (count the invocations in their logs). Numbers, not vibes.

---

## Validation

```bash
# Everything, after each phase
cd /Users/mat/dev/fabrik/gesetz
pnpm typecheck                 # Expected: no errors
pnpm test                      # Expected: all green (core 571+, CLI 179+, growing per phase)
pnpm dogfood                   # Expected: pass, 1 known warning (packages/cli/src/main.ts size)
pnpm format                    # Expected: no changes

# Phase 1
node packages/cli/dist/main.js check --rule no-god-files --format json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted({v['rule'] for v in d['violations']}))"
# Expected: ['no-god-files']
node packages/cli/dist/main.js check --rule typo; echo "exit=$?"
# Expected: an error naming the rules that exist, exit=1

# Phase 2 (in a scratch project with one type error)
node packages/cli/dist/main.js check --rule tsc
# Expected: that error as a violation, with its file and line

# Phase 3: the agent recipe, generated from what this project configured
node packages/cli/dist/main.js skill | grep -A 6 "instead of running"
# Expected: one line per configured tool adapter, e.g.
#   - `tsc --noEmit` → `gesetz check --rule tsc`
#   plus the closing line naming that unlisted tools are not covered

# Phase 4 (daemon off by default, and the precedence table)
node packages/cli/dist/main.js check --daemon; echo "exit=$?"
# Expected: runs, says on stderr that no daemon is running, exit unchanged by it
node packages/cli/dist/main.js daemon start   # Expected: prints the socket path
node packages/cli/dist/main.js daemon status  # Expected: running, pid, queue 0, last recompute
node packages/cli/dist/main.js daemon stop    # Expected: exits 0, socket removed

# Phase 5: two scopes, one recompute
node packages/cli/dist/main.js check --files 'packages/core/**' & \
  node packages/cli/dist/main.js check --files 'packages/cli/**' & wait
# Expected: both totals; the daemon log shows one recompute covering both scopes

# Phase 6/7/8: numbers into .plans/daemon-mode/PLAN.md's session log
```

---

## Risks & rollback

- **Risk:** a daemon serving a stale answer for a file that changed mid-recompute.
  **Mitigation:** every response carries `computedAt`; reuse only across matching tree
  states; a client may not serve a response whose state no longer matches. Tested in
  Phase 4 Step 4.
- **Risk:** the daemon becomes a required component, so its failure looks like a pass.
  **Mitigation:** invariants 3 and 4; a test that asserts identical totals with the
  daemon up and down.
- **Risk:** two writers (a daemon and a direct run) corrupt the cache. **Mitigation:**
  the daemon refuses to start if another daemon holds the socket; direct runs while a
  daemon is alive are refused or redirected to a separate `GESETZ_DB`. Tested.
- **Risk:** memory. A long-lived process holding parses is the point, but an unbounded
  parse memo is a leak. **Mitigation:** cap the parse memo and the graph with an LRU
  keyed by tree state, and measure RSS in Phase 4's acceptance.
- **Risk:** fs events fire in bursts and the daemon livelocks on its own cache writes.
  **Mitigation:** the existing ignore list (`.gesetz`, `.git`, `node_modules`) plus
  writing the cache to its own directory; tested in Phase 4 Step 2.
- **Risk:** a watched tool process leaks on abnormal daemon exit. **Mitigation:**
  child processes are killed on shutdown and on socket loss; `daemon stop` waits for
  them; a test asserts no orphans.
- **Rollback:** every phase is additive and independent. Phases 1 and 2 have no
  daemon dependency at all. The daemon is opt-in — its absence is today's behaviour —
  so rollback is `daemon stop` plus removing the socket, and for the code,
  `git revert` of the phase's commit. Nothing in the daemon writes to the repository
  except the existing cache and `.gesetz/`.

---

## Open questions

- [ ] **Does `daemon: true` in the config auto-start a daemon, or only route to one
      that is already running?** The plan says route only, and that `daemon start` is
      the single thing that starts a process. The reason: a background process that
      outlives the command that summoned it is a surprise, and "why is there a gesetz
      process using 400 MB from four hours ago" is a bad question to answer at 2am.
      The counter-argument is that `daemon: true` reads as "I want a daemon", and an
      agent should not have to remember two commands. — needs decision from the user.
- [ ] **Should direct tool calls be blocked in the coding agents?** The user wants
      it ("I want to make gesetz basically the only thing agents can use"), which
      means a hook in *their* agent config, not in gesetz. Phase 7 Step 2 documents
      it; a hard block is a user decision. — needs decision from the user.
- [ ] **Which tools should the daemon hold open?** Depends on Phase 0's measurements.
      — user, after Phase 0.
- [ ] **Should the daemon survive a `git checkout` that rewrites thousands of files?**
      A reconciliation walk handles it, but the recompute is then the whole project.
      Suggestion: report it plainly (`recomputed everything: 12,043 files changed`) and
      do not pretend it was incremental. — needs decision from the user.
- [ ] **Does the daemon own the *whole* cache, or only its own reads?** Invariant 2
      says single writer; the alternative is separate storage per process, which costs
      the sharing that makes the daemon worth having. — recommended: single writer,
      user confirms.
- [ ] **Where does `daemon start` get invoked in a fleet?** Per worktree by the first
      agent, by a devcontainer entrypoint, or by the user's own shell? Affects nothing
      in the design but everything in the brief. — user.

---

## Progress

**This section is maintained by the implementing agent. Update it continuously.**

### Phase completion

- [ ] Phase 0: capability audit
- [ ] Phase 1: rule filters (`--rule`)
- [ ] Phase 2: a type-check rule (`@gesetz/tsc`)
- [ ] Phase 3: adapters declare what they replace
- [ ] Phase 4: the daemon core
- [ ] Phase 5: change → work, incrementally
- [ ] Phase 6: native tool modes
- [ ] Phase 7: the dependency graph
- [ ] Phase 8: adoption
- [ ] Validation complete
- [ ] Plan marked DONE

### Session log

*The implementing agent appends an entry here after each phase or working session.
Include: what was completed, what was skipped and why, what comes next, and any
decisions made (with rationale). This log is the handoff document — a new agent
reading only this file must be able to continue without asking.*

---
*(no entries yet)*
