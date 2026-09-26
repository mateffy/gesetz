/**
 * Structure checks — file/function size, nesting, dead code patterns.
 *
 * All checks use text analysis only (no AST required) so they work on
 * any language. For AST-level checks (function line count) prefer the
 * TypeScript adapter primitives.
 */
import type { Check, Violation } from '../../engine/rule';

// ─── God file ────────────────────────────────────────────────────────────────

export interface NoGodFileOptions {
  /** Maximum allowed lines. Default: 400 */
  readonly maxLines?: number | undefined;
  readonly message?: string | undefined;
}

/** Default line budget for a single file. */
const DEFAULT_MAX_LINES = 400;
/** Default block-nesting budget. */
const DEFAULT_MAX_LEVELS = 4;

/**
 * Flags files that exceed a line-count threshold.
 *
 * @example
 * select('src/scripts/\*.ts').category('structure').check(noGodFile({ maxLines: 300 }))
 */
export function noGodFile(options: NoGodFileOptions = {}): Check {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  return async (file) => {
    const count = file.content.split('\n').length;
    if (count <= maxLines) return [];
    return [
      {
        message:
          options.message ??
          `File has ${count} lines (max: ${maxLines}). Split into smaller modules.`,
        path: file.path,
        line: maxLines + 1,
        severity: 'warn',
        source: 'core',
      },
    ];
  };
}

// ─── Deep nesting ─────────────────────────────────────────────────────────────

