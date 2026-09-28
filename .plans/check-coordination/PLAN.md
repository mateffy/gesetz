# Concurrent `gesetz check` Coordination — Implementation Plan

> **Status:** DRAFT
> **Plan:** `./.plans/check-coordination/PLAN.md`
> **Last updated:** 2026-09-27

---

## ⚠️ Instructions for the implementing agent

**READ THIS SECTION BEFORE TOUCHING ANY CODE.**

You are an executor. Your job is to implement this plan exactly as written.
This plan was written with full context from a prior research and design session.
You do not have that context. The plan is your complete specification.

**Rules you must follow without exception:**

1. **Do not deviate from this plan.** Do not simplify steps, skip phases, combine
   tasks, or substitute approaches — even if a different approach seems easier or
   more elegant. The decisions here were made deliberately. Respect them.

2. **Do not make decisions not explicitly covered by this plan.** If you reach a
   point where the plan is ambiguous or where you feel you need to make a choice
   the plan does not make for you, **stop and ask the user** before proceeding.
   Do not guess. Do not pick the path of least resistance. Do not assume.

3. **Do not change the plan.** If you believe a plan decision is wrong or
   suboptimal, stop and tell the user why. Do not silently implement something
   different.

4. **Work phase by phase.** Complete one phase fully before starting the next.
   Do not jump ahead.

5. **Update the Progress section** at the bottom of this file as you work:
   - Mark phase checkboxes `[x]` when a phase is complete.
   - Mark task checkboxes `[x]` as each task is done.
   - After each phase, write a brief note under "Session log" with what was
     done and what comes next. This allows a new agent to resume from exactly
     where you left off if the session is interrupted.

---

## Goal

When several agents run `gesetz check` in one working tree at the same time,
they share a single scan instead of each running their own: later callers wait
for the run in flight, and reuse its result when that result already covers the
state of the tree they were about to check.

## Approach

Four phases, each independently useful and each leaving the repo green.

**Phase 0 fixes a stale guard that disables the entire violation cache under
Bun.** Every agent observed running `gesetz check` in this repo invoked it as
`bun node_modules/.bin/gesetz`, which sets `globalThis.Bun` and makes
`resolveStorage` return in-memory storage — so *every* agent run is a full cold
run: every file re-parsed, every external tool re-run over the whole project.
The comment justifying this says better-sqlite3 is unsupported under Bun, but
netzwerk uses `@libsql/client`, and libsql works under Bun (verified — see
Context). This is the single largest source of the CPU load, it is a three-line
change, and the coordination layer in Phases 1–3 is only cheap because the cache
underneath it works.

**Phase 1–2 add a coordination primitive in `@gesetz/core`**: a lock file plus a
run record per completed run, both under `<root>/.gesetz/coord/`. A caller that
finds a completed record whose *tree state* matches its own — same file paths,
same mtimes, same sizes — returns that record's result and runs nothing.

**Phase 3 wires it into the CLI** with notices on stderr, an additive
`coordination` object in the JSON envelope, and escape hatches.

**Phase 4 scopes the external tools** to the files a scan actually reprocessed,
which is the remaining per-run cost once the cache works.

Alternatives considered and rejected:

- **A daemon only.** Rejected as the first step, not as an idea: it removes the
  per-run process-start and scan floor (~2s on this repo), but it does not
  remove the *duplicate* work that N agents do — only coalescing does that — and
  it is the largest piece of machinery here. The protocol below is designed so a
  daemon can later be a drop-in "always-running primary" (see *Not in scope*).
- **A semaphore only (cap concurrency, no result sharing).** Rejected: it
  serialises the work but still runs it N times. Halves the damage at best.
- **Reuse keyed on time ("a run finished 3s ago, close enough").** Rejected: a
  result computed before a caller's edit is a wrong answer for that caller, and
  wrong answers from a quality gate are the failure mode this repo has spent the
  most effort on. Reuse is keyed on observed tree state, never on recency.
- **Keying reuse on file content hashes.** Rejected as the *primary* key: it
  requires reading every file, which is most of the scan cost we are trying to
  avoid. mtime + size per path is one `stat` per file, and a run is only reused
  when nothing has been written since it started (see *Reuse contract*).

## Tech stack & conventions

- TypeScript, ESM, Effect for the CLI and runner; plain `async` for check
  functions and (per this plan) the coordination primitive.
- `@gesetz/core` is a package; the CLI (`@gesetz/cli`) consumes its built `dist`.
  A core change is only visible to the CLI after `pnpm --filter @gesetz/core build`.
- Tests are **not** co-located: `packages/core/src/engine/foo.ts` is tested at
  `packages/core/tests/engine/foo.test.ts`. A source file with no test file fails
  the `testing` gate, which is set to a keep-it-at-zero threshold of 10.
- Vitest. `it()` callbacks that `await` must be `async`.
- Gates that must pass before any commit: `pnpm typecheck`, `pnpm test`,
  `pnpm dogfood`. `pnpm format` before committing.
- `.gesetz/` is gitignored (`.gitignore` line 152) — the cache, the lock, and the
  run records all live there and are never committed.
- Anything written to **stdout** is a data contract that agents parse. Notices
  for humans go to **stderr** (`Console.error` in the CLI).
- Do not add dependencies. Everything here uses `node:fs`, `node:path`,
  `node:crypto`, and what is already installed.

---

## Context & orientation

### What a run costs today (measured on this repo)

| | measured |
|---|---|
| `gesetz check` warm, quiet machine | 1.6 s, 306 files reused |
| `gesetz check` warm, 3 other agent runs live | 11.5 s – 51 s |
| `gesetz check` under Bun (cache disabled) | 11.6 s cold, **every time** |
| Peak RSS per CLI process | 175 MB |
| `oxfmt --list-different packages` | 4.1 – 6.0 s, 41 MB, 8 threads |
| `oxlint packages` | 0.7 – 1.2 s, 34 MB |

During research, `ps aux` showed three concurrent `bun node_modules/.bin/gesetz
check` processes in this repo (one with `--full`), two of them having burned ~35 s
of CPU each, plus a `storybook --ci` run. Ten of those is the failure the user
described.

### Where the time goes, per run

1. **Process start + module load** — ~0.4 s, 175 MB.
2. **Scan** — netzwerk stats/reads/hashes every discovered file (306 here,
   ~1.6 s). This is the floor of a warm run and grows with repo size.
3. **Per-file rules** — only for files whose content hash changed.
4. **Project rules = the external tools** — re-run when a file matching their
   patterns was reprocessed or removed. `oxfmt`/`oxlint` then run over the
   **whole project** (`packages`), not over the changed files, because every
   adapter's `project.run` closure ignores the `ProjectRuleContext.changedFiles`
   it is handed. This is the dominant cost and the reason 10 agents hurt.
5. **Aggregation + render** — milliseconds.

### The three defects this plan addresses

- **Defect A — the cache is off under Bun.** `packages/cli/src/main.ts:45`
  returns `{kind:'memory'}` when `isBun`. Verified false today: `@libsql/client`
  loads and persists under Bun 1.3.14 (`bun -e` probe: create/insert/select on
  `file:/tmp/...db`, rows = 1), and a full `runAll` under Bun with
  `{kind:'sqlite'}` measured **cold 11.58 s → warm 4.01 s** with markers reused.
