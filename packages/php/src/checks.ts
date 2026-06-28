import { Effect } from 'effect';
import type { Check, Violation } from '@gesetz/core';

/**
 * Checks that PHP files declare strict types.
 * This is a text-based check — no tree-sitter required.
 *
 * @example
 * select('app/**\/*.php').label('PHP strict types required').check(strictTypes())
 */
export function strictTypes(opts: { message?: string } = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const hasDeclaration = /declare\s*\(\s*strict_types\s*=\s*1\s*\)/.test(file.content);
      if (hasDeclaration) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message: opts.message ?? `Missing declare(strict_types=1) in ${file.name}`,
          path: file.path,
        },
      ];
    });
}

/**
 * Checks that the PHP namespace matches the PSR-4 directory structure.
 * The namespace is extracted from the file content and compared to the file path.
 *
 * @example
 * psrNamespace({ baseNamespace: 'App', basePath: 'app' })
 */
export function psrNamespace(opts: {
  baseNamespace: string;
  basePath: string;
  message?: string;
}): Check {
  return (file) =>
    Effect.sync(() => {
      const namespaceMatch = /^\s*namespace\s+([\w\\]+)\s*;/m.exec(file.content);
      if (!namespaceMatch) return [];

      const declaredNamespace = namespaceMatch[1] ?? '';
      const relativePath = file.dir.replace(/\\/g, '/');

      // Remove basePath prefix
      const normalizedBase = opts.basePath.replace(/^\/|\/$/g, '');
      const normalizedDir = relativePath.replace(/^\/|\/$/g, '');

      let pathAfterBase = normalizedDir;
      if (normalizedBase && normalizedDir.startsWith(normalizedBase)) {
        pathAfterBase = normalizedDir.slice(normalizedBase.length).replace(/^\//, '');
      } else if (normalizedBase && !normalizedDir.startsWith(normalizedBase)) {
        return []; // File is outside the base path — skip
      }

      // Construct expected namespace from path
      const pathSegments = pathAfterBase ? pathAfterBase.split('/') : [];
      const expectedNamespace = [opts.baseNamespace, ...pathSegments]
        .filter(Boolean)
        .join('\\');

      if (declaredNamespace === expectedNamespace) return [];

      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message:
            opts.message ??
            `Namespace '${declaredNamespace}' does not match expected '${expectedNamespace}'`,
          path: file.path,
        },
      ];
    });
}

/**
 * Checks that the file does not use any of the provided call patterns.
 * Patterns are user-supplied and matched line-by-line.
 *
 * This check is intentionally generic — the caller provides the framework-specific
 * patterns. Examples:
 * - Laravel: `['DB::table', 'DB::raw', 'DB::statement']`
 * - WordPress: `['$wpdb->query', '$wpdb->get_results']`
 * - Raw PHP: `['PDO::query', 'mysqli_query']`
 *
 * @example
 * // Laravel — no inline raw DB queries
 * noInlineQueries(['DB::table', 'DB::raw'], { message: 'Use Eloquent instead of DB::' })
 */
export function noInlineQueries(
  patterns: string[],
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const matched = patterns.find((pattern) => line.includes(pattern));
        if (matched) {
          violations.push({
            rule: '',
            severity: opts.severity ?? 'error',
            source: 'core',
            message: opts.message ?? `Forbidden call pattern: ${matched}`,
            path: file.path,
            line: i + 1,
          });
        }
      }

      return violations;
    });
}

// ─── requireTypeHints ───────────────────────────────────────────────────────

export interface RequireTypeHintsOptions {
  readonly message?: string;
}

/**
 * Checks that function parameters have type hints.
 * A param without a type hint looks like `($varname)` rather than `(Type $varname)`.
 *
 * Text-based (regex on function signatures).
 */
export function requireTypeHints(opts: RequireTypeHintsOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const lines = file.content.split('\n');
      const violations: Violation[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Find function declarations: function name(params)
        const fnMatch = /\bfunction\s+\w+\s*\(([^)]*)\)/.exec(line);
        if (!fnMatch) continue;
        const params = fnMatch[1]?.split(',') ?? [];
        for (const param of params) {
          const trimmed = param.trim();
          if (!trimmed || trimmed === '...') continue;
          // A typed param does NOT start with `$` (the type comes first).
          // Untyped: `$x`, `&$x`, `...$x`, `&$x = null`.
          if (/^[&.]*\$/.test(trimmed)) {
            const paramName = trimmed.replace(/^[&.]+/, '').split('=')[0]?.trim() ?? trimmed;
            violations.push({
              rule: '',
              severity: 'warn' as const,
              source: 'core' as const,
              message: opts.message ?? `Function parameter '${paramName}' is missing a type hint`,
              path: file.path,
              line: i + 1,
            });
          }
        }
      }
      return violations;
    });
}

