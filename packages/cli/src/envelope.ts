/**
 * The compact JSON envelope for `--format=json`.
 *
 * A single document on stdout: versioned, flat violation array, stable short
 * keys, capped lists with a hint. The baseline split is additive, so a parser
 * that predates it keeps working.
 */
import type { RunResult } from '@gesetz/core';

/** Mirrors the runner's default: a category must score at least this to pass. */
const DEFAULT_CATEGORY_THRESHOLD = 7;

/**
 * Default cap on the number of violations emitted in JSON mode. Keeps agent
 * context windows small; mirrors PAO/PHPStan capping. `--all` disables it.
 */
export const MAX_VIOLATIONS = 50;

interface EnvelopeViolation {
  sev: 'error' | 'warn' | 'info';
  rule: string;
  path: string;
  line: number | null;
  col: number | null;
  msg: string;
}

interface EnvelopeCategory {
  name: string;
  score: number;
  errors: number;
  warnings: number;
  infos: number;
  passing: boolean;
  threshold: number;
}

interface EnvelopeBaselineRule {
  rule: string;
  new: number;
  baselined: number;
  stale: number;
}

interface EnvelopeBaseline {
  new: number;
  baselined: number;
  stale: number;
  /** Entries in the baseline file the run was checked against. */
  total: number;
  byRule: EnvelopeBaselineRule[];
}

interface Envelope {
  v: 1;
  status: 'pass' | 'fail';
  passing: boolean;
  total: number;
  summary: Record<string, number>;
  categories: EnvelopeCategory[];
  violations: EnvelopeViolation[];
  truncated: number;
  hint: string | null;
  /** Null when the run used no baseline. Additive: existing parsers ignore it. */
  baseline: EnvelopeBaseline | null;
}

/**
 * Builds the compact JSON envelope for `--format=json`.
 *
 * `thresholds` maps category -> configured min score (for the `threshold`
 * field). Pass the resolved config thresholds; defaults to 7 when absent.
 */
export function buildEnvelope(
  result: RunResult,
  opts: { all?: boolean; thresholds?: Record<string, number> } = {},
): Envelope {
  const allViolations: EnvelopeViolation[] = [];
  for (const r of result.byRule) {
    for (const v of r.violations) {
      allViolations.push({
        sev: v.severity,
        rule: r.ruleId,
        path: v.path,
        line: v.line ?? null,
        col: v.column ?? null,
        msg: v.message,
      });
    }
  }

  const cap = opts.all === true ? Infinity : MAX_VIOLATIONS;
  const truncated = Math.max(0, allViolations.length - cap);
  const violations = truncated > 0 ? allViolations.slice(0, cap) : allViolations;

  const thresholds = opts.thresholds ?? {};
  const categories: EnvelopeCategory[] = result.byCategory.map((c) => ({
    name: c.category,
    score: c.score,
    errors: c.errors,
    warnings: c.warnings,
    infos: c.infos,
    passing: c.passing,
    threshold: thresholds[c.category] ?? DEFAULT_CATEGORY_THRESHOLD,
  }));

  const summary: Record<string, number> = {};
  for (const c of result.byCategory) summary[c.category] = c.score;

  return {
    v: 1,
    status: result.passing ? 'pass' : 'fail',
    passing: result.passing,
    total: result.totalViolations,
    summary,
    categories,
    violations,
    truncated,
    hint: truncated > 0 ? `gesetz check --format=json --all` : null,
    baseline:
      result.baseline === undefined
        ? null
        : {
            new: result.baseline.new,
            baselined: result.baseline.baselined,
            stale: result.baseline.stale,
            total: result.baseline.total,
            byRule: result.baseline.byRule.map((rule) => ({
              rule: rule.rule,
              new: rule.new,
              baselined: rule.baselined,
              stale: rule.stale,
            })),
          },
  };
}

/** Renders the envelope as a single compact JSON line + trailing newline. */
export function formatEnvelope(
  result: RunResult,
  opts: { all?: boolean; thresholds?: Record<string, number> } = {},
): string {
  return JSON.stringify(buildEnvelope(result, opts)) + '\n';
}
