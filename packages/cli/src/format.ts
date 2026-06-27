/**
 * Terminal formatting helpers for the regel CLI output.
 *
 * Two output modes:
 *   - `pretty` — lush human table + file-grouped violations (TTY only)
 *   - `json`    — single compact JSON document for AI agents / machines
 *   - `ci`      — GitHub Actions `::error`/`::warning` workflow annotations
 *
 * stdout is the data contract in every mode; status banners go to stderr.
 * No non-ASCII reaches stdout in `json`/`ci` modes, and `pretty` gates all
 * decoration behind `isTTY` (ASCII fallback when piped) so the output is
 * never mojibake-prone.
 */
import type { CategoryScore, RunResult, RuleResult, Violation } from '@regeln/core';

// ─── Output format ──────────────────────────────────────────────────────────

export type OutputFormat = 'pretty' | 'json' | 'ci';

/**
 * Environment variables that signal regel is running inside an AI agent.
 * When any is set (truthy), or stdout is not a TTY, JSON mode is the default.
 * Mirrors Laravel PAO's detection approach.
 */
export const AGENT_ENV_VARS = [
  'CLAUDE_CODE',
  'CLAUDECODE',
  'CURSOR',
  'CURSOR_TRACE_ID',
  'DEVIN',
  'GEMINI_CLI',
  'AGENT_TASK_ID',
  'AIDER_CHAT',
] as const;

/**
 * Resolves the output format from explicit flag, legacy fallback, and
 * environment. Precedence: explicit `--format` > auto-detection.
 *
 * Auto-detection picks `json` when stdout is not a TTY or an agent env var
 * is present; otherwise `pretty` (the lush terminal table).
 */
export function detectFormat(explicit?: OutputFormat | undefined): OutputFormat {
  if (explicit !== undefined) return explicit;
  if (!process.stdout.isTTY) return 'json';
  if (AGENT_ENV_VARS.some((k) => process.env[k])) return 'json';
  return 'pretty';
}

// ─── ANSI colours ────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
} as const;

function isTty(): boolean {
  return process.stdout.isTTY === true;
}

/** Wraps text in ANSI codes only when stdout is a TTY; otherwise returns it bare. */
function color(text: string, ...codes: string[]): string {
  if (!isTty()) return text;
  return `${codes.join('')}${text}${C.reset}`;
}

function scoreColor(score: number): string {
  if (score >= 8) return C.green;
  if (score >= 5) return C.yellow;
  return C.red;
}

// Box-drawing glyphs. Built via String.fromCharCode so the bundler cannot
// fold them into a literal multi-byte source string — a literal `\u2500` in
// source is rewritten to raw UTF-8 bytes by `bun build`, which is then
// mis-decoded at module-eval time under some transitive deps (see
// .plans/cli-output-redesign/PLAN.md). Constructing at call time sidesteps
// the whole class. When not a TTY we emit ASCII fallbacks.
interface Glyphs {
  hLine: string; // horizontal divider
  fill: string; // filled bar cell
  empty: string; // empty bar cell
  pass: string;
  fail: string;
}

const PRETTY_GLYPHS: Glyphs = {
  hLine: String.fromCharCode(0x2500), // ─
  fill: String.fromCharCode(0x2588), // █
  empty: String.fromCharCode(0x2591), // ░
  pass: String.fromCharCode(0x2713), // ✓
  fail: String.fromCharCode(0x2717), // ✗
};

const ASCII_GLYPHS: Glyphs = {
  hLine: '-',
  fill: '#',
  empty: '.',
  pass: '+',
  fail: 'x',
};

function glyphs(): Glyphs {
  return isTty() ? PRETTY_GLYPHS : ASCII_GLYPHS;
}

function bar(score: number, width = 20): string {
  const g = glyphs();
  const filled = Math.round((score / 10) * width);
  const empty = width - filled;
  const col = scoreColor(score);
  return color(g.fill.repeat(filled), col) + color(g.empty.repeat(empty), C.dim);
}

// ─── Category score table (pretty) ───────────────────────────────────────────

export function formatCategoryTable(result: RunResult): string {
  const g = glyphs();

  if (result.byCategory.length === 0) {
    return color('  No categories defined. Add .category("strictness") to your rules.\n', C.dim);
  }

  const colWidths = { category: 14, bar: 20, score: 6, errors: 8, warnings: 9, status: 8 };

  const header =
    color(
      `  ${'Category'.padEnd(colWidths.category)}  ${'Score'.padEnd(colWidths.bar + 4)}  ${'Errors'.padStart(colWidths.errors)}  ${'Warnings'.padStart(colWidths.warnings)}  Status`,
      C.bold,
    ) + '\n';

  const divider = color(`  ${g.hLine.repeat(72)}\n`, C.dim);

  const rows = result.byCategory
    .sort((a, b) => a.score - b.score) // worst first
    .map((cat) => {
      const catName = cat.category.padEnd(colWidths.category);
      const scoreStr = `${cat.score.toFixed(1)}/10`.padStart(6);
      const errStr = cat.errors.toString().padStart(colWidths.errors);
      const warnStr = cat.warnings.toString().padStart(colWidths.warnings);
      const status = cat.passing
        ? color(`  ${g.pass} pass`, C.green)
        : color(`  ${g.fail} fail`, C.red);
      const scoreCol = scoreColor(cat.score);
      return `  ${color(catName, C.bold)}  ${bar(cat.score)}  ${color(scoreStr, scoreCol)}  ${errStr}  ${warnStr}${status}`;
    })
    .join('\n');

  const total = `\n  ${color('Total violations:', C.bold)} ${color(result.totalViolations.toString(), result.totalViolations > 0 ? C.red : C.green)}`;
  const overall = `\n  ${color('Overall:', C.bold)} ${result.passing ? color('PASS', C.green + C.bold) : color('FAIL', C.red + C.bold)}`;

  return `\n${header}${divider}${rows}\n${divider}${total}${overall}\n`;
}

