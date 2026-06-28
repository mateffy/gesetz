/**
 * Structure checks — file/function size, nesting, dead code patterns.
 *
 * All checks use text analysis only (no AST required) so they work on
 * any language. For AST-level checks (function line count) prefer the
 * TypeScript adapter primitives.
 */
import { Effect } from 'effect';
import type { Check, Violation } from '../../engine/rule';

// ─── God file ────────────────────────────────────────────────────────────────

export interface NoGodFileOptions {
  /** Maximum allowed lines. Default: 400 */
  readonly maxLines?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags files that exceed a line-count threshold.
 *
 * @example
 * select('src/**\/*.ts').category('structure').check(noGodFile({ maxLines: 300 }))
 */
export function noGodFile(options: NoGodFileOptions = {}): Check {
  const maxLines = options.maxLines ?? 400;
  return (file) =>
    Effect.sync(() => {
      const count = file.content.split('\n').length;
      if (count <= maxLines) return [];
      return [
        {
          rule: 'no-god-file',
          message:
            options.message ??
            `File has ${count} lines (max: ${maxLines}). Split into smaller modules.`,
          path: file.path,
          line: maxLines + 1,
          severity: 'warn' as const,
          source: 'core' as const,
        },
      ];
    });
}

// ─── Deep nesting ─────────────────────────────────────────────────────────────

export interface NoDeepNestingOptions {
  /** Maximum allowed nesting level. Default: 4 */
  readonly maxLevels?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * Detects deep brace/control-flow nesting via indentation heuristic.
 * Counts leading spaces / tab-width (4) as nesting level.
 */
export function noDeepNesting(options: NoDeepNestingOptions = {}): Check {
  const maxLevels = options.maxLevels ?? 4;
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!line.trim()) continue;
        const indent = line.match(/^(\s+)/)?.[1] ?? '';
        const level = indent.includes('\t') ? indent.length : Math.floor(indent.length / 2);
        if (level > maxLevels) {
          violations.push({
            rule: 'no-deep-nesting',
            message:
              options.message ??
              `Nesting level ${level} exceeds maximum (${maxLevels}). Refactor using early returns or extracted functions.`,
            path: file.path,
            line: i + 1,
            severity: 'warn' as const,
            source: 'core' as const,
          });
        }
      }
      // Deduplicate: only report the first violation per block
      return violations.slice(0, 10);
    });
}

// ─── Console log ─────────────────────────────────────────────────────────────

export interface NoConsoleLogOptions {
  /**
   * Allow `console.warn` and `console.error`. Default: false (ban all console.*).
   */
  readonly allowWarnError?: boolean | undefined;
  readonly message?: string | undefined;
}

/**
 * Bans `console.log` (and optionally all `console.*`) in production files.
 */
export function noConsoleLog(options: NoConsoleLogOptions = {}): Check {
  const pattern = options.allowWarnError
    ? /\bconsole\.(log|debug|info)\s*\(/g
    : /\bconsole\.(log|debug|info|warn|error)\s*\(/g;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (pattern.test(line)) {
          violations.push({
            rule: 'no-console-log',
            message:
              options.message ??
              'Remove console logging from production code. Use a proper logger instead.',
            path: file.path,
            line: i + 1,
            severity: 'warn' as const,
            source: 'core' as const,
          });
        }
        pattern.lastIndex = 0;
      }
      return violations;
    });
}

// ─── Empty catch ──────────────────────────────────────────────────────────────

export interface NoEmptyCatchOptions {
  readonly message?: string | undefined;
}

/**
 * Detects empty or trivially-commented catch blocks that swallow errors.
 */
export function noEmptyCatch(options: NoEmptyCatchOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      // Simple state machine: look for catch { with no real body
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/\}\s*catch\s*(\([^)]*\))?\s*\{/.test(line) || /catch\s*(\([^)]*\))?\s*\{/.test(line)) {
          // Check next 3 lines for real content
          const body = lines
            .slice(i + 1, i + 4)
            .map((l) => l.trim())
            .filter((l) => l && l !== '}' && !l.startsWith('//') && !l.startsWith('*'));
          if (body.length === 0) {
            violations.push({
              rule: 'no-empty-catch',
              message:
                options.message ??
                'Empty catch block swallows errors. Log, rethrow, or handle explicitly.',
              path: file.path,
              line: i + 1,
              severity: 'error' as const,
              source: 'core' as const,
            });
          }
        }
      }
      return violations;
    });
}

