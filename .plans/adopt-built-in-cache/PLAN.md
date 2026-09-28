# Adopt the built-in cache engine, and put the orchestration back on top

> **Status:** DRAFT
> **Plan:** `./.plans/adopt-built-in-cache/PLAN.md`
> **Last updated:** 2026-09-27
> **Integration branch:** `cache-engine` (from `origin/netzwerk`, merging `main`)

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

5. **HARD RULE — no fail-open may be introduced or left behind.** This codebase
   has lost more time to gates that silently pass than to any missing feature.
   Every task that touches caching, invalidation, or scoping must leave behind a
   test that **fails if the gate can pass without checking**. Phase 2, 3 and 4 each
   name the exact test. Do not skip them, and do not weaken them to make a phase
   green.

6. **Update the Progress section** at the bottom of this file as you work:
   - Mark phase checkboxes `[x]` when a phase is complete.
   - Mark task checkboxes `[x]` as each task is done.
   - After each phase, write a brief note under "Session log" with what was
     done and what comes next.

---

## Goal

Adopt the built-in incremental cache from `origin/netzwerk` as gesetz's engine —
no netzwerk dependency, no 856 MB of transitive packages, no silent 64 KB file
skip — and re-establish on top of it the orchestration that `main` has: scoped
`--files`, adapter and test scoping, and multi-agent coordination. The result must
be measurably faster in the immocore React repo, and must not fall over when
several agents run `gesetz check` at once.

## Approach

`origin/netzwerk` is the better engine and `main` is the better orchestration.
Neither branch alone is fast:

| cost measured in immocore (9,247 files, 6,033 PHP) | has the fix | where |
|---|---|---|
| repeated parsing — a file is parsed once per check plus once per backend | file-major execution + parse memo | **origin/netzwerk** |
| cache wiped on any file add/remove (150 s re-parse) | per-scope fingerprints | **origin/netzwerk** (but see Phase 2) |
| whole vitest suite per run — 56.2 s | test scoping | **main** (10.8 s measured) |
| five agents repeating one scan | coordination | **main** |
| tools re-checking the whole project | adapter scoping | **main** |
| `--files` that only filtered the report | request scoping | **main** |
| crash at 118,440 markers (`too many SQL variables`) | single-row statements, no `IN (…)` | **origin/netzwerk** |
| 856 MB of transitive deps; files over 64 KB silently skipped | dependency-free kernel | **origin/netzwerk** |

So: **branch from `origin/netzwerk`, merge `main` into it**, keep the new engine,
and re-establish main's orchestration *in the new engine's shape* rather than
resurrecting its netzwerk-era modules.

Alternatives considered and rejected:

- **Merge `origin/netzwerk` into `main` and keep netzwerk's layer.** Rejected:
  the branch deletes exactly the layer main's scoping work touches
  (`backend/compile.ts`, `violation-markers.ts`, `syntax-extension.ts`,
  `check-services.ts`), so main's modules cannot be kept — they would have to be
  rewritten against netzwerk's marker store, which the branch removes.
- **Keep the branch's single `rules` scope and accept recomputing everything on
  add/remove.** Rejected: in a repo where agents create files continuously, that
  is a full re-check of 9,247 files per added file — the same disease the file-set
  fingerprint caused on `main` (Phase 2 replaces it).
- **Give file-system-reading checks their own cache scope keyed by the path set.**
  Rejected in favour of routing them through the **project-rule path**, which the
  branch already keys by the content hashes of the files a rule covers — so an
  add/remove/rename already recomputes it, with no kernel change, and the check is
  cheap because it parses nothing (Phase 2).
- **Narrow the file list a `--files` run hands to `sync()`.** Rejected: `sync()`
  calls `store.prune(scope, keep)` with the files it was given, so narrowing the
  list *deletes the cached results of every other file* — a `--files` run would
  wipe the cache it is trying to use. Phase 3 adds a sentinel instead.

## Tech stack & conventions

- TypeScript, ESM, pnpm workspace. `pnpm@11.9.0`. Effect for the runner/CLI;
  plain `async` for checks.
- Gates, all three must pass before any commit: `pnpm typecheck`, `pnpm test`,
  `pnpm dogfood` (`pnpm build && node packages/cli/dist/main.js check`).
  `pnpm format` before committing.
- Tests in `packages/<pkg>/tests/**` mirroring `src/**` in gesetz; `packages/netzwerk`
  is not touched by this plan.
- The engine under adoption is **file-major**: `runAll` lists files, then for each
  file parses at most once and runs every applicable per-file rule against that one
  parse. Per-file results are cached in one scope named `rules`.
- `.gesetz/` stays gitignored: coordination records live there. The adopted engine's
  cache lives at `${XDG_CACHE_HOME:-~/.cache}/gesetz/cache.db`, namespaced per
  project root — nothing to gitignore, one place to clear.
- The immocore worktree at
  `/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger`
  symlinks `node_modules/@gesetz/*` into this repo, so edits here are live there.
  **Do not edit that repo.** It is read-only for this plan; only run commands in it.
- `git` write commands (commit, merge, push) are the user's to run. Prepare commits
  and tell the user; do not push.

---

## Context & orientation

### What `origin/netzwerk` contains

Five commits, tip `a744d04`, merge-base `a1e65f7`, dated Sep 16 — **14 commits
behind `main`**. The work:

- `97bc02c feat!: drop netzwerk and run rules on a built-in incremental cache` —
  105 files, +7,642/−2,368. Deletes `backend/compile.ts`, `check-services.ts`,
  `syntax-extension.ts`, `violation-markers.ts`; adds:
  - `packages/core/src/cache/` — `kernel.ts` (`sync()`), `store-sqlite.ts`,
    `store-memory.ts`, `hash.ts`, `drivers.ts`, `types.ts`, `README.md`. Its
    contract, enforced by `tests/cache/purity.test.ts`: **imports only `node:*`
    builtins and `./` siblings.**
  - `packages/sqlite-compat/` — `node:sqlite` or `better-sqlite3` via
    `createRequire`; a no-op when neither resolves (so Bun is not a special case).
  - `packages/core/src/engine/discovery.ts` — `git ls-files -z --cached --others
    --exclude-standard` with a fast-glob fallback outside git; deliberately **no
    size cap**.
  - `packages/core/src/engine/fingerprint.ts` — `ruleFingerprint`, `backendFingerprint`.
  - `packages/core/src/engine/cache-path.ts`, `cache-store.ts`.
  - `packages/typescript/src/parse-memo.ts` — content-keyed 64-entry LRU parsers
    shared by the ast-grep checks and the syntax backend.
- Four follow-ups: gates green + defects, CI no longer rebuilding for publint/attw,
  and two documents deprecating eight checks that oxlint implements better.

Their measured effect on this repo (203 files, 3 per-file rules, TS backend):
cold **~684 ms** (was ~22 s), warm **~119 ms** (was ~1.0–1.5 s), one-file edit
**~124 ms**.

### What `main` contains that the branch does not

`git log --oneline origin/netzwerk..main` — 14 commits, the relevant ones:

- `36ee4e1` coordination: `engine/run-lock.ts`, `engine/run-lock-files.ts`,
  `engine/file-set.ts`, CLI wiring, notices, envelope block, two-process test.
- `5293d94` `--files` work reduction: `backend/request-scope.ts`, `requestedPaths`
  on the project-rule context, rule dropping.
