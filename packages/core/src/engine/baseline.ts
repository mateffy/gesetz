/**
 * Violation-level baseline — the domain and the hash.
 *
 * A baseline records the violations that already exist, so a gate can fail on
 * new ones only. `applyExemptions` matches a whole file and cannot express
 * that: a file with three baselined violations and a fourth new one is
 * suppressed entirely. A baseline matches one violation.
 *
 * Identity is a hash of rule id, path and a normalised message. Line numbers
 * shift when code moves above them, so the line is stored for a human reader
 * and kept out of the hash.
 *
 * Reading and writing the file live in `baseline-file.ts`. Matching and
 * write planning live in `baseline-apply.ts`.
 */
import { createHash } from 'node:crypto';
import type { BaselineMessageMode, Violation } from './rule';

/** Baseline file name at the project root. */
export const BASELINE_FILE_NAME = '.gesetz-baseline.json';
/** Schema version of the baseline file. */
export const BASELINE_FILE_VERSION = 2;
/** Rule id for a baseline entry whose violation no longer occurs. */
export const STALE_RULE_ID = 'baseline-entry-is-stale';
/** Hex characters of the sha256 hash kept in the file. */
const HASH_LENGTH = 16;

export interface BaselineEntry {
  readonly rule: string;
  readonly hash: string;
  /** The message as it was when the entry was written. Human-readable. */
  readonly message: string;
  /** Human-readable location. Never part of the hash. */
  readonly line?: number | undefined;
  /** Occurrences of this exact key in the file. */
  readonly count: number;
}

export interface BaselineFile {
  readonly version: number;
  /** Version of gesetz that wrote the file. Informational. */
  readonly gesetz: string;
  /** Sum of every entry count. */
  readonly total: number;
  /** Entries grouped by repository-relative path. */
  readonly entries: Record<string, BaselineEntry[]>;
}

/**
 * An entry with the path it was recorded under. Internal to the baseline
 * modules; not part of the public API in `index.ts`.
 */
export interface LocatedEntry {
  readonly path: string;
  readonly entry: BaselineEntry;
}

/** Internal mutable counter. */
export interface MutableRuleCounts {
  rule: string;
  new: number;
  baselined: number;
  stale: number;
}

/** One rule's violations, as the runner aggregates them. */
export interface BaselineViolationGroup {
  readonly rule: string;
  readonly violations: readonly Violation[];
}

// ─── Normalisation ───────────────────────────────────────────────────────────

/**
 * Volatile tokens replaced before hashing, and why each one is here:
 *
 * - `{{...}}` template placeholders. No current rule uses them; kept because a
 *   rule that does must not churn the baseline on every fill-in.
 * - quoted paths: `'./interface'`, `'src/foo.ts'`.
 * - bare paths: `immoui/src/sdk/domains/x/index.ts`. The path already
 *   identifies the violation, so a rename must not create a new entry.
 * - UUIDs: generated ids in messages.
 * - hex ids: 8 or more hex characters, the shortest run that is almost never
 *   an English word.
 * - bare integers and decimals: `expected 3 arguments, got 4`, `param[1]`,
 *   `score 6 below minimum 8`.
 *
 * Identifiers are deliberately kept. `SchemaName.fieldName`, a method name, a
 * domain name and a package specifier say which violation this is; stripping
 * them would merge distinct violations. Duplicate keys are safe because an
 * entry carries a count.
 */
const NORMALISERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\{\{[^{}]*\}\}/g, '<tpl>'],
  [/(['"`])([^'"`\n]*[\\/][^'"`\n]*)\1/g, '<path>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b[0-9a-f]{8,}\b/gi, '<hex>'],
  [/\b[\w.@-]+(?:[\\/][\w.@-]+)+\b/g, '<path>'],
  [/\b\d+(?:\.\d+)?\b/g, '<n>'],
];

/** Replaces volatile tokens in a violation message. */
export function normalizeMessage(message: string): string {
  let normalized = message;
  for (const [pattern, replacement] of NORMALISERS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

/** Repository-relative path with forward slashes and no leading `./`. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Identity of one violation: rule id, path and message.
 *
 * The line is excluded on purpose. Adding an import at the top of a file
 * shifts every line below it, and a line-keyed baseline would report every
 * shifted violation as new.
 */
/** Whitespace-normalised source line, for identity only. */
export function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Identity of a baseline entry.
 *
 * The line *number* is deliberately absent: inserting an import shifts every line
 * below it, and a line-keyed identity would report every shifted violation as new.
 * The line's *text* is deliberately present: without it, identity degrades to a
 * count per (path, rule, message), which cannot see a swap — 47 occurrences fixed
 * and one unrelated new occurrence leaves the count unchanged, so the gate passes
 * blind to it. Text, not position, catches the swap and survives the shift.
 *
 * `lineText` is optional so a caller that has not read the source keeps working;
 * both the write path and the gate must supply it, or entries stop matching.
 */
export function violationHash(
  rule: string,
  path: string,
  message: string,
  mode: BaselineMessageMode = 'normalized',
  lineText?: string | undefined,
): string {
  const material = mode === 'exact' ? message : normalizeMessage(message);
  return createHash('sha256')
    .update(
      JSON.stringify([
        rule,
        normalizePath(path),
        material,
        lineText === undefined ? null : normalizeLine(lineText),
      ]),
    )
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * Attaches each violation's source line, reading every file at most once.
 *
 * `readFile` returns null when the file cannot be read; those violations keep the
 * old identity rather than inventing an empty line, so an unreadable file is a
 * degraded match and never a false one.
 */
export function attachLineTexts(
  violations: readonly Violation[],
  readFile: (path: string) => string | null,
): Violation[] {
  const cache = new Map<string, string[] | null>();
  return violations.map((violation) => {
    if (violation.line === undefined || violation.lineText !== undefined) return violation;
    let lines = cache.get(violation.path);
    if (lines === undefined) {
      const text = readFile(violation.path);
      lines = text === null ? null : text.split('\n');
      cache.set(violation.path, lines);
    }
    if (lines === null) return violation;
    const text = lines[violation.line - 1];
    return text === undefined ? violation : { ...violation, lineText: text };
  });
}

// ─── Building a baseline file ────────────────────────────────────────────────

/** Lowest-line-first order, so the line written for a duplicate key is stable. */
function byLocation(a: Violation, b: Violation): number {
  const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
  const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
  if (lineA !== lineB) return lineA - lineB;
  return (a.column ?? 0) - (b.column ?? 0);
}

/** Resolves a rule's message mode. Unknown rules normalise. */
export function modeLookup(
  modes: ReadonlyMap<string, BaselineMessageMode> | undefined,
): (rule: string) => BaselineMessageMode {
  return (rule) => modes?.get(rule) ?? 'normalized';
}

/** Collapses violations into one entry per key, with an occurrence count. */
function collectEntries(
  groups: readonly BaselineViolationGroup[],
  modeOf: (rule: string) => BaselineMessageMode,
): LocatedEntry[] {
  const byHash = new Map<string, LocatedEntry>();
  for (const group of groups) {
    for (const violation of [...group.violations].sort(byLocation)) {
      const path = normalizePath(violation.path);
      const hash = violationHash(
        group.rule,
        path,
        violation.message,
        modeOf(group.rule),
        violation.lineText,
      );
      const existing = byHash.get(hash);
      byHash.set(hash, {
        path: existing?.path ?? path,
        entry:
          existing === undefined
            ? {
                rule: group.rule,
                hash,
                message: violation.message,
                ...(violation.line !== undefined ? { line: violation.line } : {}),
                count: 1,
              }
            : { ...existing.entry, count: existing.entry.count + 1 },
      });
    }
  }
  return [...byHash.values()];
}

/**
 * Code-unit order.
 *
 * `localeCompare` depends on the runtime's locale, so two machines could sort
 * the same entries differently and produce different bytes. The baseline file
 * must be identical everywhere, so this compares code units directly.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Groups entries by path in deterministic order: path, rule, then hash. */
function groupByPath(entries: readonly LocatedEntry[]): Record<string, BaselineEntry[]> {
  const byPath = new Map<string, BaselineEntry[]>();
  for (const located of entries) {
    const list = byPath.get(located.path) ?? [];
    list.push(located.entry);
    byPath.set(located.path, list);
  }
  const grouped: Record<string, BaselineEntry[]> = {};
  for (const path of [...byPath.keys()].sort(compareStrings)) {
    const list = byPath.get(path) ?? [];
    list.sort((a, b) => compareStrings(a.rule, b.rule) || compareStrings(a.hash, b.hash));
    grouped[path] = list;
  }
  return grouped;
}

/** Assembles a file from located entries. Internal to the baseline modules. */
export function makeBaselineFile(
  entries: readonly LocatedEntry[],
  gesetzVersion: string,
): BaselineFile {
  return {
    version: BASELINE_FILE_VERSION,
    gesetz: gesetzVersion,
    total: entries.reduce((sum, located) => sum + located.entry.count, 0),
    entries: groupByPath(entries),
  };
}

/** Builds a baseline file from violations, with a deterministic order. */
export function buildBaselineFile(
  groups: readonly BaselineViolationGroup[],
  options: {
    readonly gesetzVersion: string;
    readonly modes?: ReadonlyMap<string, BaselineMessageMode> | undefined;
  },
): BaselineFile {
  return makeBaselineFile(collectEntries(groups, modeLookup(options.modes)), options.gesetzVersion);
}