export interface NoDeepNestingOptions {
  /** Maximum allowed nesting level. Default: 4 */
  readonly maxLevels?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * Net change in brace depth across one line.
 *
 * Braces inside string literals and comments are skipped, so a quoted brace, a
 * line comment ending in a brace, or a block comment containing one do not
 * affect the count. (The first attempt at this docblock contained a literal
 * comment terminator, which ended the docblock early — the same class of mistake
 * this function exists to avoid.)
 */
/** Scanner state carried across lines: a block can open on one line and close on another. */
interface DepthState {
  /** current block nesting, counting only braces that open a block */
  blocks: number;
  /** whether each currently-open brace was counted as a block */
  open: boolean[];
  /** () and [] nesting, used to recognise an expression-position brace */
  expression: number;
}

const newDepthState = (): DepthState => ({ blocks: 0, open: [], expression: 0 });

/**
 * Scan one line, updating `st`.
 *
 * A brace only counts as nesting when it is not inside parentheses or brackets.
 * `violations.push({ ... })`, `x as { a: string }` and `=> ({ ... })` all put
 * their brace in expression position: they are object literals inside a call or
 * a cast, not blocks. Counting them reported two extra levels for idiomatic code
 * — the difference between a rule that finds nesting and one that finds
 * house style. A stack records whether each open brace was counted so the
 * matching close decrements only when it should.
 *
 * Known limit: a top-level object literal assigned with `const x = {` is still
 * counted, because nothing distinguishes it from a block without a parse tree.
 */
function scanLine(line: string, st: DepthState): { peakWithin: number } {
  let peakWithin = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    if (c === '/' && next === '/') break;
    if (c === '#' && next !== '[') break;
    if (c === '/' && next === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i++;
      while (i < line.length && line[i] !== c) {
        if (line[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[') {
      st.expression++;
    } else if (c === ')' || c === ']') {
      if (st.expression > 0) st.expression--;
    } else if (c === '{') {
      const isBlock = st.expression === 0;
      st.open.push(isBlock);
      if (isBlock) {
        st.blocks++;
        if (st.blocks > peakWithin) peakWithin = st.blocks;
      }
    } else if (c === '}') {
      if (st.open.pop() === true && st.blocks > 0) st.blocks--;
    }
  }
  return { peakWithin };
}

/**
 * Reports blocks nested deeper than `maxLevels`, measured by brace depth.
 *
 * Depth used to be measured from indentation width: `Math.floor(indent.length / 2)`.
 * That made every wrapped expression a violation, because a chained `.map()` or a
 * multi-line ternary continuation is deeply *indented* without being deeply
 * *nested* — at two-space indentation twelve columns scored as level six. It also
 * reported every line of a block and then truncated the list at ten, so a file
 * with forty deep lines was indistinguishable from one with ten. On this repo it
 * produced 253 warnings, none of which described a nesting problem.
 *
 * One violation is reported per contiguous deep region, at the line the region
 * starts, naming the deepest level reached inside it.
 *
 * Known limit: a deeply nested object literal does count towards depth, because
 * distinguishing a block brace from an object-literal brace needs a parse tree.
 */
export function noDeepNesting(options: NoDeepNestingOptions = {}): Check {
  const maxLevels = options.maxLevels ?? DEFAULT_MAX_LEVELS;
  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    const st = newDepthState();
    let regionStart = -1;
    let regionPeak = 0;

    const flush = (): void => {
      if (regionStart < 0) return;
      violations.push({
        message:
          options.message ??
          `Code nested ${regionPeak} levels deep (max: ${maxLevels}). Refactor using early returns or extracted functions.`,
        path: file.path,
        line: regionStart + 1,
        severity: 'warn',
        source: 'core',
      });
      regionStart = -1;
      regionPeak = 0;
    };

    for (let i = 0; i < lines.length; i++) {
      // Depth is sampled *within* the line as well as at its start. Sampling only
      // at line start made a whole nest written on one line — minified or
      // generated code — completely invisible, because such a line begins and
      // ends at the same depth.
      // `peakWithin` is the highest absolute depth reached during the line, so
      // the line's own depth is the max of where it started and how far it went —
      // not the sum, which counted the start twice.
      const blocksBefore = st.blocks;
      const { peakWithin } = scanLine(lines[i]!, st);
      const reached = Math.max(blocksBefore, peakWithin);
      const exceeded = reached > maxLevels;
      if (exceeded) {
        if (regionStart < 0) regionStart = i;
        if (reached > regionPeak) regionPeak = reached;
      }
      // End the region once nothing deeper than the limit is still open. Without
      // this, twenty separate one-line nests counted as a single region, because
      // the depth returns to zero between them.
      if (!exceeded || st.blocks <= maxLevels) flush();
    }
    flush();
    return violations;
  };
}

// ─── Console log ─────────────────────────────────────────────────────────────



// ─── Empty catch ──────────────────────────────────────────────────────────────



// ─── Trivial comments ─────────────────────────────────────────────────────────



// ─── Debugging residue files ──────────────────────────────────────────────────

export interface NoDebuggingResidueFilesOptions {
  /** Additional filename patterns to flag. Applied after built-in patterns. */
  readonly extraPatterns?: RegExp[] | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags files whose names suggest debugging artefacts:
 * `*_v2.ts`, `*_backup.ts`, `*_fixed.ts`, `*_copy.ts`, `*_old.ts`, `*_new.ts`
 */
export function noDebuggingResidueFiles(options: NoDebuggingResidueFilesOptions = {}): Check {
  const builtIn =
    /[._-](v\d+|backup|fixed|copy|old|new|temp|tmp|wip|draft|delete_me|deleteme)\.(ts|tsx|js|jsx|php|py)$/i;

  return async (file) => {
    const hit =
      builtIn.test(file.name) ||
      (options.extraPatterns?.some((p) => p.test(file.name)) ?? false);
    if (!hit) return [];
    return [
      {
        message:
          options.message ??
          `File name '${file.name}' looks like a debugging artefact. Delete it or rename to the correct name.`,
        path: file.path,
        severity: 'error',
        source: 'core',
      },
    ];
  };
}

// ─── No hardcoded secrets ─────────────────────────────────────────────────────

export interface NoHardcodedSecretOptions {
  readonly message?: string | undefined;
}

/**
 * Detects common hardcoded secret patterns: `api_key = "..."`, `token: "..."`, etc.
 * Designed to catch accidental secrets — not a replacement for proper secret scanning.
 */
export function noHardcodedSecret(options: NoHardcodedSecretOptions = {}): Check {
  const pattern =
    /(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key|auth[_-]?token|bearer|password|passwd|private[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i;

  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (pattern.test(line)) {
        violations.push({
          message:
            options.message ??
            'Possible hardcoded secret detected. Use environment variables or a secrets manager.',
          path: file.path,
          line: i + 1,
          severity: 'error',
          source: 'core',
        });
      }
    }
    return violations;
  };
}
