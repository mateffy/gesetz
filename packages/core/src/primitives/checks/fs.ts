import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import type { Check, Violation } from '../../engine/rule';

/** How far up to look for a package.json before giving up. */
const MAX_PACKAGE_WALK = 12;

/** The nearest directory at or above `dir` that holds a package.json. */
function findPackageRoot(dir: string): string | null {
  let current = dir;
  for (let depth = 0; depth < MAX_PACKAGE_WALK; depth++) {
    if (nodeFs.existsSync(nodePath.join(current, 'package.json'))) return current;
    const parent = nodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Every path a test for `file` could plausibly live at.
 *
 * Two conventions are supported, because real repositories use both:
 *
 *   co-located   `src/foo/bar.ts`          -> `src/foo/bar.test.ts`
 *   tests dir    `src/foo/bar.ts`          -> `tests/foo/bar.test.ts`
 *                `src/foo/bar.ts`          -> `tests/bar.test.ts`
 *
 * The `tests` form mirrors the path under `src`, which is what this repository
 * does. Exported so the discovery rules can be tested directly rather than only
 * through a filesystem.
 */
export function testCandidates(
  absolutePath: string,
  suffixes: readonly string[],
): string[] {
  const dir = nodePath.dirname(absolutePath);
  const stem = nodePath.basename(absolutePath).replace(/\.[^.]+$/, '');
  const out: string[] = [];

  // co-located
  for (const suffix of suffixes) out.push(nodePath.join(dir, stem + suffix));

  const pkgRoot = findPackageRoot(dir);
  if (pkgRoot === null) return out;

  // under `tests/`, mirroring the path below `src` when the file is inside src
  const srcDir = nodePath.join(pkgRoot, 'src');
  const rel = nodePath.relative(srcDir, dir);
  const mirrored = rel.startsWith('..') || nodePath.isAbsolute(rel) ? '' : rel;
  for (const suffix of suffixes) {
    out.push(nodePath.join(pkgRoot, 'tests', mirrored, stem + suffix));
    out.push(nodePath.join(pkgRoot, 'tests', stem + suffix));
  }
  return out;
}

export interface RequireTestOptions {
  /** Test file suffixes to look for. Default: `.test.ts`, `.test.tsx`, `.spec.ts`. */
  readonly suffixes?: readonly string[] | undefined;
  readonly message?: string | undefined;
  readonly severity?: Violation['severity'] | undefined;
}

/**
 * Checks that a test file exists for this file, under either convention.
 *
 * `requireSibling('.test.ts')` only ever looked next to the source. A repository
 * that keeps tests in `tests/` therefore reported a missing test for every file
 * even when the test existed two directories away, and seven such false errors
 * were failing the build here. This finds both layouts and, when it fails, names
 * every path it looked in so the mismatch is visible.
 *
 * @example
 * // every source file in a package
 * select('packages/core/src').check(requireTest())
 */
export function requireTest(options: RequireTestOptions = {}): Check {
  const suffixes = options.suffixes ?? ['.test.ts', '.test.tsx', '.spec.ts'];
  return async (file, { fs }) => {
    const candidates = testCandidates(file.absolutePath, suffixes);
    for (const candidate of candidates) {
      if (await fs.exists(candidate)) return [];
    }
    const looked = candidates.map((c) => nodePath.relative(process.cwd(), c)).join('\n  ');
    return [
      {
        severity: options.severity ?? 'error',
        source: 'core',
        message:
          options.message ??
          `No test file found for ${file.path}. Looked in:\n  ${looked}`,
        path: file.path,
      },
    ];
  };
}

/**
 * Checks that a sibling file with the given suffix exists.
 *
 * @example
 * // Every Foo.tsx must have a sibling Foo.stories.tsx
 * requireSibling('.stories.tsx')
 */
export function requireSibling(
  suffix: string,
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return async (file, { fs }) => {
    const siblingPath = nodePath.join(
      nodePath.dirname(file.absolutePath),
      file.stem + suffix,
    );
    const exists = await fs.exists(siblingPath);
    if (exists) {
      return [];
    }
    return [
      {
        severity: opts.severity ?? 'error',
        source: 'core',
        message:
          opts.message ??
          `Missing sibling file: ${file.stem}${suffix}`,
        path: file.path,
      },
    ];
  };
}

/**
 * Checks that each matched directory contains all the required child file names.
 * Applied to files — uses the file's directory.
 *
 * @example
 * // Every directory with an index.ts must also have a types.ts
 * requireChildren(['types.ts', 'interface.ts'])
 */
export function requireChildren(
  requiredPaths: string[],
  opts: { message?: (missing: string) => string } = {},
): Check {
  return async (file, { fs }) => {
    const dir = nodePath.dirname(file.absolutePath);
    const violations: Violation[] = [];

    for (const required of requiredPaths) {
      const childPath = nodePath.join(dir, required);
      const exists = await fs.exists(childPath);
      if (!exists) {
        violations.push({
          severity: 'error',
          source: 'core',
          message:
            opts.message?.(required) ??
            `Missing required file: ${required}`,
          path: file.path,
        });
      }
    }

    return violations;
  };
}

/**
 * A check that marks any matched file as a violation.
 * Useful for enforcing that certain files do not exist.
 *
 * @example
 * select('src/scripts/node_modules/**').label('No node_modules in src').check(forbidFile())
 */
export function forbidFile(
  opts: { message?: string; severity?: Violation['severity'] } = {},
): Check {
  return async (file) => [
    {
      severity: opts.severity ?? 'error',
      source: 'core',
      message: opts.message ?? `File should not exist: ${file.path}`,
      path: file.path,
    },
  ];
}

/**
 * Checks that all relative imports in the file resolve to existing files.
 *
 * Recognizes `.ts`, `.tsx`, `/index.ts`, and `/index.tsx` resolution.
 *
 * @example
 * select('src/scripts/\*.{ts,tsx}').label('Relative imports must resolve').check(relativeImports())
 */
export function relativeImports(opts: { message?: (imp: string) => string } = {}): Check {
  return async (file, { fs }) => {
    // Match ES import/export from relative paths
    const matches = [...file.content.matchAll(/from\s+['"](\.[./][^'"]*)['"]/g)];
    const violations: Violation[] = [];

    for (const match of matches) {
      const imp = match[1];
      if (imp === undefined) continue;

      const base = nodePath.resolve(nodePath.dirname(file.absolutePath), imp);
      const cleanBase = base.replace(/\.[jt]sx?$/, '');

      const candidates = [
        cleanBase + '.ts',
        cleanBase + '.tsx',
        cleanBase + '/index.ts',
        cleanBase + '/index.tsx',
        base, // bare path (rare)
      ];

      let found = false;
      for (const candidate of candidates) {
        const exists = await fs.exists(candidate);
        if (exists) {
          found = true;
          break;
        }
      }

      if (!found) {
        violations.push({
          severity: 'error',
          source: 'core',
          message:
            opts.message?.(imp) ??
            `Relative import '${imp}' does not resolve to an existing file`,
          path: file.path,
        });
      }
    }

    return violations;
  };
}