// ─── requireReturnType ─────────────────────────────────────────────────────

export interface RequireReturnTypeOptions {
  readonly message?: string;
}

/**
 * Checks that function declarations have return type declarations (`: string`,
 * `: void`, etc.). Text-based.
 */
export function requireReturnType(opts: RequireReturnTypeOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const lines = file.content.split('\n');
      const violations: Violation[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Match `function name(...) {` or `function name(...):` — we want to flag
        // those WITHOUT a `:` return type after the closing paren.
        const fnMatch = /\bfunction\s+\w+\s*\(([^)]*)\)\s*(:|\{)/.exec(line);
        if (!fnMatch) continue;
        const after = fnMatch[2];
        if (after === ':') continue; // has a return type
        violations.push({
          rule: '',
          severity: 'warn' as const,
          source: 'core' as const,
          message: opts.message ?? `Function is missing a return type declaration`,
          path: file.path,
          line: i + 1,
        });
      }
      return violations;
    });
}

// ─── requireNamespace ───────────────────────────────────────────────────────

export interface RequireNamespaceOptions {
  readonly message?: string;
}

/**
 * Checks that the file declares a `namespace`. Text-based.
 */
export function requireNamespace(opts: RequireNamespaceOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      if (/^\s*namespace\s+[\w\\]+\s*;/m.test(file.content)) return [];
      return [
        {
          rule: '',
          severity: 'error' as const,
          source: 'core' as const,
          message: opts.message ?? `Missing namespace declaration`,
          path: file.path,
        },
      ];
    });
}

// ─── noDieOrExit ──────────────────────────────────────────────────────────────

export interface NoDieOrExitOptions {
  readonly message?: string;
}

/**
 * Bans `die(` and `exit(`. Text-based regex.
 */
export function noDieOrExit(opts: NoDieOrExitOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/(?<![\w.])\b(?:die|exit)\s*\(/.test(line)) {
          violations.push({
            rule: '',
            severity: 'error' as const,
            source: 'core' as const,
            message: opts.message ?? `Avoid die()/exit() — handle errors explicitly`,
            path: file.path,
            line: i + 1,
          });
        }
      }
      return violations;
    });
}

// ─── noEval ─────────────────────────────────────────────────────────────────

export interface NoEvalOptions {
  readonly message?: string;
}

/**
 * Bans `eval(`. Text-based regex.
 */
export function noEval(opts: NoEvalOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (/(?<![\w.])\beval\s*\(/.test(line)) {
          violations.push({
            rule: '',
            severity: 'error' as const,
            source: 'core' as const,
            message: opts.message ?? `Avoid eval() — it is unsafe and hard to reason about`,
            path: file.path,
            line: i + 1,
          });
        }
      }
      return violations;
    });
}

// ─── requireFinalClasses ─────────────────────────────────────────────────────

export interface RequireFinalClassesOptions {
  readonly message?: string;
}

/**
 * Checks that class declarations include the `final` keyword. Text-based.
 * Skips abstract classes (which cannot be final) and anonymous classes.
 */
export function requireFinalClasses(opts: RequireFinalClassesOptions = {}): Check {
  return (file) =>
    Effect.sync(() => {
      const violations: Violation[] = [];
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Match `class Name` declarations (not `new class`, not `abstract class`).
        const classMatch = /^\s*(?:(?:final|abstract)\s+)*class\s+(\w+)/.exec(line);
        if (!classMatch) continue;
        // Skip abstract classes (cannot be final) and anonymous classes.
        if (/\babstract\s+class\b/.test(line)) continue;
        if (/\bfinal\s+class\b/.test(line)) continue;
        const name = classMatch[1] ?? '';
        violations.push({
          rule: '',
          severity: 'warn' as const,
          source: 'core' as const,
          message: opts.message ?? `Class '${name}' should be declared final`,
          path: file.path,
          line: i + 1,
        });
      }
      return violations;
    });
}
