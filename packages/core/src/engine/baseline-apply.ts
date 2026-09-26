/**
 * Violation baseline — matching and write planning.
 *
 * `partitionByBaseline` splits a run into new and baselined violations and
 * reports stale entries. `planBaselineWrite` decides what a write would change
 * and refuses to absorb a regression. The domain types and the hash live in
 * `baseline.ts`; persistence lives in `baseline-file.ts`.
 */
import {
  BASELINE_FILE_NAME,
  compareStrings,
  modeLookup,
  makeBaselineFile,
  normalizePath,
  violationHash,
  STALE_RULE_ID,
  type BaselineFile,
  type BaselineViolationGroup,
  type LocatedEntry,
  type MutableRuleCounts,
} from './baseline';
import { locate } from './baseline-file';
import type { BaselineMessageMode, Violation } from './rule';

export interface BaselineRuleCounts {
  readonly rule: string;
  readonly new: number;
  readonly baselined: number;
  readonly stale: number;
}

export interface BaselineStats {
  readonly new: number;
  readonly baselined: number;
  readonly stale: number;
  /** Entries in the baseline file the run was checked against. */
  readonly total: number;
  readonly byRule: readonly BaselineRuleCounts[];
}

export interface BaselinePartition {
  readonly newByRule: ReadonlyMap<string, Violation[]>;
  /** Synthetic violations, one per stale entry key. */
  readonly stale: readonly Violation[];
  readonly stats: BaselineStats;
}

export interface BaselinePartitionOptions {
  readonly modes?: ReadonlyMap<string, BaselineMessageMode> | undefined;
  /**
   * Whether a baseline entry is inside the examined scope. A `--since` or
   * `--files` run cannot see files outside it, so their entries must not be
   * reported stale.
   */
  readonly inScope?: ((path: string) => boolean) | undefined;
  /**
   * Whether a stale entry is reportable. An exemption for `STALE_RULE_ID`
   * suppresses it during a deliberate cleanup.
   */
  readonly allowStale?: ((path: string) => boolean) | undefined;
}

export interface BaselineRefusal {
  readonly rule: string;
  readonly path: string;
  readonly hash: string;
  readonly message: string;
  readonly count: number;
}

export interface BaselineRuleDelta {
  readonly rule: string;
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
}

export interface BaselineWritePlan {
  /** Violations not in the existing baseline. Non-empty means the write fails. */
  readonly refused: readonly BaselineRefusal[];
  readonly next: BaselineFile;
  readonly deltas: readonly BaselineRuleDelta[];
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
}

/** Lowest-line-first order, so the line written for a duplicate key is stable. */
function byLocation(a: Violation, b: Violation): number {
  const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
  const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
  if (lineA !== lineB) return lineA - lineB;
  return (a.column ?? 0) - (b.column ?? 0);
}

function staleViolation(located: LocatedEntry, remaining: number): Violation {
  const { entry } = located;
  return {
    rule: STALE_RULE_ID,
    message:
      `Stale baseline entry — ${entry.rule} no longer reports ${remaining} of ${entry.count} occurrence(s). ` +
      `A maintainer must delete the entry from ${BASELINE_FILE_NAME}.`,
    path: located.path,
    ...(entry.line !== undefined ? { line: entry.line } : {}),
    severity: 'error',
    source: 'core',
  };
}

/**
 * Splits violations into new and baselined, and reports stale entries.
 *
 * Matching is per key with a count, so a key with three baselined occurrences
 * and a fourth new one produces one new violation, and fixing one of three
 * produces one stale entry.
 */
export function partitionByBaseline(
  groups: readonly BaselineViolationGroup[],
  baseline: BaselineFile,
  options: BaselinePartitionOptions = {},
): BaselinePartition {
  const modeOf = modeLookup(options.modes);
  const remaining = new Map<string, { located: LocatedEntry; left: number }>();
  for (const located of locate(baseline)) {
    const existing = remaining.get(located.entry.hash);
    remaining.set(located.entry.hash, {
      located,
      left: (existing?.left ?? 0) + located.entry.count,
    });
  }

  const newByRule = new Map<string, Violation[]>();
  const counts = new Map<string, MutableRuleCounts>();
  const countFor = (rule: string): MutableRuleCounts => {
    const existing = counts.get(rule);
    if (existing !== undefined) return existing;
    const created: MutableRuleCounts = { rule, new: 0, baselined: 0, stale: 0 };
    counts.set(rule, created);
    return created;
  };
  let newTotal = 0;
  let baselinedTotal = 0;

  for (const group of groups) {
    const fresh: Violation[] = [];
    for (const violation of [...group.violations].sort(byLocation)) {
      const path = normalizePath(violation.path);
      const hash = violationHash(group.rule, path, violation.message, modeOf(group.rule));
      const match = remaining.get(hash);
      if (match !== undefined && match.left > 0) {
        remaining.set(hash, { ...match, left: match.left - 1 });
        baselinedTotal += 1;
        countFor(group.rule).baselined += 1;
      } else {
        fresh.push(violation);
        newTotal += 1;
        countFor(group.rule).new += 1;
      }
    }
    newByRule.set(group.rule, fresh);
  }

  const stale: Violation[] = [];
  for (const { located, left } of remaining.values()) {
    if (left <= 0) continue;
    if (options.inScope !== undefined && !options.inScope(located.path)) continue;
    if (options.allowStale !== undefined && !options.allowStale(located.path)) continue;
    stale.push(staleViolation(located, left));
    countFor(located.entry.rule).stale += 1;
  }

  const byRule = [...counts.values()]
    .filter((value) => value.new > 0 || value.baselined > 0 || value.stale > 0)
    .sort((a, b) => compareStrings(a.rule, b.rule));

  return {
    newByRule,
    stale,
    stats: {
      new: newTotal,
      baselined: baselinedTotal,
      stale: stale.length,
      total: baseline.total,
      byRule,
    },
  };
}

