/**
 * Terminal formatting helpers for the regel CLI output.
 */
import type { CategoryScore, RunResult, RuleResult } from '@regeln/core';

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
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

function color(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${C.reset}`;
}

function scoreColor(score: number): string {
  if (score >= 8) return C.green;
  if (score >= 5) return C.yellow;
  return C.red;
}

function bar(score: number, width = 20): string {
  const filled = Math.round((score / 10) * width);
  const empty = width - filled;
  const fillChar = '█';
  const emptyChar = '░';
  const col = scoreColor(score);
  return color(fillChar.repeat(filled), col) + color(emptyChar.repeat(empty), C.dim);
}

// ─── Category score table ─────────────────────────────────────────────────────

export function formatCategoryTable(result: RunResult): string {
  if (result.byCategory.length === 0) {
    return color('  No categories defined. Add .category("strictness") to your rules.\n', C.dim);
  }

  const colWidths = { category: 14, bar: 20, score: 6, errors: 8, warnings: 9, status: 8 };

  const header =
    color(
      `  ${'Category'.padEnd(colWidths.category)}  ${'Score'.padEnd(colWidths.bar + 4)}  ${'Errors'.padStart(colWidths.errors)}  ${'Warnings'.padStart(colWidths.warnings)}  Status`,
      C.bold,
    ) + '\n';

  const divider = color(`  ${'─'.repeat(72)}\n`, C.dim);

  const rows = result.byCategory
    .sort((a, b) => a.score - b.score) // worst first
    .map((cat) => {
      const catName = cat.category.padEnd(colWidths.category);
      const scoreStr = `${cat.score.toFixed(1)}/10`.padStart(6);
      const errStr = cat.errors.toString().padStart(colWidths.errors);
      const warnStr = cat.warnings.toString().padStart(colWidths.warnings);
      const status = cat.passing
        ? color('  ✓ pass', C.green)
        : color('  ✗ fail', C.red);
      const scoreCol = scoreColor(cat.score);
      return `  ${color(catName, C.bold)}  ${bar(cat.score)}  ${color(scoreStr, scoreCol)}  ${errStr}  ${warnStr}${status}`;
    })
    .join('\n');

  const total = `\n  ${color('Total violations:', C.bold)} ${color(result.totalViolations.toString(), result.totalViolations > 0 ? C.red : C.green)}`;
  const overall = `\n  ${color('Overall:', C.bold)} ${result.passing ? color('PASS', C.green + C.bold) : color('FAIL', C.red + C.bold)}`;

  return `\n${header}${divider}${rows}\n${divider}${total}${overall}\n`;
}

// ─── Violation list ──────────────────────────────────────────────────────────

export function formatViolations(byRule: RuleResult[]): string {
  const lines: string[] = [];
  for (const result of byRule) {
    if (result.violations.length === 0) continue;
    lines.push(`\n  ${color(result.description, C.bold + C.cyan)}`);
    lines.push(`  ${color(`rule: ${result.ruleId}`, C.dim)}`);
    for (const v of result.violations) {
      const loc = v.line != null ? `:${v.line}` : '';
      const sevColor = v.severity === 'error' ? C.red : v.severity === 'warn' ? C.yellow : C.blue;
      const sev = color(`[${v.severity}]`, sevColor);
      lines.push(`    ${sev} ${color(v.path + loc, C.white)} — ${v.message}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ─── JSON output ─────────────────────────────────────────────────────────────

export function formatJson(result: RunResult): string {
  return JSON.stringify(result, null, 2);
}

// ─── List output (rule catalog) ───────────────────────────────────────────────

export interface ListEntry {
  id: string;
  description: string;
  category: string | undefined;
  guidance: { what: string; do: string; dont: string } | undefined;
}

export function formatList(entries: ListEntry[], json: boolean): string {
  if (json) return JSON.stringify(entries, null, 2);

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