// ─── Violation list (pretty, grouped by file) ───────────────────────────────

/**
 * Groups violations by file path, sorted by path then by line. Matches how a
 * human or agent fixes code (file:line is the unit of work), rather than the
 * previous group-by-rule layout.
 */
export function formatViolations(byRule: RuleResult[]): string {
  const g = glyphs();
  // Flatten to {ruleId, violation} pairs for rules that have violations.
  const flat: { ruleId: string; v: Violation }[] = [];
  for (const result of byRule) {
    for (const v of result.violations) {
      flat.push({ ruleId: result.ruleId, v });
    }
  }
  if (flat.length === 0) return '';

  // Group by path, then sort lines numerically (line-less first).
  const byFile = new Map<string, { ruleId: string; v: Violation }[]>();
  for (const item of flat) {
    const arr = byFile.get(item.v.path) ?? [];
    arr.push(item);
    byFile.set(item.v.path, arr);
  }
  for (const arr of byFile.values()) {
    arr.sort((a, b) => {
      const la = a.v.line ?? -1;
      const lb = b.v.line ?? -1;
      return la - lb;
    });
  }

  const paths = Array.from(byFile.keys()).sort();

  const lines: string[] = [];
  for (const path of paths) {
    lines.push(`\n  ${color(path, C.bold + C.cyan)}`);
    const fileViolations = byFile.get(path);
    if (!fileViolations) continue;
    for (const { ruleId, v } of fileViolations) {
      const loc = v.line != null ? `L${v.line}${v.column != null ? `:${v.column}` : ''}` : '      ';
      const sevColor = v.severity === 'error' ? C.red : v.severity === 'warn' ? C.yellow : C.blue;
      const sev = color(`[${v.severity}]`, sevColor);
      lines.push(`    ${sev} ${color(loc.padEnd(7), C.dim)} ${color(ruleId, C.dim)}  ${v.message}`);
    }
  }
  void g; // (glyphs reserved for future per-row use)
  return lines.join('\n') + '\n';
}

// ─── JSON envelope (agents / machines) ──────────────────────────────────────

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
}

/**
 * Builds the compact JSON envelope for `--format=json`. A single document on
 * stdout: versioned, flat violation array, stable short keys, capped lists
 * with a hint. Passing runs compress to a small fixed-size payload.
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
    threshold: thresholds[c.category] ?? 7,
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
    hint: truncated > 0 ? `regel check --format=json --all` : null,
  };
}

/** Renders the envelope as a single compact JSON line + trailing newline. */
export function formatEnvelope(
  result: RunResult,
  opts: { all?: boolean; thresholds?: Record<string, number> } = {},
): string {
  return JSON.stringify(buildEnvelope(result, opts)) + '\n';
}

// ─── CI annotations (GitHub Actions) ─────────────────────────────────────────

/**
 * Emits GitHub Actions workflow commands — one `::error`/`::warning` line per
 * violation — to stdout. ASCII-only, no ANSI, no grouping.
 */
export function formatCi(result: RunResult): string {
  const lines: string[] = [];
  for (const r of result.byRule) {
    for (const v of r.violations) {
      const level = v.severity === 'warn' ? 'warning' : v.severity === 'error' ? 'error' : 'notice';
      const parts = [`file=${v.path}`];
      if (v.line !== undefined) parts.push(`line=${v.line}`);
      if (v.column !== undefined) parts.push(`col=${v.column}`);
      lines.push(`::${level} ${parts.join(',')}::${v.message} [${r.ruleId}]`);
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

// ─── Status banner (stderr, all modes) ───────────────────────────────────────

/**
 * One-line status for stderr. Lives on stderr so stdout stays a clean data
 * contract in every mode.
 */
export function formatStatusBanner(result: RunResult): string {
  const verdict = result.passing ? 'pass' : 'fail';
  return `regel: ${verdict} (${result.totalViolations} violation${result.totalViolations === 1 ? '' : 's'})\n`;
}

// ─── List output (rule catalog) ───────────────────────────────────────────────

export interface ListEntry {
  id: string;
  description: string;
  category: string | undefined;
  guidance: { what: string; do: string; dont: string } | undefined;
}

export function formatList(entries: ListEntry[], format: OutputFormat): string {
  if (format === 'json') return JSON.stringify(entries) + '\n';

  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`\n${color(e.id, C.bold + C.cyan)}`);
    if (e.category) lines.push(`  ${color('Category:', C.dim)} ${e.category}`);
    lines.push(`  ${e.description}`);
    if (e.guidance) {
      lines.push(`  ${color('What:', C.bold)} ${e.guidance.what}`);
      lines.push(`  ${color('Do:', C.bold + C.green)} ${e.guidance.do}`);
      lines.push(`  ${color("Don't:", C.bold + C.red)} ${e.guidance.dont}`);
    }
  }
  return lines.join('\n') + '\n';
}
