# Baseline to beat (measured on `main`, before the cache engine)

Recorded 2026-09-27 on the same machine these phases will be measured on.

## immocore React repo

Worktree: `/Users/mat/.local/share/opencode/worktree/7f2647746f55a46170ff2d791668025c823037bf/brave-tiger`
9,247 discovered files (6,033 PHP, 896 TS/TSX).

| measurement | value |
|---|---|
| cold scan, nothing cached | 52.7 s quiet / 150.7 s loaded |
| warm scan, nothing changed | 7.8–8.7 s |
| netzwerk alone (no rules, no parsing) | 8.0 s cold / 4.4 s warm |
| process start + one tree walk (9,247 files) | 5.7 s, walk 3.5 s |
| `vitest run --project unit` (whole suite) | 56.2 s |
| `vitest` for one test file | 10.8 s |
| `oxlint` over `immoui/src` | 3.8 s |
| `oxlint` for the 14 requested files | 0.5 s |
| `bun x gesetz` startup | 1.6 s |
| scoped run the user asked for (`--files 'immoui/src/components/primitives/**'`) | **83.6 s, aborted** |

## The engine being adopted

`origin/netzwerk`, measured on this repo (203 files, 3 per-file rules, TS backend):
cold ~684 ms (was ~22 s), warm ~119 ms (was ~1.0–1.5 s), one-file edit ~124 ms.

## What must improve

1. A one-file edit in immocore: seconds, not a minute.
2. A cold run: under ~10× the current warm run.
3. Three concurrent checks in one worktree: **one** scan, not three, and no crash.
4. No regression in reported violations (Phase 7.3 diffs against `main`).
