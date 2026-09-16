/**
 * Structure checks — file/function size, nesting, dead code patterns.
 *
 * All checks use text analysis only (no AST required) so they work on
 * any language. For AST-level checks (function line count) prefer the
 * TypeScript adapter primitives.
 */
import type { Check, Violation } from '../../engine/rule';

/** Default line budget for noGodFile. */
const DEFAULT_MAX_LINES = 400;
/** Default indentation budget for noDeepNesting. */
const DEFAULT_MAX_LEVELS = 4;

// ─── God file ────────────────────────────────────────────────────────────────

export interface NoGodFileOptions {
  /** Maximum allowed lines. Default: 400 */
  readonly maxLines?: number | undefined;
  readonly message?: string | undefined;
}

/**
 * Flags files that exceed a line-count threshold.
 *
 * @deprecated Use oxlint's `max-lines`, which is maintained upstream:
 *
 * ```jsonc
 * // .oxlintrc.json
 * { "rules": { "max-lines": ["error", { "max": 400 }] } }
 * ```
 *
 * Kept for languages oxlint does not cover and for projects without it. Expect
 * removal in a future major version.
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
 * Flags deeply nested code using an **indentation** heuristic: it counts leading
 * whitespace, so a callback passed to `.pipe(...)` adds a level exactly as a
 * nested `if` does, and continuation lines are counted too.
 *
 * That is not control-flow depth, and the difference is not academic: run against
 * this repository it reported 227 warnings, the large majority of which were not
 * nesting at all (164 of them were ordinary level-6 indentation).
 *
 * @deprecated Use oxlint's `eslint/max-depth`, which measures real block nesting
 * from the AST, plus `eslint/max-nested-callbacks` for callback depth. Both match
 * ESLint's semantics, are maintained upstream, and live in oxlint's `pedantic`
 * category (off by default):
 *
 * ```jsonc
 * // .oxlintrc.json
 * {
 *   "rules": {
 *     "max-depth": ["error", { "max": 4 }],
 *     "max-nested-callbacks": ["error", { "max": 3 }]
 *   }
 * }
 * ```
 *
 * Kept only for languages oxlint does not cover and for projects without it.
 * Expect removal in a future major version.
 */
export function noDeepNesting(options: NoDeepNestingOptions = {}): Check {
  const maxLevels = options.maxLevels ?? DEFAULT_MAX_LEVELS;
  return async (file) => {
    const violations: Violation[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!line.trim()) continue;
      const indent = line.match(/^(\s+)/)?.[1] ?? '';
      const level = indent.includes('\t') ? indent.length : Math.floor(indent.length / 2);
      if (level > maxLevels) {
        violations.push({
          message:
            options.message ??
            `Nesting level ${level} exceeds maximum (${maxLevels}). Refactor using early returns or extracted functions.`,
          path: file.path,
          line: i + 1,
          severity: 'warn',
          source: 'core',
        });
      }
    }
    // Deduplicate: only report the first violation per block
    return violations.slice(0, 10);
  };
}

// ─── Console log ─────────────────────────────────────────────────────────────

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