- `36ee4e1` adapter scoping: `scopedPatterns` + the `examinedPaths` contract
  (successful on netzwerk's marker store, which no longer exists — see Phase 4).
- `f049b4a` test scoping: `backend/test-scope.ts` + the vitest adapter.
- `0fca650` file-set invalidation fixed by compiling existence checks as project
  rules — the same property Phase 2 re-establishes in the new engine.
- `1998ae5`, `6f8f52f`, `2d0d63f`, `eac3c09`, `d453d41` — test coverage for every
  source file, formatting gate, three other defect classes.

### The three fail-open classes this plan must not lose

1. **Existence checks vs the path set.** `requireTest`/`requireSibling`/
   `requireChildren` ask the filesystem. Cached against file content alone, adding
   the missing file leaves the violation in place forever. The branch folds
   `allPaths` into the `rules` scope fingerprint, which is correct but recomputes
   every per-file result on every add. Phase 2 re-establishes correctness *and*
   cost.
2. **An adapter that examined only some files.** Its result must never be cached
   as though it covered the project, or a violation in a file nobody looked at
   disappears. Phase 4 keys the cache entry by the examined set.
3. **`--files` hiding a mark it did not compute.** Skipping a file must leave its
   cached result alone, never store an empty one. Phase 3 pins this.

### Why this is expected to help immocore, and by how much

Baseline measured in the immocore worktree (see `BASELINE.md`, Phase 0):

| | measured |
|---|---|
| cold scan (nothing cached) | 52.7 s quiet, 150.7 s loaded |
| warm scan (nothing changed) | 7.8–8.7 s |
| netzwerk alone (no extensions, no parsing) | 8.0 s cold / 4.4 s warm |
| `vitest run --project unit` | 56.2 s whole, **10.8 s** for one test file |
| `oxlint` over `immoui/src` | 3.8 s whole, **0.5 s** scoped to 14 files |
| one tree walk over 9,247 files | 3.5 s |
| `bun x gesetz` startup | 1.6 s |

Hypothesis to verify in Phase 7, not to assume: after Phases 1–6, a one-file edit
should cost **a few seconds** (read+hash 717 MB is ~1.6 s; one file re-checked; the
test file's tests only), a cold scan should be **under ~20 s** (one parse per file
instead of ~7), and three concurrent agents should cost **one** run in total. The
report must show measured numbers, not this table.

---

## Scope

**In scope (exact paths):**

*Phase 0*
- `.plans/adopt-built-in-cache/BASELINE.md` (create)
- `pnpm-workspace.yaml` (remove the temporary netzwerk override)
- `package.json` (only if the netzwerk dependency lingers)

*Phase 1*
- The whole working tree, as the merge requires. `packages/netzwerk/**` is out.

*Phase 2*
- `packages/core/src/engine/rule.ts` (`Check.needsFileSet`)
- `packages/core/src/primitives/checks/fs.ts`
- `packages/core/src/engine/runner.ts`
- `packages/core/src/engine/fingerprint.ts`
- `packages/core/tests/engine/**` (new and existing)

*Phase 3*
- `packages/core/src/backend/request-scope.ts` (port from `main`)
- `packages/core/src/cache/kernel.ts` + `types.ts` (the `KEEP_STORED` sentinel)
- `packages/core/src/engine/runner.ts`
- `packages/cli/src/check.ts`, `packages/cli/src/check-coordination.ts`
- `packages/core/tests/**`, `packages/cli/tests/**`

*Phase 4*
- `packages/core/src/engine/rule.ts`, `runner.ts`, `fingerprint.ts`
- `packages/oxfmt/src/adapter.ts`, `packages/oxlint/src/adapter.ts`,
  `packages/eslint/src/adapter.ts`, `packages/prettier/src/adapter.ts`,
  `packages/phpstan/src/adapter.ts` + their tests
- `packages/core/src/engine/tool-patterns.ts` (port `scopedPatterns` from `main`)

*Phase 5*
- `packages/core/src/engine/run-lock.ts`, `run-lock-files.ts`, `file-set.ts`
  (port from `main`), `packages/core/tests/engine/run-lock*.test.ts`
- `packages/cli/src/main.ts`, `check.ts`, `check-coordination.ts`, `storage.ts`,
  `watch.ts`, `packages/cli/src/envelope.ts` + tests

*Phase 6*
- `packages/core/src/backend/test-scope.ts` (port from `main`)
- `packages/vitest/src/adapter.ts` + tests
- `packages/php/src/parse-memo.ts` (create), `packages/php/src/syntax-backend.ts`,
  `packages/php/src/checks.ts`

*Phase 7*
- `.plans/adopt-built-in-cache/BASELINE.md` (append results)
- `README.md`, `packages/cli/src/skill.ts`, `CHANGELOG.md` (final docs pass)

**Out of scope:**

- `packages/netzwerk/**` and `~/dev/fabrik/netzwerk` — that repo keeps the two
  storage fixes already committed there (`2099e9a`, `a64a37f`); they are moot once
  this plan lands and must not be reverted or extended.
- Any edit inside the immocore worktree. Read and run only.
- `packages/vitest/src/adapter.ts`'s report-file behaviour (already on `main`,
  `1a1a2be`) — port it as it is; do not redesign it.
- Netzwerk-era modules that the branch deleted. Do not resurrect them:
  `packages/core/src/backend/compile.ts`, `compile-shared.ts`,
  `project-violations.ts`, `syntax-extension.ts`, `violation-markers.ts`,
  `check-services.ts` (the netzwerk one; the branch's `services/check-services.ts`
  is a different, kept file).
- Parallel parsing with worker threads, and an mtime fast path in the cache
  (Phase 8, deferred).

**Forbidden actions (do not do these under any circumstances):**

- Do NOT push, and do NOT run `git commit`/`git merge`/`git push` — prepare and
  report; the user runs git.
- Do NOT weaken a test to make a phase pass. If a phase's test fails, the phase is
  not done.
- Do NOT add a dependency. The point of the branch is that gesetz has none beyond
  `effect`, `fast-glob`, `micromatch` (+ `oxc-parser`/`@ast-grep/napi` already
  present).
- Do NOT change the CLI's stdout data contract except the additive `coordination`
  key described in Phase 5.
- Do NOT re-add `files: allPaths` to the `rules` scope fingerprint "because it was
  simpler" — Phase 2 removes it deliberately and its test proves the replacement.
- Do NOT bump `SCHEMA_VERSION`/`user_version` of the adopted store as a shortcut
  for invalidation. Change the scope fingerprint version (`v: 2` → `v: 3`) instead.

---

## Acceptance criteria

```bash
# Phase 1 — the merge is coherent and every gate passes on it.
pnpm typecheck && pnpm test && pnpm dogfood
# Expected: exit 0 each; dogfood 0 violations, every category 10.

# Phase 2 — adding a file no longer re-checks content-pure rules.
pnpm --filter @gesetz/core test -- file-set-invalidation
# Expected: PASS, including "reprocesses only the files the file-system rules
# cover, and leaves content-pure rules alone".

# Phase 2 — the existence check still reacts to the file set.
pnpm --filter @gesetz/core test -- require-existence
# Expected: PASS: the violation disappears when the sibling appears and returns
# when it is deleted.

# Phase 3 — a scoped run does less work and does not wipe the cache.
pnpm --filter @gesetz/core test -- request-scope
pnpm --filter @gesetz/cli test -- file-scope
# Expected: PASS: a rule that cannot match the request never runs (observed by a
# side effect); the entries of files outside the request are still present after
# the scoped run.

# Phase 4 — a scoped adapter result never stands in for a full one.
pnpm --filter @gesetz/core test -- project-rule-scoping
pnpm --filter @gesetz/oxfmt test && pnpm --filter @gesetz/oxlint test
# Expected: PASS, including "a scoped entry and a full entry coexist".

# Phase 5 — two processes in one worktree share one run.
pnpm --filter @gesetz/cli test -- coordination
# Expected: PASS: one `ran`, one `reused`; and `--standalone` runs both.

# Phase 6 — the runner executes only the tests that cover the files in play.
pnpm --filter @gesetz/vitest test
# Expected: PASS, including the scoping cases.

# Phase 7 — the number the user asked for, in immocore.
cd /Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
time node node_modules/@gesetz/cli/dist/main.js check --format=json
# Expected: an envelope on stdout, a `scan:` line on stderr, no crash. Wall clock
# and the scan line recorded in BASELINE.md against the baseline above.
```

