/**
 * Testing helpers for writing unit tests against gesetz checks.
 *
 * These are designed for the post-v2.0 async `Check` API where checks
 * receive a `CheckServices` bag instead of pulling services from Effect context.
 *
 * @example
 * ```ts
 * import { makeFile, makeCheckServices, runCheck } from '@gesetz/core';
 * import { noDirectCalls } from '@gesetz/core';
 *
 * const file = makeFile('src/foo.ts');
 * const services = makeCheckServices({
 *   syntax: { calls: [{ name: 'eval', line: 3 }] },
 * });
 * const violations = await runCheck(noDirectCalls(['eval']), file, services);
 * expect(violations).toHaveLength(1);
 * ```
 */

import nodePath from 'node:path';
import type { File, Check, CheckServices, Violation } from './engine/rule';
import type { SyntaxBackendProcessResult, SyntaxTreeProcessOptions } from './services/syntax-tree';

// ─── makeFile ─────────────────────────────────────────────────────────────────

/**
 * Creates a `File` object from a repository-relative path.
 *
 * The absolute path is resolved against `process.cwd()`. All metadata
 * (stem, ext, dir, size, mtimeMs) is derived from the path and content.
 *
 * @param path - Repository-relative path, e.g. `src/components/Button.tsx`
 * @param content - File content (defaults to empty string)
 */
export function makeFile(path: string, content = ''): File {
  const absolutePath = nodePath.resolve(process.cwd(), path);
  const name = nodePath.basename(path);
  const ext = nodePath.extname(name);
  return {
    path,
    absolutePath,
    name,
    stem: name.slice(0, name.length - ext.length),
    ext,
    dir: nodePath.dirname(path),
    content,
    size: content.length,
    mtimeMs: 0,
  };
}

// ─── makeCheckServices ────────────────────────────────────────────────────────

/** Options for {@link makeCheckServices}. */
export interface MakeCheckServicesOptions {
  /**
   * Virtual filesystem.
   *
   * Each key is an **absolute path**. `fs.exists` returns `true` for these
   * paths, and `fs.readFile` returns the corresponding value.
   *
   * @example
   * ```ts
   * makeCheckServices({
   *   projectRoot: '/project',
   *   files: { '/project/src/Button.tsx': 'export default {}' },
   * })
   * ```
   *
   * Use `nodePath.resolve(projectRoot, relativePath)` to build absolute keys
   * — or use {@link makeFile} and grab its `.absolutePath`.
   */
  readonly files?: Record<string, string>;

  /**
   * Override the result of `fs.glob`.
   *
   * @default []
   */
  readonly glob?: readonly File[];

  /**
   * Static data to merge into `syntax.process()` return values.
   *
   * When provided, `process()` returns `{ imports: [], calls: [], exports: [],
   * structure: [], ...syntax }`. This covers 99% of test cases where you just
   * need a fixed set of calls, imports, exports, or structure items.
   *
   * @example
   * ```ts
   * makeCheckServices({ syntax: { calls: [{ name: 'eval', line: 3 }] } })
   * ```
   */
  readonly syntax?: Partial<SyntaxBackendProcessResult>;

  /**
   * Import resolution map.
   *
   * Each key is a **specifier** (e.g. `'./bar'`, `'vitest'`). The value is the
   * absolute path it resolves to, or `null` if unresolvable.
   *
   * @example
   * ```ts
   * makeCheckServices({
   *   imports: { './bar': '/project/src/bar.ts' },
   * })
   * ```
   */
  readonly imports?: Record<string, string | null>;

  /**
   * Absolute path to the project root.
   *
   * @default process.cwd()
   */
  readonly projectRoot?: string;

  /**
   * Escape hatch: override any {@link CheckServices} method directly.
   *
   * Use this when you need dynamic behaviour that the nice options above can't
   * express — e.g. a `syntax.process` that throws for specific files, or a
   * `syntax.canProcess` that varies per file.
   *
   * Values here take precedence over the nice options.
   *
   * @example
   * ```ts
   * makeCheckServices({
   *   overrides: {
   *     syntax: {
   *       process: async (file, options) => {
   *         if (file.name === 'error.ts') throw new Error('boom');
   *         return { imports: [], calls: [], exports: [], structure: [] };
   *       },
   *     },
   *   },
   * })
   * ```
   */
  readonly overrides?: {
    readonly fs?: Partial<CheckServices['fs']>;
    readonly syntax?: Partial<CheckServices['syntax']>;
    readonly imports?: Partial<CheckServices['imports']>;
    readonly projectRoot?: string;
  };
}

/**
 * Builds a fully-typed {@link CheckServices} bag for unit tests.
 *
 * All methods are stubbed to safe, no-op defaults. Use the options to
 * inject test data where your check needs it.
 *
 * For the 1% of cases where you need dynamic mock behaviour (e.g. a process
 * function that throws conditionally), use the `overrides` escape hatch.
 */
export function makeCheckServices(options: MakeCheckServicesOptions = {}): CheckServices {
  const root = options.projectRoot ?? process.cwd();
  const contentMap = options.files ?? {};
  const fileSet = new Set(Object.keys(contentMap));

  const base: CheckServices = {
    fs: {
      glob: async () => (options.glob ?? []) as File[],
      readFile: async (absolutePath: string) => contentMap[absolutePath] ?? '',
      exists: async (absolutePath: string) => fileSet.has(absolutePath),
    },
    syntax: {
      canProcess: (file: File) =>
        ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.php'].includes(file.ext),
      process: async (_file: File, _options: SyntaxTreeProcessOptions): Promise<SyntaxBackendProcessResult> => ({
        imports: [],
        calls: [],
        exports: [],
        structure: [],
        ...options.syntax,
      }),
    },
    imports: {
      resolve: (_fromFile: File, specifier: string): string | null =>
        options.imports?.[specifier] ?? null,
    },
    projectRoot: root,
  };

  // Apply escape hatch overrides.
  if (options.overrides) {
    if (options.overrides.fs) {
      Object.assign(base.fs, options.overrides.fs);
    }
    if (options.overrides.syntax) {
      Object.assign(base.syntax, options.overrides.syntax);
    }
    if (options.overrides.imports) {
      Object.assign(base.imports, options.overrides.imports);
    }
    if (options.overrides.projectRoot !== undefined) {
      base.projectRoot = options.overrides.projectRoot;
    }
  }

  return base;
}

// ─── runCheck ─────────────────────────────────────────────────────────────────

/**
 * Runs a check and returns its violations. A thin wrapper around
 * `check(file, services)` that reads like a test operation.
 *
 * @example
 * ```ts
 * const violations = await runCheck(noImportFrom('lodash'), file, services);
 * ```
 */
export function runCheck(
  check: Check,
  file: File,
  services: CheckServices,
): Promise<Violation[]> {
  return check(file, services);
}