// ─── Write plan ──────────────────────────────────────────────────────────────

function countByKey(file: BaselineFile): Map<string, { located: LocatedEntry; count: number }> {
  const byHash = new Map<string, { located: LocatedEntry; count: number }>();
  for (const located of locate(file)) {
    const existing = byHash.get(located.entry.hash);
    byHash.set(located.entry.hash, {
      located,
      count: (existing?.count ?? 0) + located.entry.count,
    });
  }
  return byHash;
}

/**
 * Plans a baseline write.
 *
 * A write must not absorb a regression. When an existing baseline is present,
 * a violation that it does not cover is refused unless its rule is named in
 * `rules` — the explicit accept for the day a new rule lands. The first write
 * has nothing to regress from, so it accepts the whole backlog.
 */
export function planBaselineWrite(
  current: BaselineFile,
  existing: BaselineFile | null,
  options: {
    readonly rules?: readonly string[] | null | undefined;
    readonly gesetzVersion: string;
  },
): BaselineWritePlan {
  const explicit =
    options.rules !== undefined && options.rules !== null && options.rules.length > 0
      ? new Set(options.rules)
      : null;
  const currentEntries = countByKey(current);
  const existingEntries: Map<string, { located: LocatedEntry; count: number }> =
    existing === null ? new Map() : countByKey(existing);
  const refused: BaselineRefusal[] = [];

  if (existing !== null) {
    for (const [hash, { located, count }] of currentEntries) {
      const known = existingEntries.get(hash)?.count ?? 0;
      if (count <= known) continue;
      if (explicit !== null && explicit.has(located.entry.rule)) continue;
      refused.push({
        rule: located.entry.rule,
        path: located.path,
        hash,
        message: located.entry.message,
        count: count - known,
      });
    }
  }

  const next = new Map<string, LocatedEntry>();
  if (existing !== null && explicit !== null) {
    for (const [hash, { located }] of existingEntries) {
      if (explicit.has(located.entry.rule)) continue;
      next.set(hash, located);
    }
  }
  for (const [hash, { located }] of currentEntries) {
    if (explicit !== null && !explicit.has(located.entry.rule)) continue;
    next.set(hash, located);
  }

  const deltas = compareRules(existingEntries, next);
  return {
    refused,
    next: makeBaselineFile([...next.values()], options.gesetzVersion),
    deltas,
    added: deltas.reduce((sum, delta) => sum + delta.added, 0),
    removed: deltas.reduce((sum, delta) => sum + delta.removed, 0),
    kept: deltas.reduce((sum, delta) => sum + delta.kept, 0),
  };
}

function compareRules(
  before: Map<string, { located: LocatedEntry; count: number }>,
  after: Map<string, LocatedEntry>,
): BaselineRuleDelta[] {
  const rules = new Set<string>();
  for (const { located } of before.values()) rules.add(located.entry.rule);
  for (const located of after.values()) rules.add(located.entry.rule);
  const deltas: BaselineRuleDelta[] = [];
  for (const rule of [...rules].sort()) {
    let added = 0;
    let removed = 0;
    let kept = 0;
    for (const [hash, { located, count }] of before) {
      if (located.entry.rule !== rule) continue;
      const nextCount = after.get(hash)?.entry.count ?? 0;
      kept += Math.min(count, nextCount);
      added += Math.max(0, nextCount - count);
      removed += Math.max(0, count - nextCount);
    }
    for (const [hash, located] of after) {
      if (located.entry.rule !== rule) continue;
      if (before.has(hash)) continue;
      added += located.entry.count;
    }
    if (added > 0 || removed > 0 || kept > 0) deltas.push({ rule, added, removed, kept });
  }
  return deltas;
}