---

## Architecture

### The merged engine

```
runAll(config, options)                        packages/core/src/engine/runner.ts
  │
  ├─ listProjectFiles(root)          git ls-files … / fast-glob   (discovery.ts)
  ├─ candidateFileRefs(paths, config)  files any per-file rule covers, minus changedSince
  │
  ├─ PER-FILE RULES  ── one cache scope `rules`, one entry per file
  │     fingerprint = v3 + backendFingerprint + [rule id, ruleFingerprint]
  │                   (NO path set — Phase 2 removes it)
  │     compute(file) = { [ruleId]: Violation[] }  — file-major: the file is parsed
  │                     at most once and every applicable rule runs against it
  │
  ├─ FILE-SYSTEM RULES (Phase 2) ── routed through the project path, one entry per
  │     rule, keyed by the content hashes of the files it covers, so an
  │     add/remove/rename recomputes it and an edit does not. The check itself
  │     parses nothing: it asks `fs.exists` over the discovered path list.
  │
  ├─ PROJECT RULES (adapters, architecture, cycles) ── one cache entry per rule,
  │     key = hash([path, contentHash] of covered files) — plus the examined set
  │     when the rule reports one (Phase 4)
  │
  └─ aggregation: exemptions → --files filter → --since filter → scores → result
```

### Coordination sits on top, unchanged

`coordinateRun` wraps a whole `runAll` call and is engine-agnostic: it keys a run
record by the tree state (paths + `mtimeNs:size`) and the request key, so it works
the same over the new engine. Records live in `<root>/.gesetz/coord/`; the adopted
engine's cache lives in `~/.cache/gesetz/cache.db` namespaced per project root, so
two worktrees share a cache *file* but never a record.

### The four invalidation rules, stated once

1. Content changed → that file's per-file results recompute (hash mismatch).
2. Rule or backend changed → its scope's fingerprint changes → that scope recomputes.
3. File added/removed/renamed → **file-system rules** recompute (they are keyed by
   the covered path set); content-pure rules do not.
4. `--files` request → rules that cannot match are not compiled, non-requested
   files keep their stored entries (`KEEP_STORED`), and the report is filtered.

---

## Phases & tasks

### Phase 0: Prepare, and record the baseline to beat

This phase writes down what "faster" means before any code moves, and parks the
temporary wiring from the previous session.

#### Task 0.1: Remove the temporary netzwerk override

**Why:** the override linked netzwerk from a local checkout so its storage fixes
were live. The new engine removes netzwerk entirely, so the override must not
survive the merge.

**Files:**
- Modify: `pnpm-workspace.yaml`

**Steps:**

- [ ] **Step 1:** Confirm the override is there.
      ```bash
      grep -n "overrides" -A 3 pnpm-workspace.yaml
      ```
      Expected: an `overrides:` block with `netzwerk: link:../netzwerk/packages/netzwerk`
      and the comment above it.
- [ ] **Step 2:** Delete that block and the comment.
- [ ] **Step 3:** Reinstall and confirm netzwerk no longer resolves into the local checkout.
      ```bash
      pnpm install
      readlink packages/core/node_modules/netzwerk 2>/dev/null || echo "no netzwerk link (expected after Phase 1)"
      ```
- [ ] **Step 4:** Leave the tree uncommitted; the user commits. Report it.

#### Task 0.2: Record the baseline

**Why:** Phase 7 asserts an improvement. Without a baseline recorded on the same
machine, in the same repo, the assertion is a story.

**Files:**
- Create: `.plans/adopt-built-in-cache/BASELINE.md`

**Steps:**