// ─── Magic numbers ────────────────────────────────────────────────────────────

export interface NoMagicNumbersOptions {
  /** Numbers that are always allowed. Default: [0, 1, -1, 2, 100] */
  readonly ignore?: number[] | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags unexplained numeric literals in non-constant positions.
 * Only flags integers/floats not assigned to a SCREAMING_SNAKE_CASE const.
 */
export function noMagicNumbers(options: NoMagicNumbersOptions = {}): Check {
  const ignore = new Set<number>(options.ignore ?? [0, 1, -1, 2, 100]);
  // Match numeric literals not in const UPPER_SNAKE = N; or enum values
  const numericLit = /(?<!\w)(-?\d+\.?\d*)(?!\w)/g;
  const constDecl = /^\s*(?:export\s+)?(?:const|readonly)\s+[A-Z][A-Z_0-9]+\s*=/;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Skip named constant declarations and comment lines
        if (constDecl.test(line) || /^\s*\/\//.test(line) || /^\s*\*\//.test(line)) continue;
        let match: RegExpExecArray | null;
        numericLit.lastIndex = 0;
        while ((match = numericLit.exec(line)) !== null) {
          const val = parseFloat(match[0] ?? '');
          if (!Number.isFinite(val) || ignore.has(val)) continue;
          violations.push({
            rule: 'no-magic-number',
            message:
              options.message ??
              `Magic number ${match[0]}. Extract to a named constant with a descriptive name.`,
            path: file.path,
            line: i + 1,
            severity: 'warn' as const,
            source: 'core' as const,
          });
        }
      }
      return violations.slice(0, 20); // cap output
    });
}

// ─── Trivial comments ─────────────────────────────────────────────────────────

export interface NoTrivialCommentOptions {
  readonly message?: string | undefined;
}

/**
 * Detects AI-generated narration comments that just restate the code.
 * Examples: `// Import React`, `// Define the component`, `// Return JSX`
 */
export function noTrivialComment(options: NoTrivialCommentOptions = {}): Check {
  // Patterns that match AI-narration: "// Verb the Noun" or section dividers
  const narrationPattern =
    /^\s*\/\/\s*(?:import|define|create|add|set|update|delete|remove|return|export|initialize|handle|check|call|use|get|fetch|render|make|build|iterate|loop|map|filter)\s+\w/i;
  const dividerPattern = /^\s*\/\/\s*[-=*]{5,}/;

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (narrationPattern.test(line) || dividerPattern.test(line)) {
          violations.push({
            rule: 'no-trivial-comment',
            message:
              options.message ??
              'Trivial or narrative comment. Remove it — good code is self-explanatory.',
            path: file.path,
            line: i + 1,
            severity: 'info' as const,
            source: 'core' as const,
          });
        }
      }
      return violations;
    });
}

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

  return (file) =>
    Effect.sync(() => {
      const hit =
        builtIn.test(file.name) ||
        (options.extraPatterns?.some((p) => p.test(file.name)) ?? false);
      if (!hit) return [];
      return [
        {
          rule: 'no-debugging-residue-files',
          message:
            options.message ??
            `File name '${file.name}' looks like a debugging artefact. Delete it or rename to the correct name.`,
          path: file.path,
          severity: 'error' as const,
          source: 'core' as const,
        },
      ];
    });
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

  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (pattern.test(line)) {
          violations.push({
            rule: 'no-hardcoded-secret',
            message:
              options.message ??
              'Possible hardcoded secret detected. Use environment variables or a secrets manager.',
            path: file.path,
            line: i + 1,
            severity: 'error' as const,
            source: 'core' as const,
          });
        }
      }
      return violations;
    });
}
