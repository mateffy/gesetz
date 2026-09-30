# Brief: gesetz does not scale to a fleet of agents in one worktree

## What was observed

Twenty agents share one worktree and each runs a scoped check before reporting.
One of them ran this and it took **2,528 seconds**:

```bash
bun x gesetz check --files "app/Domains/API/Immoui/Matchmaking/Match/**" \
  --files "app/Domains/API/Immoui/Matchmaking/RentableSearch/**" \
  --files "app/Domains/Matchmaking/DTO/**" \
  --files "app/Domains/Matchmaking/Services/Queries/**" \
  --files "immoui/src/__tests__/**"
```

Two distinct problems came out of it. The first is fixed on `main` already (see
§1). The second and third are open and are the reason for this brief.

---

## 1. Fixed already: a scope that vitest could not read as a scope

`@gesetz/vitest` passed its `--files` scope straight to vitest:

```ts
if (patterns) args.push(...patterns);   // packages/vitest/src/adapter.ts
```

A PHP batch's scope is PHP paths, so vitest received
`../app/Domains/API/Immoui/Communication/`. **A positional pattern that matches
no test file does not make vitest run nothing — it falls back to the default
include and runs the entire suite.** Measured: `vitest run --project unit` with a
PHP pattern ran for **25 minutes** and was still going when it was killed.

Twenty agents doing that concurrently is most of the 2,528 seconds.

**Fixed** in `packages/vitest/src/adapter.ts`: patterns resolving outside
vitest's `cwd` are dropped, and when none survive the rule is **skipped**, not
widened. Verified: the same PHP-only scope went from 2,528 s to **70 s**.

The distinction matters, and getting it wrong is easy: returning `null` for
"no usable pattern" means "no pattern", which is the whole suite. The sentinel
return is deliberate.

---

## 2. OPEN: two scopes can never share a run, so the fleet serialises

`requestKeyFor` includes the file filter:

```ts
// packages/cli/src/check-coordination.ts
input.fileFilter === null ? null : input.fileFilter.slice().sort(),
```

So **every distinct `--files` scope is a different request key.**
`findReusableRecord` matches on that key and the tree state, so a run by agent A
is invisible to agent B whenever their scopes differ — which is always.

The result is that coordination does exactly one thing for a fleet: it
**serialises**. `jobs` defaults to 1 (`run-lock.ts`: `Math.max(1, options.jobs ?? 1)`),
so nineteen agents sleep while one works, and each of them re-does the same
23,401-file scan and the same tool invocations for its own scope.

The header of `run-lock.ts` describes the intent — *"Ten agents editing one
worktree and each running the full check is ten scans and ten runs of every
external tool for the same tree"* — and that intent is defeated the moment the
check is scoped.

**Suggested direction.** The scope decides which *violations are reported*, not
which *work is worth doing*: the scan and most rules are whole-tree anyway (the
observed run scanned 23,401 files for a scope naming four directories). Two
options:

- **Drop `fileFilter` from the request key** and filter the stored result by
  scope on reuse. A run's record already holds its violations, so reuse becomes
  a filter rather than a re-run. This is the largest win and changes the meaning
  of a cached record, so it needs care: `examinedPaths` and the `marks` for tests
  that did *not* run must survive the filter, or a scoped reuse would report
  passing tests that never ran.
- **Or keep the key and raise `jobs`.** Cheaper, but it trades a queue for CPU
  contention, and the whole-suite scan is duplicated N times regardless.

## 3. OPEN: `waitedMs` is not the wait in the `ran` path

In `runHolding`:

```ts
const waitedMs = Date.now() - startedAt;
```

`startedAt` is when the **caller** entered `coordinateRun`. So on the `ran` path
`waitedMs` is the **total run duration**, and the envelope reports it under a
name that says "how long this waited". A caller diagnosing throughput reads
`waitedMs: 66660` and concludes the lock cost 66 seconds, when the check itself
took 66 seconds and never waited at all. This brief was written after making
exactly that mistake.

`ran-after-wait` sets `waitedMs` from `Date.now() - startedAt` in the timeout
branch too, where it happens to be closer to the truth but still includes the
run.

**Suggested fix:** report `waitedMs` as time spent in the wait loop only, and add
`runMs` for the work. They are different numbers and both are wanted.

---

## 4. A smaller one, while you are in there

`takeOverIfStale` examines **slot 0 only**, with the reasoning that *"a dead
holder of slot 1 has not been there long enough to matter"*. That holds when
`jobs` is 1. If §2 is fixed by raising `jobs`, a fleet will hold slots 0..N and a
dead holder of any of them strands its callers until the wait timeout. Worth
revisiting whichever way §2 goes.

---

## How to reproduce

```bash
# 1. the scope bug (before the fix): watch vitest receive a PHP pattern
cd <worktree>
(bun x gesetz check --files "app/Domains/Matchmaking/DTO/**" &) ; sleep 20
ps -eo pid,etime,command | grep gesetz-vitest

# 2. the key bug: two scopes over the same tree never reuse
bun x gesetz check --files "app/Domains/Matchmaking/DTO/**"
bun x gesetz check --files "app/Domains/Matchmaking/DTO/**"      # expect: reused
bun x gesetz check --files "app/Domains/Matchmaking/Services/**" # expect: ran, re-scanned everything
```

## What "fixed" looks like

- A scoped check never widens to the whole suite. ✔ done
- Two agents whose scopes overlap reuse one run instead of serialising.
- `waitedMs` means waiting, and a run's own cost is reported separately.
- The fleet's checks get faster as agents are added, or at least do not get
  slower in proportion to agent count.