- [ ] **Step 1:** Write the file with the table from *Context* above (both the
      immocore numbers and the branch's own 203-file numbers).
- [ ] **Step 2:** Re-measure the two cheap ones on `main` to confirm they still hold,
      with the cache redirected so the worktree is not written to:
      ```bash
      W=/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
      cd "$W" && GESETZ_DB=/tmp/gesetz-baseline.db /usr/bin/time -p node node_modules/@gesetz/cli/dist/main.js check --category=__none__ --standalone 2>&1 | grep -E "^scan:|^real"
      ```
      Expected: a `scan:` line with `=9247 reused` and a `real` under 20 s.
      Record it. If it crashes, record the crash — that is part of the baseline.
- [ ] **Step 3:** Append a "to beat" list, exactly these three numbers: a one-file
      edit's wall clock, a cold run's wall clock, and the number of scans observed
      when three checks run concurrently.

---

### Phase 1: Merge the branch, keeping the new engine

#### Task 1.1: Create the integration branch and merge

**Why:** the merge is the adoption; everything after it is porting.

**Files:**
- Modify: the whole tree (merge commit)

**Steps:**

- [ ] **Step 1:** Make sure the working tree holds only Task 0.1's change, then ask
      the user to commit it. Do not commit yourself.
- [ ] **Step 2:** Fetch the branch (refs only).
      ```bash
      git fetch origin netzwerk:refs/remotes/origin/netzwerk
      git log --oneline -1 origin/netzwerk
      ```
      Expected: `a744d04 docs: deprecate eight checks that oxlint implements better`.
- [ ] **Step 3:** Ask the user to create the branch, then merge:
      ```bash
      git checkout -b cache-engine origin/netzwerk
      git merge main
      ```
      Expected: conflicts in roughly the files listed below. **Do not** resolve them
      by choosing one side wholesale.

- [ ] **Step 4:** Resolve conflicts with this policy, file group by file group:

      | conflicting path(s) | resolution |
      |---|---|
      | `packages/core/src/backend/compile.ts`, `compile-shared.ts`, `project-violations.ts`, `syntax-extension.ts`, `violation-markers.ts`, `check-services.ts`, `packages/core/tests/backend/{compile,netzwerk-smoke,syntax-extension,violation-markers,check-services}.test.ts` | **take the deletion** (the branch removed them; the new engine replaces them). Their behaviour is re-established in Phases 2–4 by different means. Do not resurrect. |
      | `packages/core/src/engine/runner.ts`, `rule.ts`, `fingerprint.ts`, `discovery.ts`, `cache/**`, `services/**`, `packages/core/src/cache/**` | **take the branch** (theirs). |
      | `packages/core/src/index.ts` | **start from theirs**, then re-add exports for the modules Phase 3–6 port (`request-scope`, `test-scope`, `run-lock`, `file-set`, `tool-patterns`'s `scopedPatterns`). |
      | `packages/cli/src/main.ts`, `check.ts`, `check-coordination.ts`, `storage.ts`, `watch.ts`, `format.ts`, `envelope.ts`, `load-config.ts` | **start from theirs**, then Phase 5 re-applies main's orchestration. |
      | the ten `packages/*/src/adapter.ts` | **take the branch's shape**, then Phase 4/6 re-apply scoping. |
      | `gesetz.config.ts` | **theirs**, then re-add main's `testing`/`formatting` thresholds of 10 and the three types-only exclusions from `main`'s version. |
      | `README.md`, `CHANGELOG.md`, `UPGRADE.md`, `packages/core/TESTING.md` | **theirs**, then Phase 7 appends main's coordination and `--files` sections. |
      | every `package.json` / `pnpm-lock.yaml` | **theirs** (netzwerk and its transitive deps are gone). |
      | `packages/core/tests/**`, `packages/cli/tests/**` | **both**: keep main's new test files, drop main's tests of deleted modules. |
      | `.github/workflows/ci.yml` | **theirs**. |

- [ ] **Step 5:** Confirm no netzwerk reference survives.
      ```bash
      git grep -n "netzwerk" -- '*.ts' '*.json' '*.yaml' | grep -v "^\.plans" | head
      git grep -n "from 'netzwerk'\|from \"netzwerk\"" | head
      ```
      Expected: no output (except possibly `packages/sqlite-compat`'s `better-sqlite3`
      mention, which is unrelated).

#### Task 1.2: Get the merged tree green

**Why:** every later phase compares against a passing baseline.

**Steps:**

- [ ] **Step 1:** Run the gates and fix what the merge broke.
      ```bash
      pnpm install && pnpm typecheck && pnpm test && pnpm dogfood
      ```
      Expected: typecheck clean; tests pass once main's dead-module tests are removed;
      dogfood 0 violations.
- [ ] **Step 2:** For every test that existed on `main` and tested a deleted module,
      delete the test **and** record it in the session log with one line saying what
      property it protected and which phase re-establishes it (Phases 2–4 name them).
      Do not delete a test without recording this.
- [ ] **Step 3:** Format and re-run the gates.
      ```bash
      pnpm format && pnpm typecheck && pnpm test && pnpm dogfood
      ```

---

### Phase 2: Invalidation — content-pure rules stay untouched when files appear

**Why this is the phase that makes immocore fast.** The adopted engine folds the
whole project path set into the `rules` scope fingerprint
(`packages/core/src/engine/runner.ts`, `scopeFingerprint`): a single added file
recomputes every per-file rule for all 9,247 files, re-parsing 6,929 of them. That
is correct but unaffordable in a repo where agents create files continuously.

#### Task 2.1: Port the file-system marker for checks

**Why:** the engine must know which checks actually read the file listing, or it can
only choose between "always recompute" and "serve stale".

**Files:**
- Modify: `packages/core/src/engine/rule.ts` (add to `Check`),
  `packages/core/src/primitives/checks/fs.ts`
- Test: `packages/core/tests/primitives/checks/fs.test.ts`

**Steps:**

- [ ] **Step 1:** Add the marker to `Check`, exactly as `main` has it
      (`git show main:packages/core/src/engine/rule.ts` — the `needsFileSet` block on
      the `Check` type). Copy the doc comment as written; it explains the trade-off.
- [ ] **Step 2:** Set it in the three checks that read the file system, exactly as
      `main` does: `requireTest`, `requireSibling`, `requireChildren` in
      `packages/core/src/primitives/checks/fs.ts` (`git show main:packages/core/src/primitives/checks/fs.ts`
      — `check.needsFileSet = true; return check;`).
- [ ] **Step 3:** Add a test asserting the marker is present on all three and absent
      on a pure check.
      ```bash
      pnpm --filter @gesetz/core test -- checks/fs
      ```
      Expected: PASS.

#### Task 2.2: Route file-system rules through the project path, and drop the path set

**Why:** it removes the path set from the shared fingerprint without changing the
kernel: the project path already keys a rule's entry by the content hashes of the
files it covers, so add/remove/rename recomputes it and an edit does not.

**Files:**
- Modify: `packages/core/src/engine/runner.ts`
- Test: `packages/core/tests/engine/file-set-invalidation.test.ts` (create)

**Steps:**

- [ ] **Step 1:** Split rules by the marker, next to the existing split.
      ```ts
      const perFileRules = config.rules.filter((rule) => rule.perFile !== undefined);
      const fsRules = perFileRules.filter((rule) => ruleReadsFileSystem(rule));
      const contentRules = perFileRules.filter((rule) => !ruleReadsFileSystem(rule));
      const projectRules = config.rules.filter((rule) => rule.perFile === undefined);
      // File-system rules join the project pass: one entry each, keyed by the
      // content hashes of the files they cover, so an add/remove/rename recomputes
      // it while an edit does not — and the check parses nothing.
      const rulePasses = [...projectRules, ...fsRules];
      ```
      with, in the same file:
      ```ts
      /**
       * True when any of a rule's checks asks the file system, rather than being a
       * function of its own file.
       *
       * Such a rule cannot be cached against file content: `requireTest` asks
       * whether a test file *exists*, so adding it changes the answer without
       * touching the source. These rules run in the project pass instead, which is
       * keyed by the set of files the rule covers.
       */
      function ruleReadsFileSystem(rule: Rule): boolean {
        const checks = rule.perFile?.checks;
        if (checks === undefined || checks.length === 0) return false;
        return checks.some((check) => check.needsFileSet === true);
      }
      ```
- [ ] **Step 2:** Execute `fsRules` in the project pass. They have no `run` Effect
      (they are built by `select(...).check(...)`), so give the pass a branch:
      ```ts
      for (const rule of rulePasses) {
        const perFile = rule.perFile;
        if (perFile !== undefined) {
          const relevant = candidates.filter((file) => matchesPerFile(file.path, perFile));
          const projectHash = hashValue(
            relevant.map((file) => [file.path, synced.hashes.get(file.path) ?? '']),
          );
          const fingerprint = ruleFingerprint(rule);
          const cached = await store.get<Violation[]>(rule.id, PROJECT_KEY);
          if (
            cached !== undefined &&
            cached.hash === projectHash &&
            cached.meta?.['fingerprint'] === fingerprint
          ) {
            violationsByRule.set(rule.id, cached.value);
            continue;
          }
          const violations = await runFileSystemRule(rule, relevant, services, config.projectRoot);
          await store.put(rule.id, PROJECT_KEY, {
            hash: projectHash,
            value: violations,
            meta: { fingerprint },
          });
          violationsByRule.set(rule.id, violations);
          continue;
        }
        // …existing project-rule branch, unchanged
      }
      ```

      and, as a free function in `runner.ts` (it is the per-file check loop, run
      over a whole rule's file set instead of one file at a time):

      ```ts
      /**
       * Runs a rule whose checks consult the file system, over the files it covers.
       *
       * This is the project pass rather than the per-file cache because the answer
       * depends on more than one file: `requireSibling` asks whether *another* file
       * exists. The project pass is keyed by the covered path set, so an
       * add/remove/rename recomputes it while an edit does not — and the checks
       * parse nothing, so recomputing is cheap.
       */
      async function runFileSystemRule(
        rule: Rule,
        relevant: readonly FileRef[],
        services: CheckServices,
        rootDir: string,
      ): Promise<Violation[]> {
        const perFile = rule.perFile;
        if (perFile === undefined) return [];
        const runChecks = await makeCheckRunner(services);
        const violations: Violation[] = [];
        for (const reference of relevant) {
          const content = await readFileSafe(reference.absolutePath);
          if (content === null) continue;
          const file = fileFromRef(reference, content);
          if (!perFile.predicates.every((predicate) => predicate(file))) continue;
          violations.push(...(await runChecks(rule, file)));
        }
        return violations;
      }
      ```

      `makeCheckRunner` is the existing per-file loop (the one the per-file `compute`
      already uses) extracted so both passes share it, including its contract that a
      throwing check is reported rather than silently contributing nothing. If the
      adopted runner's check loop is inline inside `compute`, extract it in this task
      and have both callers use it.
- [ ] **Step 3:** Delete `files: allPaths` from `scopeFingerprint` and bump its version.
      ```ts
      const scopeFingerprint = hashValue({
        v: 3,
        backends: backendFingerprint(config.adapters),
        rules: contentRules.map((rule) => [rule.id, ruleFingerprint(rule)]),
      });
      ```
      Update the comment above it: it currently explains why the path set is folded
      in; replace it with the reason it is not, naming the project pass as the place
      the file-set dependency now lives.
- [ ] **Step 4:** Write `packages/core/tests/engine/file-set-invalidation.test.ts` with
      three tests, all of which must fail before Step 3 and pass after:
      1. Adding `src/a.test.ts` clears `requireTest`'s violation for `src/a.ts`, and
         deleting it brings the violation back.
      2. Adding a file does **not** recompute a content-pure rule. Prove it by
         counting invocations: a check that appends to an array; after a second run
         with an added file, the array must be unchanged (the file it ran for was
         reused).
      3. The `rules` scope fingerprint does not change when a file is added: read
         the store's entries before and after and assert the same `meta.fingerprint`
         for a reused file.
      ```bash
      pnpm --filter @gesetz/core test -- file-set-invalidation
      ```
      Expected: PASS after Step 3; (1) fails before it, (2) fails before it.
- [ ] **Step 5:** Prove (2) fails without the change: temporarily re-add `files: allPaths`
      to the fingerprint, run the test, confirm failure, revert. Record the observed
      failure message in the session log — this is the evidence the phase works.

---

### Phase 3: `--files` that reduces work, on the new engine

**Why:** on `main`, `--files` was a report filter until today. The engine's
`fileFilter` is still exactly that ("Pure aggregation-time filter — the cache is
unaffected"). A caller asking about three files must not pay for nine thousand.

#### Task 3.1: The kernel's `KEEP_STORED` sentinel

**Why:** `sync()` prunes `scope` to the files it is handed. Narrowing the list for a
scoped run therefore *deletes every other file's cached result* — a `--files` run
would wipe the cache it intends to use. The sentinel lets a run say "no result for
this file this time; leave the stored entry alone".

**Files:**
- Modify: `packages/core/src/cache/kernel.ts`, `packages/core/src/cache/index.ts`,
  `packages/core/src/cache/types.ts`
- Test: `packages/core/tests/cache/kernel.test.ts` (it already exists on the
  branch — extend it, do not replace it)

**Steps:**

- [ ] **Step 1:** Export the sentinel and honour it in the compute phase.
      ```ts
      /**
       * Returned by `compute` to mean "I did not compute a value for this file;
       * leave whatever is stored for it alone."
       *
       * `sync` prunes a scope to the files it is given, so a caller that narrows the
       * list — a `--files` run — would otherwise delete the entries of every file it
       * skipped, and store an empty result for the ones it looked at. Neither is
       * acceptable: the entry of a skipped file is still valid (its content did not
       * change), and an empty result would be indistinguishable from "clean".
       */
      export const KEEP_STORED: unique symbol = Symbol('gesetz.cache.keep-stored');
      export type ComputeResult<Value> = Value | typeof KEEP_STORED;
      ```
      In the compute loop: when the result is `KEEP_STORED`, do not `store.put`, and
      if a `previous` entry exists, `values.set(file.path, previous.value)`; the file
      is already in `keep`, so `prune` leaves it alone.
- [ ] **Step 2:** Change `SyncOptions.compute` to `Promise<ComputeResult<Value>>`.
- [ ] **Step 3:** Test it, and make the test fail without the change:
      - a `sync` over `files: [a, b]` stores both;
      - a second `sync` over `files: [a]` whose `compute` returns `KEEP_STORED` for
        `a` leaves **both** `a`'s and `b`'s entries in the store (today `b` is pruned);
      - a `sync` that returns a real value still overwrites.
      ```bash
      pnpm --filter @gesetz/core test -- cache/kernel
      ```
      Expected: PASS.

#### Task 3.2: Rules that cannot match are not run

**Files:**
- Create: `packages/core/src/backend/request-scope.ts` (port `git show main:packages/core/src/backend/request-scope.ts`
  verbatim: `expandRequest`, `rulesForRequest`; do not port `requestedPathsFor`, which
  `main` deleted)
- Modify: `packages/core/src/engine/runner.ts`, `packages/core/src/engine/rule.ts`
- Test: `packages/core/tests/backend/request-scope.test.ts` (port from `main`)

**Steps:**

- [ ] **Step 1:** Port the module and its tests, adjusting imports to the new tree
      (`listFiles` does not exist here — use the engine's `listProjectFiles`/`allPaths`
      as the path source: change `expandRequest(rootDir, globs)` to
      `expandRequest(paths, globs)` and update the test accordingly).
- [ ] **Step 2:** In `runAll`, when `fileFilter` is set and non-empty:
      ```ts
      const requestedPaths = fileFilterActive ? expandRequest(allPaths, fileFilter) : null;
      const activeRules =
        requestedPaths === null ? config.rules : rulesForRequest(config.rules, requestedPaths);
      ```
      and use `activeRules` for the per-file split, the project pass, and the final
      `config.rules.map(...)` aggregation (so a dropped rule reports nothing rather
      than an empty result *and* does not run).
- [ ] **Step 3:** Hand the request to the rule passes. Add to the context passed to
      project rules (`executeProjectRule`) and to `CandidateFileRefs` consumers:
      ```ts
      requestedPaths: requestedPaths ?? null,
      ```
      and add to `ProjectRuleContext` in `engine/rule.ts`:
      ```ts
      /**
       * Repo-relative paths the caller asked about (`--files`), or null when the run
       * was not scoped. A rule that hands paths to an external tool hands it these.
       */
      readonly requestedPaths?: readonly string[] | null | undefined;
      ```
- [ ] **Step 4:** Skip non-requested files *without losing their entries*. In the
      per-file `compute`:
      ```ts
      compute: async (reference, source) => {
        if (requestedPaths !== null && !requestedPaths.includes(reference.path)) {
          // Not this run's business. Its stored entry stays as it is: if the content
          // did not change it is still correct, and if it did the hash no longer
          // matches, so the next run that includes the file recomputes it. Storing an
          // empty result here would erase a violation nobody looked at.
          return KEEP_STORED;
        }
        // …existing body
      }
      ```
- [ ] **Step 5:** Tests: port `main`'s `tests/engine/file-filter.test.ts` and add the
      two properties specific to this engine:
      - a rule that cannot match the request is never invoked (count invocations);
      - after a scoped run, the store still holds entries for files outside the
        request (read `store.entries('rules')` before and after).
      ```bash
      pnpm --filter @gesetz/core test -- file-filter request-scope
      ```
      Expected: PASS.

#### Task 3.3: `--files` on the command line

**Files:**
- Modify: `packages/cli/src/check.ts` (port `main`'s `parseFileRequest` and the
  repeatable option; `git show main:packages/cli/src/check.ts`)
- Test: `packages/cli/tests/check.test.ts` (port the `parseFileRequest` cases),
  `packages/cli/tests/file-scope.test.ts` (port `main`'s file, adapting the config
  fixture to the new `defineConfig` shape)

**Steps:**

- [ ] **Step 1:** Make the flag repeatable and comma-separated, exactly as `main`
      does (`Options.repeated` + `parseFileRequest`).
- [ ] **Step 2:** Run the ported CLI test that proves work reduction by side effect
      (a rule that appends to a file when it runs).
      ```bash
      pnpm --filter @gesetz/cli test -- file-scope
      ```
      Expected: PASS: the non-requested rule's marker file is never written.

---

### Phase 4: Adapters check only what changed, without erasing what they did not

**Why:** on immocore, `oxlint` over the whole `immoui/src` is 3.8 s where the 14
requested files take 0.5 s, and `oxfmt` similar. Scoping is only safe if the cached
result records what it examined.

#### Task 4.1: The examined set is part of the project cache key

**Why:** a project rule's result is cached under one key per rule. A run that
examined three files must not write an entry that a later full run reads as "the
project is clean".

**Files:**
- Modify: `packages/core/src/engine/rule.ts`, `packages/core/src/engine/runner.ts`
- Test: `packages/core/tests/engine/project-rule-scoping.test.ts` (port and adapt
  `main`'s file)

**Steps:**

- [ ] **Step 1:** Let a project rule report what it examined, as `main` does.
      ```ts
      export type ProjectRuleOutcome = readonly Violation[] | ProjectRuleResult;
      export interface ProjectRuleResult {
        readonly violations: readonly Violation[];
        /** The paths this run examined. Absent means the whole project. */
        readonly examinedPaths?: readonly string[] | undefined;
      }
      ```
      `ProjectRuleContext`'s `network`-less shape is unchanged: the branch already
      passes `{ rootDir, changedFiles }`; add `requestedPaths` (Task 3.2) and a
      `files` accessor for the examined set comparison if the adapter needs one.
- [ ] **Step 2:** Fold the examined set into the project entry's key.
      ```ts
      const examined = 'violations' in execution.result ? execution.result.examinedPaths : undefined;
      const cacheHash = hashValue([
        ['project', projectHash],
        ['examined', examined === undefined ? null : [...examined].sort()],
      ]);
      ```
      Store `value: violations` and `hash: cacheHash`. A scoped run therefore writes
      its own entry; a later full run misses and computes its own. Neither overwrites
      the other, and a scoped result can never be served for an unscoped request.
- [ ] **Step 3:** Test exactly that, and make it fail without Step 2:
      - a rule that examines one file and returns no violations, followed by a full
        run, must still report the violation the full run finds in a second file.
      - the reverse order too.
      ```bash
      pnpm --filter @gesetz/core test -- project-rule-scoping
      ```
      Expected: PASS.

#### Task 4.2: The five file-independent adapters scope themselves

**Files:**
- Create: `packages/core/src/engine/tool-patterns.ts` addition —
  `scopedPatterns(changedFiles, toolPatterns)` ported from `main`
  (`git show main:packages/core/src/engine/tool-patterns.ts`)
- Modify: `packages/oxfmt/src/adapter.ts`, `packages/oxlint/src/adapter.ts`,
  `packages/eslint/src/adapter.ts`, `packages/prettier/src/adapter.ts`,
  `packages/phpstan/src/adapter.ts`
- Test: each package's `tests/adapter.test.ts`

**Steps:**

- [ ] **Step 1:** Port `scopedPatterns` and its tests. It returns **null** for "nothing
      to do", never `[]`, because a tool handed an empty list scans nothing and
      reports success — the fail-open shape this codebase keeps finding.
- [ ] **Step 2:** In each adapter's `project.run`, scope to the files in play and
      report what was examined, exactly as `main` does
      (`git show main:packages/oxfmt/src/adapter.ts` and its four siblings):
      ```ts
      run: (ctx) => {
        const wanted = ctx.requestedPaths ?? ctx.changedFiles;
        const scoped = scopedPatterns(wanted, defaultPatterns);
        if (scoped === null) return Promise.resolve({ violations: [], examinedPaths: [] });
        return executeTool(opts, id, bin, cwd, scoped).then((violations) => ({
          violations,
          examinedPaths: scoped,
        }));
      },
      ```
- [ ] **Step 3:** Port each adapter's scoping tests (argv contains only the scoped
      paths; the tool is not called at all when nothing matches; `examinedPaths` is
      reported).
      ```bash
      pnpm --filter @gesetz/oxfmt test && pnpm --filter @gesetz/oxlint test && pnpm --filter @gesetz/eslint test && pnpm --filter @gesetz/prettier test && pnpm --filter @gesetz/phpstan test
      ```
      Expected: PASS.

---

### Phase 5: Coordination, ported onto the new engine

**Why:** five agents in one worktree must cost one scan, and the waiting caller must
be able to tell whether a result covers its edits.

#### Task 5.1: Port the coordination primitive

**Files:**
- Create: `packages/core/src/engine/run-lock.ts`, `run-lock-files.ts`, `file-set.ts`
  (all three: `git show main:<path>` — copy verbatim; they import nothing from the
  engine except `treeStateFor`/`listFiles`, which `file-set.ts` itself provides)
- Create: `packages/core/tests/engine/{run-lock,run-lock-files,file-set}.test.ts`
  (port from `main`)
- Modify: `packages/core/src/index.ts` (export the surface, as `main` does)

**Steps:**

- [ ] **Step 1:** Copy the three modules and their tests unchanged.
- [ ] **Step 2:** `file-set.ts` walks the tree for mtime+size. It must keep skipping
      `.gesetz`, `.git`, `dist`, `node_modules` (see `NEVER_SOURCE`). Leave it as is.
- [ ] **Step 3:** Run the ported tests.
      ```bash
      pnpm --filter @gesetz/core test -- run-lock
      ```
      Expected: PASS (29 tests).

#### Task 5.2: Port the CLI wiring, notices, flags and envelope field

**Files:**
- Create: `packages/cli/src/check-coordination.ts`, `storage.ts` (port from `main`)
- Modify: `packages/cli/src/check.ts` (`requestKeyFor` usage, `coordinateRun` call,
  `describeCoordination` notice, the three flags, env knobs),
  `packages/cli/src/envelope.ts` (the additive `coordination` block),
  `packages/cli/src/main.ts`, `packages/cli/src/watch.ts`
- Test: `packages/cli/tests/{check-coordination,storage,watch}.test.ts` (port from `main`)

**Steps:**

- [ ] **Step 1:** Port the modules and tests verbatim.
- [ ] **Step 2:** Wire the check command, keeping `main`'s behaviour exactly:
      `--standalone`, `--jobs N` (`GESETZ_JOBS`), `--wait-timeout S`, `GESETZ_LOCK=off`,
      `--full` implying standalone; the `cache: <path> (runtime: <runtime>)` line;
      the `coord: …` notice on stderr; the `coordination` key in the JSON envelope.
- [ ] **Step 3:** Update `requestKeyFor` so the cache path in the key is the *new*
      storage shape (`{ kind: 'sqlite', path }` still exists; `kind` values are the
      same), and so a `--files` request is part of the key — `main` already does.
- [ ] **Step 4:** Run the two-process test.
      ```bash
      pnpm --filter @gesetz/cli test -- coordination
      ```
      Expected: PASS: one process reports `ran`, the other `reused`; with
      `--standalone` both run.
- [ ] **Step 5:** Note in the session log that the adopted cache is **one file shared
      across projects** (namespaced per project root), while coordination records are
      per worktree in `<root>/.gesetz/coord/`. Two worktrees therefore share a cache
      file but never a run record. If a future change makes records project-wide,
      revisit this.

---

### Phase 6: Test scoping, and a parse memo for PHP

**Why:** 56.2 s of the immocore run is the whole vitest suite, every time, whatever
`--files` says. And the parse memo the branch added covers TypeScript only — immocore
has 6,033 PHP files.

#### Task 6.1: Run only the tests that cover the files in play

**Files:**
- Create: `packages/core/src/backend/test-scope.ts` (port from `main`)
- Modify: `packages/vitest/src/adapter.ts` (`testsToRun` + `examinedPaths`, the
  `testSuffixes` option)
- Test: `packages/core/tests/backend/test-scope.test.ts` (port), `packages/vitest/tests/adapter.test.ts`

**Steps:**

- [ ] **Step 1:** Port `testFilesForPaths` and its tests unchanged.
- [ ] **Step 2:** Port the vitest adapter's scoping exactly as `main` has it: map the
      files in play to their test files, run `vitest` with those paths, report
      `examinedPaths`; return `null` (skip the runner) when no test covers them.
- [ ] **Step 3:** Keep the report-file behaviour (`--outputFile=`, from `main`'s
      `1a1a2be`) and its stubs.
      ```bash
      pnpm --filter @gesetz/vitest test
      ```
      Expected: PASS (14 tests).

#### Task 6.2: A parse memo for PHP

**Why:** file-major execution already means one parse per file for the checks, but
the syntax backend parses again for its extractors. TypeScript has
`packages/typescript/src/parse-memo.ts` for this; PHP does not, and immocore's cold
scan is 6,033 PHP files.

**Files:**
- Create: `packages/php/src/parse-memo.ts` (mirror
  `packages/typescript/src/parse-memo.ts`, using the PHP ast-grep language)
- Modify: `packages/php/src/syntax-backend.ts`, `packages/php/src/checks.ts` (route
  their parses through the memo)
- Test: `packages/php/tests/parse-memo.test.ts` (create)

**Steps:**

- [ ] **Step 1:** Read the TypeScript memo and mirror it: content+extension keyed,
      64-entry LRU, `parse` and `parseSync` entry points as needed.
- [ ] **Step 2:** Route the PHP backend and check helpers through it. Do not change
      what they extract.
- [ ] **Step 3:** Test that the same content parses once (count parser invocations),
      that `.php` and any other extension are distinct keys, and that the cache stays
      bounded:
      ```bash
      pnpm --filter @gesetz/php test
      ```
      Expected: PASS.

---

### Phase 7: Benchmark and verify in immocore

**Why:** the user's requirement is that this repo is fast and does not hog resources
with several agents running. That is a measurement, not a claim.

**Do not edit anything in the immocore worktree.** Run commands, record output.

#### Task 7.1: Single-run benchmark

**Files:**
- Modify: `.plans/adopt-built-in-cache/BASELINE.md` (append the results)

**Steps:**

- [ ] **Step 1:** One edited file, warm cache — the common agent case.
      ```bash
      W=/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
      cd "$W" && GESETZ_DB=/tmp/gesetz-verify.db node node_modules/@gesetz/cli/dist/main.js check --format=json >/tmp/v1.out 2>/tmp/v1.err
      # then touch one file the immoui rules cover and run again, timed
      /usr/bin/time -p node node_modules/@gesetz/cli/dist/main.js check --format=json >/tmp/v2.out 2>/tmp/v2.err
      grep -E "^scan:|^coord:|^cache:" /tmp/v2.err
      ```
      Expected: an envelope, a `scan:` line showing most files reused, and no crash.
      Record wall clock, scan duration, and the reused/changed counts.
- [ ] **Step 2:** Scoped run — the request the user actually made.
      ```bash
      /usr/bin/time -p node node_modules/@gesetz/cli/dist/main.js check --files 'immoui/src/components/primitives/**' --format=json >/tmp/v3.out 2>/tmp/v3.err
      ```
      Expected: completes, reports only violations inside that directory, and the
      transcript shows the tools were handed few files. Record the wall clock and
      compare against the baseline's cold attempt (83.6 s, aborted).
- [ ] **Step 3:** Cold run, once, to record the worst case.
      ```bash
      rm -f /tmp/gesetz-cold.db* && GESETZ_DB=/tmp/gesetz-cold.db /usr/bin/time -p node node_modules/@gesetz/cli/dist/main.js check --format=json >/tmp/v4.out 2>/tmp/v4.err
      ```
      Expected: one full scan. Record the number; the hypothesis is under ~20 s.
- [ ] **Step 4:** Append a "measured after" table to `BASELINE.md` with all three plus
      the baseline column, and a one-line verdict per row.

#### Task 7.2: Several agents at once, and resource use

**Why:** the user's second requirement: "not completely hog resources … even when
multiple agents are running gesetz check".

**Steps:**

- [ ] **Step 1:** Launch three checks in one worktree, concurrently, with their own
      cache so the measurement is clean, and sample memory.
      ```bash
      W=/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
      cd "$W" && export GESETZ_DB=/tmp/gesetz-multi.db
      for i in 1 2 3; do ( /usr/bin/time -l node node_modules/@gesetz/cli/dist/main.js check --format=json >/tmp/m$i.out 2>/tmp/m$i.err ) & done
      sleep 3; ps -o pid,rss,pcpu,command -p $(pgrep -f "cli/dist/main.js check" | tr '\n' ',' | sed 's/,$//') | head -8
      wait
      grep -hE "^coord:|^scan:" /tmp/m*.err
      ```
      Expected: exactly one `scan:` line; one process reports `coord: ran` and the
      others `coord: reused`; no crash; peak RSS per process under ~250 MB (the CLI
      loads ast-grep and its parsers).
- [ ] **Step 2:** Repeat with `--standalone` to show the escape hatch still works and
      to confirm the cache survives concurrent writers (the adopted store writes
      single rows, so it should).
      ```bash
      for i in 1 2 3; do ( node node_modules/@gesetz/cli/dist/main.js check --standalone --format=json >/tmp/s$i.out 2>/tmp/s$i.err ) & done; wait
      grep -hE "^coord:|^scan:" /tmp/s*.err
      ```
      Expected: three scans, three `standalone` notices, no storage error.
- [ ] **Step 3:** Record both transcripts and the RSS line in `BASELINE.md`.

#### Task 7.3: Correctness diff against `main`

**Why:** the branch replaced netzwerk's multi-language import resolvers with a
relative-only default. Architecture and cycle rules could quietly lose edges — a
fail-open in the rules that guard the architecture.

**Steps:**

- [ ] **Step 1:** On `main`, with a fresh cache, capture the violations in immocore.
      ```bash
      W=/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
      cd "$W" && GESETZ_DB=/tmp/gesetz-main.db node node_modules/@gesetz/cli/dist/main.js check --format=json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(sorted((v['rule'], v['path'], v['line']) for v in d['violations']), indent=1))" >/tmp/main-violations.json
      ```
- [ ] **Step 2:** On `cache-engine`, the same.
      ```bash
      GESETZ_DB=/tmp/gesetz-engine.db node node_modules/@gesetz/cli/dist/main.js check --format=json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(sorted((v['rule'], v['path'], v['line']) for v in d['violations']), indent=1))" >/tmp/engine-violations.json
      diff /tmp/main-violations.json /tmp/engine-violations.json | head -40
      ```
      Expected: **no differences for architecture and cycle rules.** Differences in
      `--files`-filtered or adapter-scoped rules are expected and must be explained
      line by line in the session log.
- [ ] **Step 3:** If an architecture rule lost violations, stop and report it as an
      open question. Do not proceed to Phase 8. The two options are: accept and
      document (only if analysis shows the lost edges were unresolved externals), or
      implement PSR-4 and tsconfig-path resolvers in the PHP and TypeScript adapters
      with their own tests.

#### Task 7.4: Documentation pass

**Files:**
- Modify: `README.md`, `packages/cli/src/skill.ts`, `CHANGELOG.md`

**Steps:**

- [ ] **Step 1:** README: replace the netzwerk cache section with the new engine's —
      the XDG cache path, the fact that nothing needs gitignoring, and the measured
      numbers from Task 7.1. Keep the coordination and `--files` sections from `main`.
- [ ] **Step 2:** `skill.ts`: keep `main`'s `--files`/coordination guidance; update the
      `cache:` line description to the new path.
- [ ] **Step 3:** CHANGELOG: one entry per phase's user-visible effect, and an
      UPGRADE note that `.gesetz/cache.db` (and the old global netzwerk database in
      `~/.fabrik/netzwerk.db`, 159 MB, if present) can be deleted.

---

### Phase 8: Deferred, not in this plan

Written down so nobody improvises them mid-merge:

- **Parallel parsing** with worker threads. The engine's async `compute` would let
  work overlap, but ast-grep and oxc parsing are synchronous, so this needs a worker
  pool and a worker entry on `SyntaxBackend`. Do it only if Phase 7 shows a cold
  scan that is still too slow.
- **An mtime fast path** in `sync`/discovery: skip hashing a file whose mtime and
  size are unchanged (gesetz's own `treeStateFor` already does exactly this for
  coordination). Worth ~1.5 s per warm run in immocore; needs a documented ceiling.
- **Test scoping for pest, phpunit, bun-test, storybook** — same shape as Task 6.1,
  different tools.
- **`compileFileSetRule` candidates**: when a file is added, file-system rules
  currently re-examine every file they cover. Deriving candidates from the added
  path would make that a handful.

---

## Validation

```bash
# Every gate, from a clean build, on the merge branch.
pnpm install && pnpm typecheck && pnpm test && pnpm dogfood
# Expected: exit 0 each. dogfood: `gesetz: pass (0 violations)`, every category 10.

# No netzwerk left.
git grep -c "from 'netzwerk'" || echo "0 (expected)"
python3 -c "import json; print([k for k in json.load(open('packages/core/package.json'))['dependencies']])"
# Expected: ['effect', 'fast-glob', 'micromatch'] and nothing else.

# The three fail-open guards, each of which must fail without its fix.
pnpm --filter @gesetz/core test -- file-set-invalidation   # Phase 2
pnpm --filter @gesetz/core test -- file-filter             # Phase 3
pnpm --filter @gesetz/core test -- project-rule-scoping    # Phase 4

# Scoping reaches the tools.
pnpm --filter @gesetz/oxfmt test && pnpm --filter @gesetz/vitest test

# One run for several agents.
pnpm --filter @gesetz/cli test -- coordination

# The repository the user cares about.
cd /Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
time node node_modules/@gesetz/cli/dist/main.js check --format=json
# Expected: envelope, `scan:` line, no crash; numbers recorded in BASELINE.md.
```

---

## Risks & rollback

- **Risk: the merge resolves a conflict wrongly and quietly drops a property.**
  Likelihood: high (50+ conflicting files). Blast radius: large.
  **Mitigation:** the policy table in Task 1.4, plus Task 1.2's rule that every
  deleted test must be logged with the property it protected and the phase that
  re-establishes it. Phase 7.3's diff is the final check that no violation went
  missing.
- **Risk: a fail-open is reintroduced in the new engine's shape.** Likelihood:
  medium. Blast radius: high — this is a quality gate.
  **Mitigation:** the three named tests (`file-set-invalidation`, `file-filter`,
  `project-rule-scoping`), each demonstrated to fail without its fix. Do not proceed
  past a phase whose test passes only because it was weakened.
- **Risk: architecture rules lose edges** because netzwerk's resolvers are gone
  (PSR-4, tsconfig paths). Likelihood: medium-high in immocore. Blast radius: high.
  **Mitigation:** Task 7.3's diff is a gate, not a formality. If it differs, stop and
  report.
- **Risk: `KEEP_STORED` semantics leak** — a caller returns it by accident and a file
  is never stored. Likelihood: low. **Mitigation:** it is a unique symbol, not a
  value a caller produces; the kernel test covers the "still overwrites" case.
- **Risk: performance regresses somewhere unmeasured.** Likelihood: medium.
  **Mitigation:** Phase 7 records cold, warm, scoped, and three-concurrent numbers
  against a baseline written before any code moved (Phase 0).
- **Risk: the shared XDG cache confuses a multi-worktree setup.** Likelihood: low;
  entries are namespaced by project root and every statement carries the namespace.
  **Mitigation:** documented in Task 5.2 Step 5 and README.
- **Rollback:** everything happens on `cache-engine`; `main` is untouched. The merge
  is one commit: `git reset --hard <pre-merge-sha>` (or `git revert -m 1 <merge>`)
  restores the previous state. The adopted cache is additive: old `.gesetz/cache.db`
  and `~/.fabrik/netzwerk.db` files are simply orphaned — deleting them (with
  `trash`) is safe and frees space. No data migration in either direction.

---

## Open questions

- [ ] **Do immocore's own checks read the file system?** Phases 2 and 4 depend on the
      marker being set on every check that does. Audit the adopting repo before
      trusting its numbers:
      ```bash
      cd /Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger
      grep -rn "fs.exists\|fs.glob\|imports.resolve" gesetz/ immoui/gesetz/ | head -20
      ```
      Any rule found must set `Check.needsFileSet = true` (or be reported to the
      user as an open item, if it lives in a repo this plan may not edit). — needs
      decision from the user, because that repo is out of scope for edits.
- [ ] **Import resolution: accept relative-only, or port PSR-4/tsconfig resolvers?**
      — decide after Task 7.3's diff, with its evidence in hand.
- [ ] **Should coordination be on by default in the adopting repos?** It is on by
      default here; `--standalone`/`GESETZ_LOCK=off` opt out. — the user may prefer
      the opposite default for single-agent work. Current decision: on by default.

---

## Progress

**This section is maintained by the implementing agent. Update it continuously.**

### Phase completion

- [ ] Phase 0: Prepare, and record the baseline to beat
- [ ] Phase 1: Merge the branch, keeping the new engine
- [ ] Phase 2: Invalidation — content-pure rules stay untouched when files appear
- [ ] Phase 3: `--files` that reduces work, on the new engine
- [ ] Phase 4: Adapters check only what changed, without erasing what they did not
- [ ] Phase 5: Coordination, ported onto the new engine
- [ ] Phase 6: Test scoping, and a parse memo for PHP
- [ ] Phase 7: Benchmark and verify in immocore
- [ ] Phase 8: Deferred (not in scope)
- [ ] Validation complete
- [ ] Plan marked DONE

### Session log

*The implementing agent appends an entry here after each phase or working
session. Include: what was completed, what was skipped and why, what comes next,
and any decisions made (with rationale). This log is the handoff document — a
new agent reading only this file must be able to continue without asking.*

---
*(no entries yet)*