- **Defect B — no coordination.** N processes do the same work independently.
- **Defect C — adapters ignore `changedFiles`.** `ProjectRuleContext.changedFiles`
  exists (`packages/core/src/engine/rule.ts:198`, "Repo-relative paths
  reprocessed by this scan (added + changed)") and every adapter ignores it:
  `run: () => executeOxfmt(opts, id, bin, cwd, defaultPatterns)`.

### Key files

- `packages/cli/src/main.ts` — the `check` command: option parsing (~line 52),
  the `runAndRender` Effect that calls `runAll` and renders (~line 213),
  `--watch` (~line 245), and `resolveStorage` (~line 40).
- `packages/core/src/engine/runner.ts` — `runAll` (creates the network, scans,
  collects violation markers, aggregates), `RunResult`, `RunAllOptions`,
  `toNetworkStorage`.
- `packages/core/src/engine/file-set.ts` — `fileSetFingerprint(rootDir)`, the
  path-only walk with the `NEVER_SOURCE` skip list. Phase 1 extends this file.
- `packages/core/src/backend/compile.ts` — `compileProjectRule`, which computes
  `changedFiles` and the `relevant` check that decides whether a project rule
  re-runs at all.
- `packages/core/src/adapters` — no: the adapters are `packages/oxfmt/src/adapter.ts`,
  `packages/oxlint/src/adapter.ts`, `packages/eslint/src/adapter.ts`,
  `packages/prettier/src/adapter.ts`, `packages/phpstan/src/adapter.ts`,
  `packages/vitest/src/adapter.ts`, `packages/pest/src/adapter.ts`,
  `packages/phpunit/src/adapter.ts`, `packages/bun-test/src/adapter.ts`,
  `packages/storybook/src/adapter.ts`.
- `packages/core/src/cli/envelope` — no: the envelope is
  `packages/cli/src/envelope.ts` (`formatEnvelope`).

### Terms used in this plan

- **Tree state** — the set of file paths and, per path, `mtimeNs:size`.
- **Run record** — a JSON file describing a completed run: the tree state it
  observed, the request it answered, and its result.
- **Coalescing** — two callers sharing one run because their tree states match.
- **Listener / waiter** — a caller that is waiting for a run it did not start.

---

## Scope

**In scope (exact paths):**

*Phase 0*
- `packages/cli/src/main.ts` (phase 0 only: `resolveStorage` and the banner)
- `packages/cli/tests/bun-cache.test.ts` (create)

*Phases 1–2*
- `packages/core/src/engine/file-set.ts` (extend)
- `packages/core/src/engine/run-lock.ts` (create)
- `packages/core/src/index.ts` (export the new surface)
- `packages/core/tests/engine/file-set.test.ts` (extend)
- `packages/core/tests/engine/run-lock.test.ts` (create)

*Phase 3*
- `packages/cli/src/main.ts`
- `packages/cli/src/envelope.ts`
- `packages/cli/tests/coordination.test.ts` (create)
- `packages/cli/tests/envelope.test.ts` (extend)
- `.gitignore` (add the coordination temp dir if tests need one)

*Phase 4*
- `packages/oxfmt/src/adapter.ts`, `packages/oxlint/src/adapter.ts`,
  `packages/eslint/src/adapter.ts`, `packages/prettier/src/adapter.ts`,
  `packages/phpstan/src/adapter.ts`
- `packages/oxfmt/tests/adapter.test.ts` and the matching test file for each
  adapter changed above
- `gesetz.config.ts` (only if a rule's `pattern` needs to stay as it is — see
  Task 4.1 step 5)

**Out of scope:**

- `packages/vitest`, `packages/pest`, `packages/phpunit`, `packages/bun-test`,
  `packages/storybook` — test runners and browser tools. Their result is not
  per-file additive, so they are **not** file-scoped in Phase 4. See *Open
  questions*.
- The daemon (see *Not in scope*, below).
- `netzwerk` and any other dependency. If the scan floor needs work, that is a
  separate plan.
- `packages/core/src/engine/runner.ts` — `runAll` keeps its current signature and
  behaviour in every phase of this plan.

**Forbidden actions (do not do these under any circumstances):**

- Do NOT change the meaning of an existing CLI flag, or change the JSON
  envelope's `v` version. The envelope gains one additive key only.
- Do NOT write notices to stdout. Stdout is parsed by agents; notices go to stderr.
- Do NOT make waiting the behaviour of any command other than `check`. `baseline`,
  `init`, `list`, and `skill` are untouched.
- Do NOT add a dependency, including `proper-lockfile` and `flock` wrappers.
- Do NOT make `--standalone` the default, and do NOT remove the standalone path.
- Do NOT touch `packages/vitest/**`, `packages/pest/**`, `packages/phpunit/**`,
  `packages/bun-test/**`, `packages/storybook/**`.
- Do NOT reformat the repo or run `git` write commands. The user handles commits.

---

## Acceptance criteria

A human can verify each of these with the command shown.

**Phase 0**

```bash
# First run under Bun: cold, and the cache-off banner is gone.
bun packages/cli/dist/main.js check 2>&1 | grep -E "cache:|scan:"
# Expected: a line naming the cache path (e.g. `cache: .gesetz/cache.db — 305 files cached`)
# Expected: `scan: 306 files — +306 ~0 -0 =0 reused (...)`
# Expected: NO line containing `(bun) violation cache disabled`

# Second run: everything reused, no banner, and fast.
bun packages/cli/dist/main.js check 2>&1 | grep -E "scan:"
# Expected: `scan: 306 files — +0 ~0 -0 =306 reused (...)`
```

**Phases 1–2** — the protocol, as unit tests:

```bash
pnpm --filter @gesetz/core test -- run-lock
# Expected: all green, ≥ 14 tests
```

**Phase 3** — two real processes, one shared tree:

```bash
# In a temp project with a rule that sleeps 1500ms, spawned twice concurrently.
pnpm --filter @gesetz/cli test -- coordination
# Expected: PASS. Asserts that exactly one process reported `mode: "ran"`,
# the other reported `mode: "reused"`, and no `reused` result is older than its
# own edits.
```

**Phase 4** — the tools receive changed files, not the whole tree:

```bash
pnpm --filter @gesetz/oxfmt test
# Expected: PASS, including the test that a scan reprocessing one file passes
# exactly that one path to `oxfmt --list-different`.
```

**All phases**

```bash
pnpm typecheck && pnpm test && pnpm dogfood
# Expected: exit 0 for each; dogfood reports 0 violations and every category 10.
```

---

## Architecture

### Where the files live

```
<project-root>/.gesetz/            (gitignored)
  cache.db                         existing marker cache (unchanged)
  coord/
    lock                           slot 0 — held by the running process
    lock.1 … lock.<jobs-1>         additional slots, only when jobs > 1
    wait.<pid>                     one per waiting process, heartbeated
    run.<requestKey>.<hash>.json   a completed run: tree state + result
```

Everything is a small JSON file. There is no socket, no server, and no process
to start: the protocol is `fs` operations, so a crashed participant leaves at
most a stale file that the next one ignores.

### Lock protocol

- A slot is acquired with `writeFileSync(path, json, { flag: 'wx' })` — this is
  `O_CREAT|O_EXCL`, so exactly one process wins.
- The slot file holds `{ pid, startedAt, heartbeatAt }`. The holder rewrites
  `heartbeatAt` every `HEARTBEAT_MS` (2000 ms) via temp-file + `renameSync`
  (atomic replace).
- Before each heartbeat the holder re-reads the slot: **if the `pid` is no longer
  its own, it has been stolen.** The holder stops heartbeating, sets
  `stolen = true`, and **does not publish a run record** when it finishes.
- A slot whose `heartbeatAt` is older than `STALE_MS` (15000 ms) *and* whose
  `pid` is not alive (`process.kill(pid, 0)` → `ESRCH`; `EPERM` counts as alive)
  is stale. A waiter takes it over by `renameSync`-ing it to
  `lock.stale.<pid>.<now>` and creating a fresh one. The rename is the race
  breaker: only one process can rename a given path successfully.
- Release = `unlinkSync(slot)`.

### Reuse contract

A completed record is reusable by a caller iff **all four** hold:

1. `record.requestKey === myRequestKey` — the same question was asked.
2. `record.treeState.pathsFingerprint === treeStateFor(root).pathsFingerprint` —
   the same set of files (catches additions and deletions).
3. `record.treeState.statMap` equals the caller's stat map for those paths —
   nothing has been written to any of those files since the run observed them.
4. `record.dirty === false` — the tree did not change *during* the run either.
   The runner takes a stat map before the scan and after it; if they differ, the
   result is a mixture of two states and is marked dirty, so nobody reuses it.
   (The runner still returns it to its own caller, which is what a solo run
   would have produced.)

Condition 3 compares `mtimeNs:size` strings. **Documented ceiling:** a rewrite
that produces byte-identical metadata (same size, same mtime to the nanosecond)
is not detected. This requires a writer that restores mtimes, or a write inside
the same nanosecond as the recorded one. It is a `ponytail:` note in the source,
not silent behaviour, and `--standalone` / `--full` are the escape hatches.

Reuse is deliberately keyed on tree state, never on elapsed time.

### Data flow

```
caller
  │
  ├─ treeState = treeStateFor(root)                    (one walk + one stat per file)
  │
  ├─ reuse? record with matching requestKey + treeState, dirty=false
  │     yes ─────────────────────────────────────────► render record.result, print
  │                                                     "reused <age> — <n> files re-checked"
  │     no
  │
  ├─ try to acquire a slot (up to `jobs` slots)
  │     free ──► re-check for a record (a run may have finished while waiting)
  │              │  none
  │              ├─ statBefore = treeStateFor(root)
  │              ├─ result = run()
  │              ├─ statAfter  = treeStateFor(root)
  │              ├─ dirty = statBefore !== statAfter
  │              ├─ write run record (unless stolen)
  │              └─ release slot ─────────────────────► render result
  │
  │     all slots held
  │              ├─ register wait.<pid> (heartbeated) so the holder can count us
  │              ├─ if a slot is stale: take it over (rename), go to "free"
  │              ├─ poll every POLL_MS: is there a reusable record now?
  │              ├─ stop waiting at `waitTimeoutMs`, then run standalone
  │              └─────────────────────────────────────► render reused record,
  │                                                        or own result after waiting
```

### Request key

`requestKey` is a sha256 over the fields that change a result. Built in the CLI
from exactly what it hands to `runAll`:

```
[ 'gesetz-coordination-v1',
  projectRoot,
  configPath,
  rules.map(r => r.id).sort(),      // after the --category filter
  thresholds sorted,
  fileFilter (--files globs) sorted,
  changedSince (--since) or null,
  baseline digest (sha256 of the baseline file's bytes) or null,
  storage kind ('memory' for --full, else 'sqlite') ]
```

Two agents running plain `check` produce the same key and share a run. An agent
with `--files` or `--since` gets its own run — correct, because those flags change
the answer. (Because `--files` and `--since` are aggregation-time filters, they
could in future be derived from a shared run instead of forcing one; that is a
follow-up, not this plan.)

### Escape hatches

- `--standalone` — run now: no lock, no waiting, no reuse of anyone's result.
- `GESETZ_LOCK=off` — the same, for an agent that cannot pass flags.
- `--jobs N` / `GESETZ_JOBS=N` — how many runs may proceed at once. Default 1.
- `--wait-timeout S` — how long to wait for a run in flight before running anyway.
  Default 600.
- `--full` **implies `--standalone`**. `--full` means "bypass the cache and
  re-check everything", and it must keep meaning exactly that: a caller that
  wants no caching also wants no sharing. This is one line in the CLI, and it is
  what keeps the old behaviour available without a new flag.

### Notices (stderr) and envelope (stdout)

Notice lines, printed to stderr, one line, prefixed like the existing `scan:`
line:

| situation | line |
|---|---|
| ran with no contention | `coord: ran — no other gesetz check active` |
| reused a record | `coord: reused a run from 2.1s ago — this tree state was already checked` |
| waited, then reused | `coord: waited 3.4s, then reused a run that covered this tree state` |
| waited, then ran | `coord: waited 8.4s for pid 1234, then ran — 1 file needed re-checking` |
| took over a dead runner | `coord: took over slot 0 from pid 1234 (no heartbeat for 16.1s)` |
| other processes waited on this run | `coord: 2 other processes waited on this run` |
| the run re-checked files | `coord: this run re-checked 4 changed files — this worktree is shared, so some violations may not be yours` |
| standalone | `coord: standalone (--standalone) — not waiting, not reusing` |

The last two are the ones that stop an agent being confused: they say *whose
work* a result may describe without pretending to know which files an individual
agent touched (the tool cannot know that).

Envelope: one additive key on the existing object built in
`packages/cli/src/envelope.ts`:

```json
"coordination": {
  "mode": "ran" | "reused" | "ran-after-wait" | "standalone",
  "waitedMs": 3400,
  "runAgeMs": 2100,
  "listeners": 2,
  "recheckedFiles": 4,
  "pid": 57132
}
```

`v` stays `1`. Consumers that ignore unknown keys keep working; an agent that
reads `coordination.mode === "reused"` learns its result was not computed from
its own run.

---

## Phases & tasks

### Phase 0: Make the violation cache work under Bun

This comes first because every other phase is measured against a cache that
works. Today ~100% of agent runs under Bun are cold runs.

#### Task 0.1: Drop the `isBun` guard in `resolveStorage`

**Why:** the guard is based on a claim that is no longer true, and it silently
turns every agent run into a full cold run.

**Files:**
- Modify: `packages/cli/src/main.ts` (function `resolveStorage`, ~line 40)

**Steps:**

- [ ] **Step 1:** Replace the storage resolution and its comment.
      ```ts
      /**
       * Default cache location; GESETZ_DB overrides. `--full` bypasses the cache.
       *
       * The cache used to be disabled under Bun on the grounds that
       * better-sqlite3 is unsupported there. netzwerk does not use
       * better-sqlite3 — it uses @libsql/client, which works under Bun (verified:
       * cold 11.58s → warm 4.01s on this repo). Disabling it made every agent
       * run a full cold run, which is what put ten concurrent checks on the
       * floor.
       */
      const resolveStorage = (
        root: string,
        full: boolean,
      ): import('@gesetz/core').GesetzStorageConfig => {
        if (full) return { kind: 'memory' };
        const dbPath = process.env.GESETZ_DB ?? nodePath.join(root, '.gesetz', 'cache.db');
        nodeFs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
        return { kind: 'sqlite', path: dbPath };
      };
      ```
- [ ] **Step 2:** Delete the `isBun` banner branch in the `check` handler
      (~line 196) — the whole `else if (isBun) { ... }` clause, keeping the
      `--full` clause.
- [ ] **Step 3:** Delete the now-unused `isBun` constant (~line 34) if nothing
      else references it.
      ```bash
      grep -n "isBun" packages/cli/src/main.ts
      # Expected: no output
      ```
- [ ] **Step 4:** Rebuild and confirm the behaviour by hand.
      ```bash
      pnpm --filter @gesetz/core build && pnpm --filter @gesetz/cli build
      bun packages/cli/dist/main.js check 2>&1 | grep -E "cache:|scan:"
      bun packages/cli/dist/main.js check 2>&1 | grep -E "scan:"
      ```
      Expected: the first prints `+306 ~0 -0 =0 reused`, the second prints
      `+0 ~0 -0 =306 reused` and takes well under half the time. Neither prints
      `(bun) violation cache disabled`.

#### Task 0.2: Say which cache is in use, on every run

**Why:** this defect was invisible for as long as it existed because a
cache-less run prints nothing unusual. A silent cache-off is indistinguishable
from a fast machine, and the same class of silence has already produced two
"gate that never ran" bugs in this repo.

**Files:**
- Modify: `packages/cli/src/main.ts` (the `check` handler, next to the `scan:` line)

**Steps:**

- [ ] **Step 1:** Add a `describeStorage` helper above `checkCommand`.
      ```ts
      /**
       * One line naming the cache in use. `--full` and `GESETZ_DB` are the only
       * ways to end up without one, and both should be visible in the output.
       */
      const describeStorage = (
        storage: import('@gesetz/core').GesetzStorageConfig,
      ): string =>
        storage.kind === 'sqlite'
          ? `cache: ${storage.path}`
          : 'cache: off (--full or memory storage) — every file will be re-checked';
      ```
- [ ] **Step 2:** Print it to stderr immediately after the storage is resolved,
      before the `runAndRender` call.
      ```ts
      yield* Console.error(describeStorage(storage));
      ```
      This requires hoisting the `resolveStorage(root, opts.full)` call out of
      the `runAll` argument and into a `const storage = ...` above, which is then
      reused in the `runAll` call. Do not change any other argument.
- [ ] **Step 3:** Verify.
      ```bash
      node packages/cli/dist/main.js check 2>&1 | grep -E "cache:"
      node packages/cli/dist/main.js check --full 2>&1 | grep -E "cache:"
      ```
      Expected: the first names `.gesetz/cache.db`; the second says
      `cache: off (--full …)`.

#### Task 0.3: A test that fails if the Bun cache is disabled again

**Why:** the guard was added for a real reason at the time. A test that runs the
built CLI under Bun and asserts marker reuse is the guard against a future
"fix" that re-disables it silently.

**Files:**
- Create: `packages/cli/tests/bun-cache.test.ts`

**Steps:**

- [ ] **Step 1:** Write the test. It runs the built CLI twice under Bun in a temp
      project and asserts reuse. It must be skipped with a warning when `bun` or
      the built CLI is missing, following `tests/bundle-mojibake.test.ts`.
      ```ts
      import { describe, it, expect } from 'vitest';
      import { execFileSync } from 'node:child_process';
      import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import * as nodePath from 'node:path';
      import * as nodeFs from 'node:fs';

      const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
      const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');
      const BUN_BIN = nodeFs.existsSync('/Users/mat/.bun/bin/bun')
        ? '/Users/mat/.bun/bin/bun'
        : 'bun';

      const runUnderBun = (cwd: string): string =>
        execFileSync(BUN_BIN, [DIST_MAIN, 'check'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        });

      describe('violation cache under Bun', () => {
        it('reuses markers on a second run instead of re-checking everything', async () => {
          if (!nodeFs.existsSync(DIST_MAIN)) {
            console.warn(`skipping: ${DIST_MAIN} not built`);
            return;
          }
          const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-bun-cache-'));
          try {
            await mkdir(nodePath.join(dir, 'src'), { recursive: true });
            await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
            // Absolute import: a temp directory is outside the repo, so a bare
            // '@gesetz/core' specifier would not resolve.
            await writeFile(
              nodePath.join(dir, 'gesetz.config.ts'),
              [
                `import { defineConfig, select } from '${REPO_ROOT}/packages/core/dist/index.js';`,
                "import { requireTest } from '" + REPO_ROOT + "/packages/typescript/dist/index.js';",
                'export default defineConfig({',
                '  projectRoot: ' + JSON.stringify(dir) + ',',
                "  rules: [select('src/**/*.ts').exclude('src/**/*.test.ts')",
                "    .label('Source files need tests').category('testing')",
                '    .check(requireTest({ severity: "info" }))],',
                '});',
                '',
              ].join('\n'),
            );

            runUnderBun(dir); // cold: writes .gesetz/cache.db
            const warm = runUnderBun(dir); // warm: must reuse
            expect(warm).toContain('=1 reused');
            expect(warm).not.toContain('(bun) violation cache disabled');
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }, 180_000);
      });
      ```
- [ ] **Step 2:** Confirm the test passes on the fixed code.
      ```bash
      pnpm --filter @gesetz/cli test -- bun-cache
      ```
      Expected: PASS (1 test).
- [ ] **Step 3:** Confirm the test **fails** if the guard is restored — this is
      what makes it a regression test. Temporarily change `if (full) return` back
      to `if (full || true) return { kind: 'memory' }`, rebuild the CLI, run the
      test, then revert the change exactly.
      ```bash
      pnpm --filter @gesetz/cli build && pnpm --filter @gesetz/cli test -- bun-cache
      ```
      Expected: FAIL — the warm run does not contain `=1 reused`.
- [ ] **Step 4:** Revert, rebuild, re-run. Expected: PASS.

---

### Phase 1: Tree state, in `packages/core/src/engine/file-set.ts`

The reuse contract needs a cheap, sound description of the tree. This phase adds
it beside the existing walk, reusing that walk so that "the same set of files"
means the same thing everywhere.

#### Task 1.1: `treeStateFor`

**Why:** a record and a caller must be able to agree on "the same tree" without
reading file contents.

**Files:**
- Modify: `packages/core/src/engine/file-set.ts`
- Test: `packages/core/tests/engine/file-set.test.ts` (extend)

**Steps:**

- [ ] **Step 1:** Add the failing test to `packages/core/tests/engine/file-set.test.ts`.
      ```ts
      describe('treeStateFor', () => {
        it('records one entry per file, keyed by repo-relative path', async () => {
          await put('src/a.ts');
          await put('src/b.ts', 'longer content');
          const state = treeStateFor(dir);
          expect(Object.keys(state.statMap).sort()).toEqual(['src/a.ts', 'src/b.ts']);
        });

        it('changes the fingerprint when a file is added, and the stat map too', async () => {
          await put('src/a.ts');
          const before = treeStateFor(dir);
          await put('src/b.ts');
          const after = treeStateFor(dir);
          expect(after.pathsFingerprint).not.toBe(before.pathsFingerprint);
          expect(after.statMap).not.toEqual(before.statMap);
        });

        it('changes the stat map when a file is rewritten, keeping the same paths', async () => {
          await put('src/a.ts', 'one');
          const before = treeStateFor(dir);
          await put('src/a.ts', 'a different length');
          const after = treeStateFor(dir);
          expect(after.pathsFingerprint).toBe(before.pathsFingerprint);
          expect(after.statMap).not.toEqual(before.statMap);
        });

        it('is stable for an unchanged tree', async () => {
          await put('src/a.ts');
          expect(treeStateFor(dir)).toEqual(treeStateFor(dir));
        });

        it('ignores the same directories the file set ignores', async () => {
          await put('src/a.ts');
          const before = treeStateFor(dir);
          await put('node_modules/pkg/index.js');
          await put('dist/out.js');
          expect(treeStateFor(dir)).toEqual(before);
        });

        it('keeps fileSetFingerprint equal to the path fingerprint', async () => {
          await put('src/a.ts');
          expect(fileSetFingerprint(dir)).toBe(treeStateFor(dir).pathsFingerprint);
        });
      });
      ```
      Add `treeStateFor` to the existing import from `../../src/engine/file-set`.
- [ ] **Step 2:** Run it and confirm it fails.
      ```bash
      pnpm --filter @gesetz/core test -- file-set
      ```
      Expected: FAIL — `treeStateFor is not a function`.
- [ ] **Step 3:** Implement in `packages/core/src/engine/file-set.ts`. Refactor the
      walk so both functions share it, and keep `fileSetFingerprint`'s value
      byte-identical to today's (it hashes `paths.join('\n')`), so no existing
      cache is invalidated.
      ```ts
      /**
       * The set of files a project has, and each one's `mtimeNs:size`.
       *
       * Reuse of another process's run is keyed on this: two callers with equal
       * tree state are asking a question whose answer is already known. Sizes and
       * mtimes are one `stat` per file, where reading content is the cost this
       * exists to avoid.
       *
       * ponytail: metadata equality is not proof of content equality. A writer
       * that restores mtimes exactly, or writes inside the same nanosecond, is
       * not detected. `--standalone` and `--full` skip reuse entirely.
       */
      export interface TreeState {
        /** sha256 over the sorted relative paths. */
        readonly pathsFingerprint: string;
        /** Relative path → `${mtimeNs}:${size}`. */
        readonly statMap: Readonly<Record<string, string>>;
      }

      /** Sorted repo-relative paths of every file, skipping `NEVER_SOURCE`. */
      function walkPaths(rootDir: string): string[] {
        const paths: string[] = [];
        const walk = (dir: string): void => {
          let entries: nodeFs.Dirent[];
          try {
            entries = nodeFs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return; // unreadable directory: not part of the file set
          }
          for (const entry of entries) {
            if (NEVER_SOURCE.has(entry.name)) continue;
            const absolutePath = nodePath.join(dir, entry.name);
            if (entry.isDirectory()) walk(absolutePath);
            else if (entry.isFile()) paths.push(nodePath.relative(rootDir, absolutePath));
          }
        };
        walk(rootDir);
        paths.sort();
        return paths;
      }

      export function fileSetFingerprint(rootDir: string): string {
        return createHash('sha256').update(walkPaths(rootDir).join('\n')).digest('hex');
      }

      export function treeStateFor(rootDir: string): TreeState {
        const paths = walkPaths(rootDir);
        const statMap: Record<string, string> = {};
        for (const relativePath of paths) {
          try {
            const stats = nodeFs.statSync(nodePath.join(rootDir, relativePath), { bigint: true });
            statMap[relativePath] = `${stats.mtimeNs}:${stats.size}`;
          } catch {
            // Vanished between the walk and the stat: leave it out, so the next
            // comparison sees a different path set and refuses the reuse.
          }
        }
        return {
          pathsFingerprint: createHash('sha256').update(paths.join('\n')).digest('hex'),
          statMap,
        };
      }

      /** True when two tree states describe the same files with the same metadata. */
      export function treeStatesMatch(a: TreeState, b: TreeState): boolean {
        if (a.pathsFingerprint !== b.pathsFingerprint) return false;
        const aKeys = Object.keys(a.statMap);
        if (aKeys.length !== Object.keys(b.statMap).length) return false;
        for (const key of aKeys) {
          if (a.statMap[key] !== b.statMap[key]) return false;
        }
        return true;
      }
      ```
      Delete the old `NEVER_SOURCE`-consuming body of `fileSetFingerprint` and its
      doc comment, keeping `NEVER_SOURCE` and its comment.
- [ ] **Step 4:** Run and confirm it passes.
      ```bash
      pnpm --filter @gesetz/core test -- file-set
      ```
      Expected: PASS, and the pre-existing `file-set.test.ts` cases still pass.
- [ ] **Step 5:** Confirm nothing else regressed, because `fileSetFingerprint` is
      mixed into every rule's cache key.
      ```bash
      pnpm --filter @gesetz/core test
      ```
      Expected: all green.

---

### Phase 2: The coordination primitive

`coordinateRun` is the whole feature: reuse when a matching record exists, else
run, else wait. It is plain `async` — no Effect — so it can be unit-tested with a
temp directory and a fake `run`.

#### Task 2.1: Records and slots

**Why:** the protocol is filesystem state; getting it right and tested before the
control flow makes the control flow small.

**Files:**
- Create: `packages/core/src/engine/run-lock.ts`
- Test: `packages/core/tests/engine/run-lock.test.ts` (create)

**Steps:**

- [ ] **Step 1:** Write the failing tests for the filesystem layer.
      ```ts
      import { describe, it, expect, beforeEach, afterEach } from 'vitest';
      import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import * as nodeFs from 'node:fs';
      import * as nodePath from 'node:path';
      import {
        acquireSlot,
        coordDirFor,
        findReusableRecord,
        readSlot,
        releaseSlot,
        writeRecord,
      } from '../../src/engine/run-lock';
      import { treeStateFor } from '../../src/engine/file-set';

      let root: string;
      beforeEach(async () => {
        root = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-'));
      });
      afterEach(async () => {
        await rm(root, { recursive: true, force: true });
      });

      const record = (overrides = {}) => ({
        version: 1 as const,
        requestKey: 'k1',
        treeState: treeStateFor(root),
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
        pid: 999_999,
        dirty: false,
        listeners: 0,
        recheckedFiles: 0,
        result: { hello: 'world' },
        ...overrides,
      });

      describe('slots', () => {
        it('creates the coordination directory on first acquire', () => {
          const slot = acquireSlot(root, 0);
          expect(slot).not.toBeNull();
          expect(readSlot(slot!.path)?.pid).toBe(process.pid);
        });

        it('refuses a second acquire of the same slot', () => {
          expect(acquireSlot(root, 0)).not.toBeNull();
          expect(acquireSlot(root, 0)).toBeNull();
        });

        it('allows a second slot when jobs is 2', () => {
          expect(acquireSlot(root, 0)).not.toBeNull();
          expect(acquireSlot(root, 1)).not.toBeNull();
          expect(acquireSlot(root, 2)).toBeNull();
        });

        it('frees the slot on release', () => {
          const slot = acquireSlot(root, 0)!;
          releaseSlot(slot);
          expect(acquireSlot(root, 0)).not.toBeNull();
        });

        it('reports a slot whose heartbeat is old and whose pid is dead as stale', () => {
          const slot = acquireSlot(root, 0)!;
          expect(slot.isStale(Date.now() + 60_000)).toBe(true);
        });

        it('does not report a live process as stale', () => {
          const slot = acquireSlot(root, 0)!;
          expect(slot.isStale(Date.now())).toBe(false);
        });
      });

      describe('records', () => {
        it('round-trips a record', () => {
          writeRecord(root, record());
          const found = findReusableRecord(root, 'k1', treeStateFor(root));
          expect(found?.result).toEqual({ hello: 'world' });
        });

        it('does not return a record for a different request key', () => {
          writeRecord(root, record());
          expect(findReusableRecord(root, 'k2', treeStateFor(root))).toBeNull();
        });

        it('does not return a dirty record', () => {
          writeRecord(root, record({ dirty: true }));
          expect(findReusableRecord(root, 'k1', treeStateFor(root))).toBeNull();
        });

        it('does not return a record for a different tree state', async () => {
          writeRecord(root, record());
          await writeFile(nodePath.join(root, 'new-file.ts'), 'x');
          expect(findReusableRecord(root, 'k1', treeStateFor(root))).toBeNull();
        });

        it('prefers the newest matching record', () => {
          writeRecord(root, record({ finishedAt: 1, result: { which: 'old' } }));
          writeRecord(root, record({ finishedAt: 2, result: { which: 'new' } }));
          expect(findReusableRecord(root, 'k1', treeStateFor(root))?.result).toEqual({
            which: 'new',
          });
        });

        it('ignores a corrupt record rather than throwing', async () => {
          await mkdir(coordDirFor(root), { recursive: true });
          await writeFile(nodePath.join(coordDirFor(root), 'run.k1.deadbeef.json'), '{ not json');
          expect(findReusableRecord(root, 'k1', treeStateFor(root))).toBeNull();
        });
      });
      ```
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: FAIL — cannot resolve `../../src/engine/run-lock`.
- [ ] **Step 3:** Implement the filesystem layer of
      `packages/core/src/engine/run-lock.ts`.
      ```ts
      /**
       * Coordination for several `gesetz check` processes in one working tree.
       *
       * Ten agents editing one worktree and each running the full check is ten
       * scans and ten runs of every external tool for the same tree. This module
       * lets a caller wait for the run in flight and then *reuse its result* when
       * that result describes the same tree state — keyed on observed state, never
       * on recency, because a result computed before a caller's edit is a wrong
       * answer for that caller.
       *
       * Everything is a file under `<root>/.gesetz/coord/`. There is no server and
       * no socket, so a crashed participant leaves a stale file that the next one
       * ignores or takes over.
       */
      import * as nodeFs from 'node:fs';
      import * as nodePath from 'node:path';
      import { createHash } from 'node:crypto';
      import { treeStatesMatch, type TreeState } from './file-set';

      const COORD_DIR = 'coord';
      const SLOT_PREFIX = 'lock';
      const WAITER_PREFIX = 'wait';
      const RECORD_PREFIX = 'run';
      const RECORD_PREFIX_SEP = '.';
      const JSON_SUFFIX = '.json';

      /** How often a holder rewrites its heartbeat. */
      export const HEARTBEAT_MS = 2_000;
      /** How long a waiter sleeps between checks. */
      export const POLL_MS = 150;
      /** A slot with no heartbeat for this long, held by a dead pid, is stale. */
      export const DEFAULT_STALE_MS = 15_000;
      /** How long a caller waits for a run before giving up and running itself. */
      export const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
      /** Records younger than this are kept even when pruning. */
      export const RECORD_TTL_MS = 60_000;

      export interface SlotFile {
        readonly pid: number;
        readonly startedAt: number;
        readonly heartbeatAt: number;
      }

      export interface RunRecord<R = unknown> {
        readonly version: 1;
        readonly requestKey: string;
        readonly treeState: TreeState;
        readonly startedAt: number;
        readonly finishedAt: number;
        readonly pid: number;
        /** True when the tree changed while the run was in progress. */
        readonly dirty: boolean;
        readonly listeners: number;
        readonly recheckedFiles: number;
        readonly result: R;
      }

      export function coordDirFor(root: string): string {
        return nodePath.join(root, '.gesetz', COORD_DIR);
      }

      function ensureCoordDir(root: string): string {
        const dir = coordDirFor(root);
        nodeFs.mkdirSync(dir, { recursive: true });
        return dir;
      }

      function slotPathFor(root: string, slot: number): string {
        return nodePath.join(
          coordDirFor(root),
          slot === 0 ? SLOT_PREFIX : `${SLOT_PREFIX}.${slot}`,
        );
      }

      export function readSlot(path: string): SlotFile | null {
        try {
          return JSON.parse(nodeFs.readFileSync(path, 'utf8')) as SlotFile;
        } catch {
          return null;
        }
      }

      function writeJsonAtomic(path: string, value: unknown): void {
        const temporary = `${path}.tmp.${process.pid}`;
        nodeFs.writeFileSync(temporary, JSON.stringify(value));
        nodeFs.renameSync(temporary, path);
      }

      /** `EPERM` means the process exists but belongs to another user: alive. */
      function isAlive(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch (cause) {
          return (cause as NodeJS.ErrnoException).code === 'EPERM';
        }
      }

      export interface Slot {
        readonly index: number;
        readonly path: string;
        readonly startedAt: number;
        /** Re-write the heartbeat; returns false when the slot was stolen. */
        beat(): boolean;
        /** True when the holder looks dead (old heartbeat + not alive). */
        isStale(now: number, staleMs?: number): boolean;
        release(): void;
      }

      export function acquireSlot(root: string, index: number): Slot | null {
        ensureCoordDir(root);
        const path = slotPathFor(root, index);
        const startedAt = Date.now();
        const file: SlotFile = { pid: process.pid, startedAt, heartbeatAt: startedAt };
        try {
          nodeFs.writeFileSync(path, JSON.stringify(file), { flag: 'wx' });
        } catch {
          return null; // someone holds it
        }

        let stolen = false;
        let timer: NodeJS.Timeout | undefined;
        const beat = (): boolean => {
          if (stolen) return false;
          const current = readSlot(path);
          if (current === null || current.pid !== process.pid || current.startedAt !== startedAt) {
            // Someone renamed us aside and took over. Stop claiming the slot so the
            // new holder's heartbeat is not overwritten by ours.
            stolen = true;
            if (timer !== undefined) clearInterval(timer);
            return false;
          }
          writeJsonAtomic(path, { ...current, heartbeatAt: Date.now() });
          return true;
        };
        timer = setInterval(beat, HEARTBEAT_MS);
        timer.unref();

        return {
          index,
          path,
          startedAt,
          beat,
          isStale: (now: number, staleMs: number = DEFAULT_STALE_MS): boolean => {
            if (stolen) return false;
            const current = readSlot(path);
            if (current === null) return false;
            if (now - current.heartbeatAt <= staleMs) return false;
            return !isAlive(current.pid);
          },
          release: (): void => {
            if (timer !== undefined) clearInterval(timer);
            const current = readSlot(path);
            if (current !== null && current.pid === process.pid) {
              try {
                nodeFs.unlinkSync(path);
              } catch {
                // already gone
              }
            }
          },
        };
      }

      export function releaseSlot(slot: Slot): void {
        slot.release();
      }

      /**
       * Move a stale slot aside so a fresh one can be created.
       *
       * The rename is the race breaker: only one process can rename a given path,
       * so two waiters that both decide a slot is stale cannot both take it over.
       */
      export function takeOverSlot(root: string, index: number, now: number): boolean {
        const path = slotPathFor(root, index);
        const stalePath = `${path}.stale.${process.pid}.${now}`;
        try {
          nodeFs.renameSync(path, stalePath);
        } catch {
          return false; // another waiter got there first
        }
        try {
          nodeFs.unlinkSync(stalePath);
        } catch {
          // best effort
        }
        return true;
      }

      function recordPathFor(root: string, requestKey: string): string {
        return nodePath.join(
          coordDirFor(root),
          `${RECORD_PREFIX}${RECORD_PREFIX_SEP}${requestKey}${RECORD_PREFIX_SEP}${createHash(
            'sha256',
          )
            .update(String(process.hrtime.bigint()))
            .digest('hex')
            .slice(0, 8)}${JSON_SUFFIX}`,
        );
      }

      export function writeRecord<R>(root: string, record: RunRecord<R>): void {
        ensureCoordDir(root);
        writeJsonAtomic(recordPathFor(root, record.requestKey), record);
        pruneRecords(root);
      }

      export function readRecords(root: string): RunRecord[] {
        const dir = coordDirFor(root);
        let names: string[];
        try {
          names = nodeFs.readdirSync(dir);
        } catch {
          return [];
        }
        const records: RunRecord[] = [];
        for (const name of names) {
          if (!name.startsWith(`${RECORD_PREFIX}${RECORD_PREFIX_SEP}`)) continue;
          if (!name.endsWith(JSON_SUFFIX)) continue;
          try {
            records.push(
              JSON.parse(nodeFs.readFileSync(nodePath.join(dir, name), 'utf8')) as RunRecord,
            );
          } catch {
            // A half-written or corrupt record is not evidence of a run.
          }
        }
        return records;
      }

      /** Keeps the newest few records, and any record a waiter may still find. */
      function pruneRecords(root: string): void {
        const now = Date.now();
        const records = readRecords(root).sort((a, b) => b.finishedAt - a.finishedAt);
        const keep = new Set<string>();
        for (const [index, record] of records.entries()) {
          const young = now - record.finishedAt < RECORD_TTL_MS;
          if (index < 8 || young) keep.add(String(record.finishedAt) + record.requestKey);
        }
        const dir = coordDirFor(root);
        for (const name of nodeFs.readdirSync(dir)) {
          if (!name.startsWith(`${RECORD_PREFIX}${RECORD_PREFIX_SEP}`)) continue;
          if (!name.endsWith(JSON_SUFFIX)) continue;
          let finishedAt: number;
          let requestKey: string;
          try {
            const parsed = JSON.parse(
              nodeFs.readFileSync(nodePath.join(dir, name), 'utf8'),
            ) as RunRecord;
            finishedAt = parsed.finishedAt;
            requestKey = parsed.requestKey;
          } catch {
            continue; // not self-consistent; leave it for readRecords to ignore
          }
          if (!keep.has(String(finishedAt) + requestKey)) {
            try {
              nodeFs.unlinkSync(nodePath.join(dir, name));
            } catch {
              // best effort
            }
          }
        }
      }

      /**
       * The newest completed record that answers this request for this exact tree
       * state. A dirty record is never reusable: the tree changed while it ran, so
       * it describes a mixture of two states.
       */
      export function findReusableRecord<R>(
        root: string,
        requestKey: string,
        treeState: TreeState,
      ): RunRecord<R> | null {
        const candidates = readRecords(root)
          .filter(
            (record) =>
              record.requestKey === requestKey &&
              record.dirty === false &&
              treeStatesMatch(record.treeState, treeState),
          )
          .sort((a, b) => b.finishedAt - a.finishedAt);
        return (candidates[0] as RunRecord<R> | undefined) ?? null;
      }
      ```
- [ ] **Step 4:** Run and confirm they pass.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: PASS (11 tests).

#### Task 2.2: Waiters

**Why:** the holder can only tell other processes "your changes were included"
if it can count them; and a waiter needs a heartbeat of its own so that a
crashed waiter does not accumulate forever.

**Files:**
- Modify: `packages/core/src/engine/run-lock.ts`
- Test: `packages/core/tests/engine/run-lock.test.ts` (extend)

**Steps:**

- [ ] **Step 1:** Add the failing tests. Extend the existing import from
      `../../src/engine/run-lock` with `countWaiters` and `registerWaiter` — they
      were deliberately left out of Task 2.1's import list so that task's tests
      would run against a module that does not have them yet.
      ```ts
      describe('waiters', () => {
        it('counts a registered waiter', () => {
          const waiter = registerWaiter(root);
          expect(countWaiters(root)).toBe(1);
          waiter.unregister();
          expect(countWaiters(root)).toBe(0);
        });

        it('does not count a waiter whose pid is dead', () => {
          registerWaiter(root, { pid: 999_999, heartbeatAt: 1 });
          expect(countWaiters(root)).toBe(0);
        });

        it('does not count a waiter with a corrupt file', async () => {
          await mkdir(coordDirFor(root), { recursive: true });
          await writeFile(nodePath.join(coordDirFor(root), 'wait.12345.json'), 'nope');
          expect(countWaiters(root)).toBe(0);
        });
      });
      ```
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: FAIL — `registerWaiter is not a function`.
- [ ] **Step 3:** Implement.
      ```ts
      export interface Waiter {
        unregister(): void;
      }

      /**
       * Announce that this process is waiting, so the holder can report how many
       * listeners a run had. The heartbeat is what keeps a crashed waiter from
       * counting forever.
       */
      export function registerWaiter(
        root: string,
        overrides: { pid?: number; heartbeatAt?: number } = {},
      ): Waiter {
        const dir = ensureCoordDir(root);
        const path = nodePath.join(dir, `${WAITER_PREFIX}${RECORD_PREFIX_SEP}${process.pid}${JSON_SUFFIX}`);
        const write = (): void => {
          writeJsonAtomic(path, {
            pid: overrides.pid ?? process.pid,
            heartbeatAt: overrides.heartbeatAt ?? Date.now(),
          });
        };
        write();
        const timer = setInterval(write, HEARTBEAT_MS);
        timer.unref();
        return {
          unregister: (): void => {
            clearInterval(timer);
            try {
              nodeFs.unlinkSync(path);
            } catch {
              // already gone
            }
          },
        };
      }

      /** Live waiters, by pid. A waiter whose pid is gone is not waiting. */
      export function countWaiters(root: string): number {
        const dir = coordDirFor(root);
        let names: string[];
        try {
          names = nodeFs.readdirSync(dir);
        } catch {
          return 0;
        }
        const pids = new Set<number>();
        for (const name of names) {
          if (!name.startsWith(`${WAITER_PREFIX}${RECORD_PREFIX_SEP}`)) continue;
          if (!name.endsWith(JSON_SUFFIX)) continue;
          try {
            const parsed = JSON.parse(
              nodeFs.readFileSync(nodePath.join(dir, name), 'utf8'),
            ) as { pid: number };
            if (isAlive(parsed.pid)) pids.add(parsed.pid);
          } catch {
            // corrupt waiter file: not a waiter
          }
        }
        return pids.size;
      }
      ```
      Note the test with a fixed `heartbeatAt: 1` and a dead pid must count 0 —
      `isAlive` is what makes that true, so `heartbeatAt` is not consulted here.
- [ ] **Step 4:** Run and confirm they pass. Expected: PASS (14 tests total in the file).

#### Task 2.3: `coordinateRun`

**Why:** this is the feature. Every policy above exists to make this function
four lines long.

**Files:**
- Modify: `packages/core/src/engine/run-lock.ts`
- Test: `packages/core/tests/engine/run-lock.test.ts` (extend)

**Steps:**

- [ ] **Step 1:** Add the failing tests, each one a sentence from the user's
      description of the feature.
      ```ts
      describe('coordinateRun', () => {
        const options = (overrides = {}) => ({
          root,
          requestKey: 'k1',
          jobs: 1,
          waitTimeoutMs: 5_000,
          staleMs: 100,
          pollMs: 20,
          ...overrides,
        });

        it('runs when nothing else is running, and reports mode "ran"', async () => {
          const outcome = await coordinateRun({ ...options(), run: async () => 'mine' });
          expect(outcome.mode).toBe('ran');
          expect(outcome.result).toBe('mine');
        });

        it('publishes a record that the next caller reuses without running', async () => {
          await coordinateRun({ ...options(), run: async () => 'first' });
          let ran = false;
          const outcome = await coordinateRun({
            ...options(),
            run: async () => {
              ran = true;
              return 'second';
            },
          });
          expect(outcome.mode).toBe('reused');
          expect(outcome.result).toBe('first');
          expect(ran).toBe(false);
        });

        it('waits for the running process and then reuses its result', async () => {
          // Start a slow run, then a second caller while it is still going.
          const first = coordinateRun({
            ...options(),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return 'slow';
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          let secondRan = false;
          const second = await coordinateRun({
            ...options(),
            run: async () => {
              secondRan = true;
              return 'fast';
            },
          });
          expect(second.mode).toBe('reused');
          expect(second.result).toBe('slow');
          expect(secondRan).toBe(false);
          expect(second.waitedMs).toBeGreaterThan(0);
          expect(await first).toBeDefined();
        });

        it('marks a run dirty when the tree changes while it runs, and nobody reuses it', async () => {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(nodePath.join(root, 'before.ts'), 'x');
          await coordinateRun({
            ...options(),
            run: async () => {
              await writeFile(nodePath.join(root, 'during.ts'), 'y');
              return 'dirty-result';
            },
          });
          const second = await coordinateRun({ ...options(), run: async () => 'clean' });
          expect(second.mode).toBe('ran');
          expect(second.result).toBe('clean');
        });

        it('takes over a stale slot instead of waiting for a dead process', async () => {
          const slot = acquireSlot(root, 0)!;
          // Simulate a crash: the slot file survives, pointing at a process that
          // cannot exist, with a heartbeat from the beginning of time.
          nodeFs.writeFileSync(
            slot.path,
            JSON.stringify({ pid: 999_999, startedAt: 0, heartbeatAt: 0 }),
          );
          slot.release(); // stops the heartbeat; the file is not ours, so it stays
          expect(readSlot(slot.path)).not.toBeNull();

          const outcome = await coordinateRun({ ...options(), run: async () => 'took-over' });
          expect(outcome.mode).toBe('ran');
          expect(outcome.result).toBe('took-over');
          expect(outcome.events.some((event) => event.type === 'took-over')).toBe(true);
        });

        it('runs without coordinating when standalone is set', async () => {
          await coordinateRun({ ...options(), run: async () => 'first' });
          const outcome = await coordinateRun({
            ...options(),
            standalone: true,
            run: async () => 'second',
          });
          expect(outcome.mode).toBe('standalone');
          expect(outcome.result).toBe('second');
        });

        it('reports the number of listeners the run had', async () => {
          // A waiter is registered while the first run is in flight.
          const first = coordinateRun({ ...options(), run: async () => 'slow' });
          await new Promise((resolve) => setTimeout(resolve, 20));
          const waiter = registerWaiter(root);
          const outcome = await first;
          expect(outcome.listeners).toBeGreaterThanOrEqual(1);
          waiter.unregister();
        });

        it('runs after waiting when the other run covered a different state', async () => {
          const { writeFile } = await import('node:fs/promises');
          const first = coordinateRun({
            ...options(),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 200));
              return 'first';
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          await writeFile(nodePath.join(root, 'mine.ts'), 'my work');
          const second = await coordinateRun({ ...options(), run: async () => 'second' });
          expect(second.mode).toBe('ran-after-wait');
          expect(second.result).toBe('second');
          expect(second.waitedMs).toBeGreaterThan(0);
          expect(await first).toBeDefined();
        });

        it('gives up waiting at the timeout and runs', async () => {
          const first = coordinateRun({
            ...options(),
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 400));
              return 'first';
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          const second = await coordinateRun({
            ...options(),
            waitTimeoutMs: 60,
            run: async () => 'second',
          });
          expect(second.mode).toBe('ran-after-wait');
          expect(second.result).toBe('second');
          expect(await first).toBeDefined();
        });
      });
      ```
      Also import `coordinateRun`, `acquireSlot`, `registerWaiter` at the top, and
      `nodeFs` from `node:fs`.
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: FAIL — `coordinateRun is not a function`.
- [ ] **Step 3:** Implement.
      ```ts
      export type CoordinationMode = 'ran' | 'reused' | 'ran-after-wait' | 'standalone';

      export type CoordinationEvent =
        | { readonly type: 'ran' }
        | { readonly type: 'waited'; readonly waitedMs: number; readonly runningPid: number }
        | {
            readonly type: 'reused';
            readonly waitedMs: number;
            readonly runAgeMs: number;
            readonly listeners: number;
          }
        | { readonly type: 'took-over'; readonly staleMs: number; readonly deadPid: number };

      export interface CoordinateOptions<R> {
        readonly root: string;
        readonly requestKey: string;
        /** How many runs may proceed at once. Default 1. */
        readonly jobs?: number | undefined;
        /** Run now, with no lock, no waiting and no reuse. `--standalone`. */
        readonly standalone?: boolean | undefined;
        readonly staleMs?: number | undefined;
        readonly pollMs?: number | undefined;
        readonly waitTimeoutMs?: number | undefined;
        /**
         * How many files this scan reprocessed, for the notices. A getter, because
         * the number is only known after the work has run.
         */
        readonly recheckedFiles?: (() => number) | undefined;
        readonly onEvent?: ((event: CoordinationEvent) => void) | undefined;
        readonly run: () => Promise<R>;
      }

      export interface CoordinationOutcome<R> {
        readonly result: R;
        readonly mode: CoordinationMode;
        readonly waitedMs: number;
        readonly runAgeMs: number;
        readonly listeners: number;
        /** Which process produced a reused result. */
        readonly reusedFromPid?: number | undefined;
        readonly events: readonly CoordinationEvent[];
      }

      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      /**
       * Run, reuse, or wait — whichever lets the answer be produced once for a tree.
       *
       * Order is deliberate: reuse first (no work at all), then run (we hold a
       * slot), then wait (someone else is working), then reuse again (their answer
       * may already cover us). A caller only ever waits *without* running: while
       * another process works, this one sleeps and does nothing else.
       */
      export async function coordinateRun<R>(
        options: CoordinateOptions<R>,
      ): Promise<CoordinationOutcome<R>> {
        const jobs = Math.max(1, options.jobs ?? 1);
        const pollMs = options.pollMs ?? POLL_MS;
        const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
        const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const startedAt = Date.now();
        const events: CoordinationEvent[] = [];
        const emit = (event: CoordinationEvent): void => {
          events.push(event);
          options.onEvent?.(event);
        };

        if (options.standalone === true) {
          const result = await options.run();
          emit({ type: 'ran' });
          return { result, mode: 'standalone', waitedMs: 0, runAgeMs: 0, listeners: 0, events };
        }

        const reuseNow = (): RunRecord<R> | null =>
          findReusableRecord<R>(options.root, options.requestKey, treeStateFor(options.root));

        const reused = (record: RunRecord<R>, waitedMs: number): CoordinationOutcome<R> => {
          const runAgeMs = Date.now() - record.finishedAt;
          emit({ type: 'reused', waitedMs, runAgeMs, listeners: record.listeners });
          return {
            result: record.result,
            mode: 'reused',
            waitedMs,
            runAgeMs,
            listeners: record.listeners,
            reusedFromPid: record.pid,
            events,
          };
        };

        /** The work, with a slot held. Publishes the record before releasing. */
        const runHolding = async (
          slot: Slot,
          didWait: boolean,
        ): Promise<CoordinationOutcome<R>> => {
          const before = treeStateFor(options.root);
          try {
            const result = await options.run();
            const after = treeStateFor(options.root);
            // Publishing before releasing is what makes a waiter find an answer
            // instead of repeating the work.
            if (slot.beat()) {
              writeRecord(options.root, {
                version: 1,
                requestKey: options.requestKey,
                treeState: after,
                startedAt,
                finishedAt: Date.now(),
                pid: process.pid,
                // A tree that changed mid-run is a mixture of two states, so nobody
                // else may reuse this result. Our own caller still gets it: that is
                // what a solo run would have produced.
                dirty: !treeStatesMatch(before, after),
                listeners: countWaiters(options.root),
                recheckedFiles: options.recheckedFiles?.() ?? 0,
                result,
              });
            }
            const waitedMs = Date.now() - startedAt;
            emit({ type: 'ran' });
            return {
              result,
              mode: didWait ? 'ran-after-wait' : 'ran',
              waitedMs,
              runAgeMs: 0,
              listeners: 0,
              events,
            };
          } finally {
            slot.release();
          }
        };

        const initial = reuseNow();
        if (initial !== null) return reused(initial, 0);

        let waiter: Waiter | null = null;
        let didWait = false;
        const stopWaiting = (): void => {
          waiter?.unregister();
          waiter = null;
        };

        try {
          for (;;) {
            let acquired: Slot | null = null;
            let tookOver = false;
            for (let index = 0; index < jobs; index += 1) {
              const slot = acquireSlot(options.root, index);
              if (slot !== null) {
                acquired = slot;
                break;
              }
              // Only the first slot is examined for staleness: a dead holder of
              // slot 0 is the case that strands every other caller.
              if (index === 0) {
                const stale = readSlot(slotPathFor(options.root, 0));
                const now = Date.now();
                if (stale !== null && now - stale.heartbeatAt > staleMs && !isAlive(stale.pid)) {
                  if (takeOverSlot(options.root, 0, now)) {
                    tookOver = true;
                    emit({
                      type: 'took-over',
                      staleMs: now - stale.heartbeatAt,
                      deadPid: stale.pid,
                    });
                  }
                }
              }
            }

            if (acquired !== null) {
              if (didWait) {
                const late = reuseNow();
                if (late !== null) {
                  stopWaiting();
                  acquired.release();
                  return reused(late, Date.now() - startedAt);
                }
              }
              stopWaiting();
              return await runHolding(acquired, didWait);
            }

            // A takeover freed a slot: retry immediately rather than sleeping.
            if (tookOver) continue;

            // Every slot is held: someone else is working. Wait without working.
            if (waiter === null) {
              waiter = registerWaiter(options.root);
              didWait = true;
            }
            const waitedMs = Date.now() - startedAt;
            if (waitedMs >= waitTimeoutMs) {
              // A gate that waits forever is not a gate. Run anyway, and report it.
              stopWaiting();
              const holder = readSlot(slotPathFor(options.root, 0));
              emit({ type: 'waited', waitedMs, runningPid: holder?.pid ?? 0 });
              const result = await options.run();
              emit({ type: 'ran' });
              return { result, mode: 'ran-after-wait', waitedMs, runAgeMs: 0, listeners: 0, events };
            }
            await sleep(pollMs);
            const late = reuseNow();
            if (late !== null) {
              stopWaiting();
              return reused(late, Date.now() - startedAt);
            }
          }
        } finally {
          stopWaiting();
        }
      }
      ```

      The tests in Step 1 are the specification. Two behaviours in this code
      exist only because a test demanded them and must not be "simplified" away:
      listeners are counted **after** the work runs (a waiter that arrives during
      the run is exactly the waiter worth reporting), and a takeover retries the
      acquisition immediately instead of falling into the poll loop.
- [ ] **Step 4:** Run and confirm they pass.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: PASS (≥ 22 tests in the file). The "waits and reuses" test must
      report `mode: 'reused'`; the "different state" test must report
      `ran-after-wait`.
- [ ] **Step 5:** Export the surface from core.
      ```ts
      // packages/core/src/index.ts
      export {
        coordinateRun,
        coordDirFor,
        countWaiters,
        findReusableRecord,
        readRecords,
        registerWaiter,
        writeRecord,
      } from './engine/run-lock';
      export type {
        CoordinateOptions,
        CoordinationEvent,
        CoordinationMode,
        CoordinationOutcome,
        RunRecord,
      } from './engine/run-lock';
      export { fileSetFingerprint, treeStateFor, treeStatesMatch } from './engine/file-set';
      export type { TreeState } from './engine/file-set';
      ```
      Match the file's existing export style: single-line named exports. It does
      not currently export `./engine/file-set`, so add two statements beside the
      existing `export { toolWatchPatterns } from './engine/tool-patterns';`:
      ```ts
      export { fileSetFingerprint, treeStateFor, treeStatesMatch } from './engine/file-set';
      export type { TreeState } from './engine/file-set';
      export { coordinateRun, coordDirFor, countWaiters, findReusableRecord, registerWaiter, writeRecord } from './engine/run-lock';
      export type {
        CoordinateOptions,
        CoordinationEvent,
        CoordinationMode,
        CoordinationOutcome,
        RunRecord,
      } from './engine/run-lock';
      export { scopedPatterns } from './engine/tool-patterns';
      ```
      `scopedPatterns` is added in Phase 4; add its export then, not now.
- [ ] **Step 6:** Full core suite, then a build, because the CLI consumes `dist`.
      ```bash
      pnpm --filter @gesetz/core test && pnpm --filter @gesetz/core build
      ```
      Expected: green, build succeeds.

---

### Phase 3: Wire it into `gesetz check`

The CLI decides the request key, calls `coordinateRun`, renders whichever result
it got, and prints the notices.

#### Task 3.1: The request key

**Why:** reuse must be impossible between two callers asking different questions.
Getting this wrong is the one way this feature can return a wrong answer.

**Files:**
- Modify: `packages/cli/src/main.ts`

**Steps:**

- [ ] **Step 1:** Add a helper above `checkCommand`.
      ```ts
      /**
       * Identifies the question a run answers. Two callers may share a run only
       * when every field that changes the answer agrees.
       */
      const requestKeyFor = (input: {
        root: string;
        configPath: string | undefined;
        rules: readonly { id: string }[];
        thresholds: readonly { category: string; minScore: number }[];
        fileFilter: readonly string[] | null;
        changedSince: string | undefined;
        baselineBytes: string | null;
        storage: import('@gesetz/core').GesetzStorageConfig;
      }): string =>
        createHash('sha256')
          .update(
            JSON.stringify([
              'gesetz-coordination-v1',
              input.root,
              input.configPath ?? '<default>',
              [...input.rules.map((rule) => rule.id)].sort(),
              [...input.thresholds]
                .map((threshold) => `${threshold.category}=${threshold.minScore}`)
                .sort(),
              input.fileFilter === null ? null : [...input.fileFilter].sort(),
              input.changedSince ?? null,
              input.baselineBytes === null
                ? null
                : createHash('sha256').update(input.baselineBytes).digest('hex'),
              input.storage.kind === 'sqlite' ? 'sqlite' : 'memory',
            ]),
          )
          .digest('hex')
          .slice(0, 16);
      ```
      Add `import { createHash } from 'node:crypto';` at the top.
- [ ] **Step 2:** Compute it in the `check` handler, after `thresholds`,
      `filteredConfig`, `storage`, and `baseline` exist.
      ```ts
      const baselineBytes =
        baseline === null
          ? null
          : nodeFs.readFileSync(baselinePathFor(root), 'utf8');
      const requestKey = requestKeyFor({
        root,
        configPath,
        rules: filteredConfig.rules,
        thresholds,
        fileFilter: Option.getOrUndefined(filesGlobs) ?? null,
        changedSince,
        baselineBytes,
        storage,
      });
      ```
- [ ] **Step 3:** Confirm it typechecks. Expected: no errors.

#### Task 3.2: Coordinate the run and print the notices

**Why:** this is what the agents see. The notices are the feature's user
interface, and the wrong wording is worse than none — an agent must be able to
tell that a result may describe other people's files.

**Files:**
- Modify: `packages/cli/src/main.ts`

**Steps:**

- [ ] **Step 1:** Resolve the three knobs before anything uses them. Place this
      where `storage`, `thresholds` and `baseline` are already in scope, above the
      `runAndRender` definition. It is one place, so `--jobs`, `GESETZ_JOBS`,
      `--standalone`, `GESETZ_LOCK` and `--full` cannot disagree with each other.
      ```ts
      const waitTimeoutSeconds = Option.getOrUndefined(opts.waitTimeout);
      const waitTimeoutMs =
        waitTimeoutSeconds === undefined ? undefined : waitTimeoutSeconds * 1000;
      // A caller that wants no caching wants no sharing either.
      const standalone = opts.standalone || opts.full || process.env['GESETZ_LOCK'] === 'off';
      const jobsFromEnv = Number(process.env['GESETZ_JOBS'] ?? '');
      const jobs =
        Number.isFinite(jobsFromEnv) && jobsFromEnv > 0
          ? Math.floor(jobsFromEnv)
          : Option.getOrElse(opts.jobs, () => 1);
      ```
      Honour the environment variables here rather than inside `coordinateRun`,
      so the core primitive never reads the process environment.
- [ ] **Step 2:** Change `runAndRender` so the `runAll` call happens inside the
      coordinator. Keep the existing `onScan` handler: capture the scan stats in a
      local so the coordinator can record how many files were reprocessed.
      ```ts
      let lastScan: { added: number; changed: number; removed: number } | null = null;

      const coordinate = yield* Effect.promise(() =>
        coordinateRun({
          root,
          requestKey,
          jobs,
          standalone,
          ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
          // A getter: the count is known only after the run.
          recheckedFiles: () =>
            lastScan === null ? 0 : lastScan.added + lastScan.changed,
          run: () =>
            Effect.runPromise(
              runAll(
                { ...filteredConfig, thresholds, storage },
                {
                  baseline,
                  fileFilter: Option.getOrUndefined(filesGlobs) ?? null,
                  onScan: (scan) => {
                    lastScan = scan;
                    process.stderr.write(
                      `scan: ${scan.filesSeen} files — +${scan.added} ~${scan.changed} -${scan.removed} =${scan.reused} reused (${scan.durationMs}ms)\n`,
                    );
                  },
                },
              ),
            ),
        }),
      );
      ```
      `recheckedFiles` is a getter because the count is only known after the run.
      The type in `run-lock.ts` is
      `readonly recheckedFiles?: (() => number) | undefined`; if the Phase 2 tests
      pass a number, change them to pass a function (`() => 4`).
      Everything after this reads `coordinate.result` in place of the old
      `runAll` result, and `first` in the `if (!first.passing)` check becomes
      `coordinate.result`.
- [ ] **Step 3:** Render from `coordinate.result` exactly as before, and print the
      notices from `coordinate.mode` and `coordinate.waitedMs`. Put the mapping in
      a small exported pure function so it is testable:
      ```ts
      /**
       * The one line an agent reads to understand why its result looks the way it
       * does. A shared worktree means a result can describe files this process
       * never touched, and saying so is the whole point of the notice.
       */
      export function describeCoordination(input: {
        mode: 'ran' | 'reused' | 'ran-after-wait' | 'standalone';
        waitedMs: number;
        runAgeMs: number;
        listeners: number;
        recheckedFiles: number;
        runningPid?: number | undefined;
      }): string {
        const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
        const shared =
          input.recheckedFiles > 0
            ? ` — this run re-checked ${input.recheckedFiles} changed file${input.recheckedFiles === 1 ? '' : 's'}; this worktree is shared, so some results may not be yours`
            : '';
        if (input.mode === 'standalone') return 'coord: standalone — not waiting, not reusing';
        if (input.mode === 'reused') {
          return `coord: reused a run from ${seconds(input.runAgeMs)} ago — this tree state was already checked${shared}`;
        }
        if (input.mode === 'ran-after-wait') {
          return `coord: waited ${seconds(input.waitedMs)}${input.runningPid === undefined ? '' : ` for pid ${input.runningPid}`}, then ran${shared}`;
        }
        const listeners =
          input.listeners > 0
            ? ` — ${input.listeners} other process${input.listeners === 1 ? '' : 'es'} waited on this run`
            : '';
        return `coord: ran — no other gesetz check active${listeners}${shared}`;
      }
      ```
      Print it with `yield* Console.error(...)` on stderr after the status banner,
      passing `coordinate.runAgeMs` for the reused case and `coordinate.waitedMs`
      for the others. When `coordinate.events` contains a `took-over` event, print
      `coord: took over slot 0 from pid <deadPid> (no heartbeat for <staleMs>)`
      before it.
- [ ] **Step 4:** Add the three options to `checkCommand`, in the existing style.
      ```ts
      standalone: Options.boolean('standalone').pipe(
        Options.withDescription(
          'Run immediately: do not wait for or reuse another gesetz check',
        ),
        Options.withDefault(false),
      ),
      jobs: Options.integer('jobs').pipe(
        Options.withDescription(
          'How many gesetz check runs may proceed at once in this worktree (default 1). GESETZ_JOBS overrides.',
        ),
        Options.withDefault(1),
      ),
      waitTimeout: Options.integer('wait-timeout').pipe(
        Options.withDescription(
          'Seconds to wait for a run in flight before running anyway (default 600)',
        ),
        Options.optional,
      ),
      ```
- [ ] **Step 5:** Verify by hand in a scratch project, two shells, one slow rule.
      ```bash
      # shell 1
      node packages/cli/dist/main.js check
      # shell 2, started while shell 1 is still running
      node packages/cli/dist/main.js check
      ```
      Expected: shell 2 prints `coord: waited ... then reused ...` or
      `coord: reused a run ...`, and its `scan:` line is absent (it ran nothing)
      or shows a fully-reused scan. Shell 1 prints `coord: ran`.

#### Task 3.3: The envelope field

**Why:** an agent parsing stdout has no stderr. Without this field it cannot tell
a reused result from its own.

**Files:**
- Modify: `packages/cli/src/envelope.ts`
- Test: `packages/cli/tests/envelope.test.ts` (extend)

**Steps:**

- [ ] **Step 1:** Add the failing test.
      ```ts
      it('carries the coordination block when a coordination object is passed', () => {
        const envelope = formatEnvelope(result(), {
          coordination: {
            mode: 'reused',
            waitedMs: 3400,
            runAgeMs: 2100,
            listeners: 2,
            recheckedFiles: 4,
            pid: 57132,
          },
        });
        expect(JSON.parse(envelope).coordination.mode).toBe('reused');
        expect(JSON.parse(envelope).v).toBe(1);
      });

      it('omits the coordination block when none is passed', () => {
        expect('coordination' in JSON.parse(formatEnvelope(result(), {}))).toBe(false);
      });
      ```
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/cli test -- envelope
      ```
      Expected: FAIL — the key is absent.
- [ ] **Step 3:** Add an optional `coordination` field to the options type of
      `formatEnvelope` and include it in the JSON object only when provided. Do
      not change `v`, and do not reorder existing keys.
- [ ] **Step 4:** Run and confirm they pass. Expected: PASS.

#### Task 3.4: The two-process test

**Why:** every other test runs in one process. The feature only exists between
processes, and a single-process test cannot prove the lock is shared.

**Files:**
- Create: `packages/cli/tests/coordination.test.ts`

**Steps:**

- [ ] **Step 1:** Write the test: a temp project with a deliberately slow rule, two
      concurrent CLI processes, and assertions on their JSON envelopes.
      ```ts
      import { describe, it, expect } from 'vitest';
      import { execFile } from 'node:child_process';
      import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import * as nodePath from 'node:path';
      import * as nodeFs from 'node:fs';

      const REPO_ROOT = nodePath.resolve(__dirname, '../../..');
      const DIST_MAIN = nodePath.join(REPO_ROOT, 'packages/cli/dist/main.js');

      /** Runs the CLI and resolves with its parsed stdout envelope. */
      const runCli = (
        cwd: string,
      ): Promise<{ code: number; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          execFile(
            process.execPath,
            [DIST_MAIN, 'check', '--format=json'],
            { cwd, timeout: 120_000, env: { ...process.env, GESETZ_DB: nodePath.join(cwd, '.gesetz/cache.db') } },
            (error, stdout, stderr) => {
              resolve({
                code: error === null ? 0 : ((error as { code?: number }).code ?? 1),
                stdout,
                stderr,
              });
            },
          );
        });

      describe('two concurrent checks in one worktree', () => {
        it('performs the work once and hands the second caller the same result', async () => {
          if (!nodeFs.existsSync(DIST_MAIN)) {
            console.warn(`skipping: ${DIST_MAIN} not built`);
            return;
          }
          const dir = await mkdtemp(nodePath.join(tmpdir(), 'gesetz-coord-cli-'));
          try {
            await mkdir(nodePath.join(dir, 'src'), { recursive: true });
            await writeFile(nodePath.join(dir, 'src/a.ts'), 'export const a = 1;\n');
            // A rule that takes long enough for the second process to arrive while
            // the first is still working. The sleep is the test fixture, not a
            // production rule.
            await writeFile(
              nodePath.join(dir, 'gesetz.config.ts'),
              [
                `import { defineConfig, select } from '${REPO_ROOT}/packages/core/dist/index.js';`,
                'const slow = async (file: unknown) => {',
                '  await new Promise((r) => setTimeout(r, 1500));',
                '  return [];',
                '};',
                'export default defineConfig({',
                '  projectRoot: ' + JSON.stringify(dir) + ',',
                "  rules: [select('src/**/*.ts').label('Slow').category('cleanup').check(slow)],",
                '});',
                '',
              ].join('\n'),
            );

            const first = runCli(dir);
            // Let the first process create its slot before the second starts, so
            // the test measures coordination rather than startup order.
            await new Promise((resolve) => setTimeout(resolve, 300));
            const second = runCli(dir);

            const outcomes = await Promise.all([first, second]);
            const modes = outcomes.map(
              (outcome) =>
                JSON.parse(outcome.stdout.trim().split('\n').at(-1) ?? '{}').coordination?.mode,
            );
            expect(modes.filter((mode) => mode === 'ran')).toHaveLength(1);
            expect(modes.filter((mode) => mode === 'reused' || mode === 'ran-after-wait')).toHaveLength(1);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }, 240_000);
      });
      ```
- [ ] **Step 2:** Run it.
      ```bash
      pnpm --filter @gesetz/cli test -- coordination
      ```
      Expected: PASS. If both report `ran`, the second started before the first
      created its slot — increase the rule's sleep, do not weaken the assertion.
- [ ] **Step 3:** Confirm the escape hatch, in the same file.
      ```ts
      it('runs both when --standalone is passed', async () => { /* same shape, both with --standalone */ });
      ```
      Expected: both report `mode: 'standalone'`, and both `scan:` lines are
      present (both processes did full work — that is what standalone means).

#### Task 3.5: Make the whole thing legal for the gates

**Why:** this repo's gates are strict by design, and a new source file without a
test, or an unformatted file, fails the build.

**Files:**
- Modify: whatever `pnpm dogfood` complains about

**Steps:**

- [ ] **Step 1:** Run the gates.
      ```bash
      pnpm format && pnpm typecheck && pnpm test && pnpm dogfood
      ```
      Expected: exit 0 each. `run-lock.ts` has a test file, so the `testing`
      gate is satisfied; if `noGodFile` complains, split the waiter section into
      `packages/core/src/engine/run-lock-waiters.ts` and re-export.
- [ ] **Step 2:** If `noGodFile` fires, do the split rather than raising the limit.

---

### Phase 4: Scope the external tools to the changed files

Once runs are shared, the remaining per-run cost is a tool walking the whole
project. `ProjectRuleContext.changedFiles` already carries what is needed.

**The soundness rule for this phase, which every task follows:** a tool may be
scoped **only when its result for file X depends solely on file X**. Formatters,
linters and per-file static analysis qualify. Test runners and browser tools do
not, which is why they are out of scope.

#### Task 4.1: A shared helper for scoping

**Why:** five adapters need the same three-line decision, and the decision has a
sharp edge — an empty result must never be confused with "nothing to check".

**Files:**
- Modify: `packages/core/src/engine/tool-patterns.ts` (the module that already
  holds `toolWatchPatterns`)
- Test: `packages/core/tests/engine/tool-patterns.test.ts` (extend)

**Steps:**

- [ ] **Step 1:** Add the failing tests.
      ```ts
      describe('scopedPatterns', () => {
        it('returns the changed files that match the tool globs', () => {
          expect(
            scopedPatterns(['src/a.ts', 'src/b.php'], ['src/**/*.ts']),
          ).toEqual(['src/a.ts']);
        });

        it('returns null when no changed file matches, meaning "nothing to do"', () => {
          // Null is distinct from []: [] would make a tool scan nothing and report
          // a clean project, which is the fail-open shape this repo keeps finding.
          expect(scopedPatterns(['src/a.php'], ['src/**/*.ts'])).toBeNull();
        });

        it('returns null for an empty changed list', () => {
          expect(scopedPatterns([], ['src/**/*.ts'])).toBeNull();
        });

        it('ignores paths outside the project', () => {
          expect(scopedPatterns(['../elsewhere/a.ts'], ['src/**/*.ts'])).toBeNull();
        });
      });
      ```
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/core test -- tool-patterns
      ```
      Expected: FAIL — `scopedPatterns is not a function`.
- [ ] **Step 3:** Implement.
      ```ts
      /**
       * The subset of `changedFiles` a tool is responsible for, or null when the
       * tool has nothing to do this scan.
       *
       * Null and [] are different answers. Returning [] to a formatter makes it
       * scan nothing and report success, which looks exactly like a clean project
       * — the failure mode this returns null to avoid.
       */
      export function scopedPatterns(
        changedFiles: readonly string[],
        toolPatterns: readonly string[],
      ): string[] | null {
        const matches = changedFiles.filter((path) => micromatch.some([path], [...toolPatterns]));
        return matches.length > 0 ? matches : null;
      }
      ```
- [ ] **Step 4:** Run and confirm they pass.
- [ ] **Step 5:** Leave `gesetz.config.ts` alone in this task. The adapters in this
      repo are configured with `pattern: 'packages'`, and `toolWatchPatterns('packages')`
      already yields the glob list the helper matches against. If a rule's
      `pattern` turns out to be a directory rather than a glob, matching changed
      files against it fails and the tool falls back to a full run — correct but
      unoptimised. Verify with Task 4.2's test; if the fallback always wins,
      extend `toolWatchPatterns` rather than moving globs into `gesetz.config.ts`.

#### Task 4.2: Scope `oxfmt` and `oxlint`

**Why:** these two are configured in this repo and run on every relevant change.
They are also the pattern for the other three.

**Files:**
- Modify: `packages/oxfmt/src/adapter.ts`, `packages/oxlint/src/adapter.ts`
- Test: `packages/oxfmt/tests/adapter.test.ts`, `packages/oxlint/tests/adapter.test.ts`

**Steps:**

- [ ] **Step 1:** Add the failing test to `packages/oxfmt/tests/adapter.test.ts`.
      Follow the file's existing style for stubbing the tool: it must assert the
      argv the adapter builds for a project run with a known `changedFiles`.
      ```ts
      it('passes only the changed files to the tool', async () => {
        const rule = oxfmt({ pattern: 'src/**/*.ts', bin: 'oxfmt' });
        const calls: string[][] = [];
        // Stub the tool the same way the other tests in this file do.
        await runProjectRuleWithChanged(rule, ['src/a.ts', 'src/b.ts'], (args) => calls.push(args));
        expect(calls[0]).toEqual(['--list-different', 'src/a.ts', 'src/b.ts']);
      });

      it('does not call the tool at all when no changed file matches', async () => {
        const rule = oxfmt({ pattern: 'src/**/*.ts', bin: 'oxfmt' });
        const calls: string[][] = [];
        await runProjectRuleWithChanged(rule, ['src/a.php'], (args) => calls.push(args));
        expect(calls).toEqual([]);
      });
      ```
      `runProjectRuleWithChanged` is a local helper in the test file that calls
      `rule.project.run({ changedFiles, network: {...}, rootDir })` with the tool
      stubbed. If the file already has such a helper, reuse it instead of writing a
      second one.
- [ ] **Step 2:** Run and confirm they fail.
      ```bash
      pnpm --filter @gesetz/oxfmt test
      ```
      Expected: FAIL — the tool receives `['--list-different', 'src/**/*.ts']`.
- [ ] **Step 3:** Implement in `packages/oxfmt/src/adapter.ts`.
      ```ts
      project: {
        patterns: toolWatchPatterns(defaultPatterns),
        run: (ctx) => {
          // A formatter's answer for a file depends only on that file, so only the
          // files this scan reprocessed need answering. Markers for the rest stay
          // in the cache untouched.
          const scoped = scopedPatterns(ctx.changedFiles, defaultPatterns);
          if (scoped === null) return Promise.resolve([]);
          return executeOxfmt(opts, id, bin, cwd, scoped);
        },
      },
      ```
      Import `scopedPatterns` from `@gesetz/core`. Do the same in
      `packages/oxlint/src/adapter.ts` (`executeOxlint(opts, id, bin, cwd, scoped)`).
- [ ] **Step 4:** Run and confirm they pass.
      ```bash
      pnpm --filter @gesetz/oxfmt test && pnpm --filter @gesetz/oxlint test
      ```
- [ ] **Step 5:** Verify the effect end to end, in this repo.
      ```bash
      pnpm --filter @gesetz/core build && pnpm --filter @gesetz/oxfmt build && pnpm --filter @gesetz/oxlint build
      node packages/cli/dist/main.js check 2>&1 | grep -E "scan:|gesetz:"
      ```
      Expected: unchanged results (`gesetz: pass`), and a warm run that re-checks
      one file does not take the full 4–6s `oxfmt` pass. Confirm the timing
      difference with `/usr/bin/time -p`.
- [ ] **Step 6:** If `noCrossModuleImports` or a similar organization rule objects
      to the new import in an adapter, check how the other adapters already import
      from `@gesetz/core` and follow that exact form.

#### Task 4.3: Scope `eslint`, `prettier`, `phpstan`

**Why:** the same change, and the same soundness rule — these three also answer
per file.

**Files:**
- Modify: `packages/eslint/src/adapter.ts`, `packages/prettier/src/adapter.ts`,
  `packages/phpstan/src/adapter.ts`
- Test: the matching `tests/adapter.test.ts` in each package

**Steps:**

- [ ] **Step 1:** For each of the three, add the two tests from Task 4.2 Step 1
      (scoped argv, and no call when nothing matches), adapted to that tool's
      argv.
- [ ] **Step 2:** Run each and confirm they fail.
      ```bash
      pnpm --filter @gesetz/eslint test && pnpm --filter @gesetz/prettier test && pnpm --filter @gesetz/phpstan test
      ```
- [ ] **Step 3:** Apply the same `scopedPatterns` change to each `project.run`.
- [ ] **Step 4:** Run and confirm all three pass.
- [ ] **Step 5:** Confirm the whole repo is still green.
      ```bash
      pnpm format && pnpm typecheck && pnpm test && pnpm dogfood
      ```

---

## Validation

```bash
# Everything, from a clean build.
pnpm build && pnpm typecheck && pnpm test && pnpm dogfood
# Expected: exit 0 for each. dogfood: `gesetz: pass (0 violations)`, every
# category 10, and no `source-files-need-tests` violation for run-lock.ts.

# The cache works under Bun (Phase 0).
bun packages/cli/dist/main.js check 2>&1 | grep -E "cache:|scan:"
bun packages/cli/dist/main.js check 2>&1 | grep -E "scan:"
# Expected: first is cold (+N), second is `=N reused`, no `cache disabled` line.

# Two processes share one run (Phase 3).
pnpm --filter @gesetz/cli test -- coordination
# Expected: PASS — one `ran`, one `reused`.

# Escape hatches (Phase 3).
node packages/cli/dist/main.js check --standalone 2>&1 | grep "coord:"
# Expected: `coord: standalone — not waiting, not reusing`
node packages/cli/dist/main.js check --full 2>&1 | grep "coord:"
# Expected: also `coord: standalone …` — --full implies standalone.
GESETZ_JOBS=3 node packages/cli/dist/main.js check 2>&1 | grep "coord:"
# Expected: a normal `coord: ran` line; up to 3 runs may proceed at once.
GESETZ_LOCK=off node packages/cli/dist/main.js check 2>&1 | grep "coord:"
# Expected: `coord: standalone — not waiting, not reusing`

# Tools are scoped (Phase 4).
pnpm --filter @gesetz/oxfmt test && pnpm --filter @gesetz/oxlint test
# Expected: PASS, including the two scoping tests per adapter.

# A wrong answer is impossible in the risky direction (Phase 2).
pnpm --filter @gesetz/core test -- run-lock
# Expected: PASS, including `marks a run dirty ...` and
# `runs after waiting when the other run covered a different state`.
```

---

## Risks & rollback

- **Risk:** reuse returns a stale result and an agent commits on a false pass.
  **Likelihood:** low; **blast radius:** high — this is a quality gate.
  **Mitigation:** four conditions must hold, including a `dirty` flag for a tree
  that changed mid-run and a request key over the flags that change an answer.
  `--standalone` and `--full` skip reuse. The `marks a run dirty` and
  `covered a different state` tests are the guards; do not weaken them.
- **Risk:** a crashed holder leaves a slot, and every later run waits 15s then
  runs anyway. **Mitigation:** `isAlive` + heartbeat staleness; the
  `takes over a stale slot` test covers it. Worst case is a 15s delay, then
  normal operation.
- **Risk:** the coordination directory grows without bound.
  **Mitigation:** `pruneRecords` keeps the newest 8 plus anything younger than
  60s; waiter files are removed on unregister and ignored when their pid is dead.
- **Risk:** the CLI blocks where it used to return (a bad `waitTimeoutMs`).
  **Mitigation:** the default is 600s, `--wait-timeout` is explicit, and the
  timeout path runs the work anyway rather than failing. Add a test if the
  executor finds the timeout path reachable in practice.
- **Risk:** Phase 4's scoping makes a tool report a clean project without
  checking it. **Mitigation:** `scopedPatterns` returns `null`, never `[]`, for
  "nothing to do", and the adapter returns `[]` violations without calling the
  tool; the "does not call the tool at all" test pins this.
- **Rollback:** every phase is additive and independently revertable.
  Phase 0 is two edits in one file; reverting restores the previous behaviour
  exactly. Phases 1–3 add files and CLI options; deleting `run-lock.ts` and the
  `coordinateRun` call restores the old code path. Phase 4 changes five closures.
  No schema, no migration, no persisted format that outlives a revert — the
  coordination directory is disposable, and `--standalone` bypasses all of it
  without a code change.

---

## Not in scope: the daemon

Worth writing as its own plan later, and the protocol above is designed so it can
be. Sketch, so the executor does not improvise one:

- A `gesetz daemon` process would hold `createNetwork(...)` open and watch the
  tree, re-running incrementally after each change. Today `runAll` creates and
  disposes a network per call, so this needs the network lifecycle extracted into
  a session object in `packages/core/src/engine/runner.ts` first.
- It would publish the *same* run records; `check` would gain a
  "prefer a live daemon" path, reusing `findReusableRecord` unchanged. The lock
  protocol does not need to change.
- It saves the per-run floor (process start + scan, ~2s here) but not the
  duplicate work — coalescing does that, and coalescing is useful without a
  daemon. That is why the daemon is not in this plan.
- It must never be required: standalone `check` stays the default when no daemon
  runs, and the daemon needs its own pid file, heartbeat, `--stop`, and a stale
  path.

---

## Open questions

- [ ] **Which changed-file flag does each test runner actually support?** Scope
  Phase 4's follow-up for `vitest`, `pest`, `phpunit`, `bun-test`, `storybook`
  needs the real flag per tool (`vitest --changed`, Pest's filter options, …).
  Do not guess these; they need verification against each tool's docs and a
  scoped run cannot be validated the way a formatter's can, because a test
  suite's pass/fail is not per-file additive. — needs decision from the user on
  whether "changed tests only" is desirable at all, since a filtered green suite
  does not mean the suite is green.
- [ ] **Default `jobs`.** The plan defaults to 1, which maximises reuse (one run
  covers every listener). The user suggested 2–3 may be acceptable to cut
  waiting. A higher default trades CPU for latency, and only helps callers whose
  request keys differ. — needs decision from the user after they see it in
  practice.
- [ ] **Should `--since` and `--files` callers share a run?** Both are
  aggregation-time filters, so one full run could answer many filtered questions.
  Doing so would need the record to store the unfiltered result and the waiter to
  re-aggregate. — follow-up, not this plan.

---

## Progress

**This section is maintained by the implementing agent. Update it continuously.**

### Phase completion

- [ ] Phase 0: Make the violation cache work under Bun
- [ ] Phase 1: Tree state, in `packages/core/src/engine/file-set.ts`
- [ ] Phase 2: The coordination primitive
- [ ] Phase 3: Wire it into `gesetz check`
- [ ] Phase 4: Scope the external tools to the changed files
- [ ] Validation complete
- [ ] Plan marked DONE

### Session log

*The implementing agent appends an entry here after each phase or working
session. Include: what was completed, what was skipped and why, what comes next,
and any decisions made (with rationale). This log is the handoff document — a
new agent reading only this file must be able to continue without asking.*

---
*(no entries yet)*
