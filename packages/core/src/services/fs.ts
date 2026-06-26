import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { Context, Effect, Layer } from 'effect';
import fastGlob from 'fast-glob';
import micromatch from 'micromatch';
import type { File } from '../engine/rule';
import { FileReadError, GlobError } from '../engine/errors';

export interface GlobOptions {
  cwd?: string | undefined;
  dot?: boolean | undefined;
  ignore?: string[] | undefined;
}

export interface FileSystemService {
  glob(pattern: string | string[], options?: GlobOptions): Effect.Effect<File[], GlobError>;
  readFile(absolutePath: string): Effect.Effect<string, FileReadError>;
  exists(absolutePath: string): Effect.Effect<boolean, never>;
}

export class FileSystem extends Context.Tag('qa/FileSystem')<FileSystem, FileSystemService>() {}

/**
 * The project root directory. Rules use this to resolve relative globs
 * against the configured project rather than `process.cwd()`.
 *
 * Provided by the runner (from `ResolvedConfig.projectRoot`).
 */
export class ProjectRoot extends Context.Tag('qa/ProjectRoot')<ProjectRoot, string>() {}

/** Layer that provides a fixed project root string. */
export const ProjectRootLive = (root: string): Layer.Layer<ProjectRoot> =>
  Layer.succeed(ProjectRoot, nodePath.resolve(root));

/**
 * Optional file-pattern filter applied to all rules.
 *
 * When present (set via `--files <glob>` on the CLI), rules only scan files
 * matching these micromatch globs, and violations for non-matching files are
 * suppressed. External-tool adapters (eslint, oxlint, vitest, …) read this to
 * narrow their own file arguments.
 *
 * `null` means "no filter — scan everything".
 */
export interface FileFilterService {
  /** micromatch globs (relative to projectRoot), or null for no filtering */
  readonly patterns: readonly string[] | null;
  /** Returns true when `path` (repo-relative) should be included. */
  matches(path: string): boolean;
}

export class FileFilter extends Context.Tag('qa/FileFilter')<FileFilter, FileFilterService>() {}

/** Layer that provides a file filter from the given globs. */
export const FileFilterLive = (
  patterns: readonly string[] | null,
): Layer.Layer<FileFilter> =>
  Layer.succeed(FileFilter, {
    patterns,
    matches: (p) =>
      patterns === null || patterns.length === 0
        ? true
        : micromatch.isMatch(p, patterns),
  });

export const FileSystemLive: Layer.Layer<FileSystem> = Layer.effect(
  FileSystem,
  Effect.sync(() => {
    const cwd = process.cwd();

    return {
      glob: (pattern: string | string[], options?: GlobOptions): Effect.Effect<File[], GlobError> => {
        const effectiveCwd = options?.cwd ?? cwd;
        const patterns = Array.isArray(pattern) ? pattern : [pattern];
        const globOptions: fastGlob.Options = {
          cwd: effectiveCwd,
          absolute: false,
          dot: options?.dot ?? false,
          stats: false,
          ...(options?.ignore !== undefined ? { ignore: options.ignore } : {}),
        };
        return Effect.tryPromise({
          try: () => fastGlob(patterns, globOptions),
          catch: (cause) => new GlobError({ pattern, cause }),
        }).pipe(
          Effect.map((paths: string[]) =>
            paths.map((relativePath) => {
              const absolutePath = nodePath.resolve(effectiveCwd, relativePath);
              const content = readFileSafe(absolutePath);
              let stat: nodeFs.Stats | null = null;
              try {
                stat = nodeFs.statSync(absolutePath);
              } catch {
                // ignore
              }
              return buildFile(relativePath, absolutePath, content, stat);
            }),
          ),
        );
      },

      readFile: (absolutePath: string): Effect.Effect<string, FileReadError> =>
        Effect.try({
          try: () => nodeFs.readFileSync(absolutePath, 'utf-8'),
          catch: (cause) => new FileReadError({ path: absolutePath, cause }),
        }),

      exists: (absolutePath: string): Effect.Effect<boolean, never> =>
        Effect.sync(() => nodeFs.existsSync(absolutePath)),
    };
  }),
);

function readFileSafe(absolutePath: string): string {
  try {
    return nodeFs.readFileSync(absolutePath, 'utf-8');
  } catch {
    return '';
  }
}

function buildFile(
  relativePath: string,
  absolutePath: string,
  content: string,
  stat: nodeFs.Stats | null,
): File {
  const name = nodePath.basename(relativePath);
  const ext = nodePath.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const dir = nodePath.dirname(relativePath);
  return {
    path: relativePath,
    absolutePath,
    name,
    stem,
    ext,
    dir: dir === '.' ? '' : dir,
    content,
    size: stat?.size ?? content.length,
    mtimeMs: stat?.mtimeMs ?? 0,
  };
}

/**
 * In-memory FileSystem layer for unit tests.
 * Pass a map of absolute path → content.
 */
export const MemoryFileSystem = (files: Record<string, string>): Layer.Layer<FileSystem> => {
  const cwd = process.cwd();
  return Layer.succeed(FileSystem, {
    glob: (pattern, options) => {
      const effectiveCwd = options?.cwd ?? cwd;
      const patterns = Array.isArray(pattern) ? pattern : [pattern];
      const syncOptions: fastGlob.Options = {
        cwd: effectiveCwd,
        ...(options?.ignore !== undefined ? { ignore: options.ignore } : {}),
      };

      const matched = Object.entries(files).filter(([p]) => {
        try {
          // Try to match using fast-glob
          const results = fastGlob.sync(patterns, syncOptions);
          const abs = nodePath.isAbsolute(p) ? p : nodePath.resolve(effectiveCwd, p);
          return results.some((r) => nodePath.resolve(effectiveCwd, r) === abs);
        } catch {
          return false;
        }
      });

      return Effect.succeed(
        matched.map(([p, content]) => {
          const absolutePath = nodePath.isAbsolute(p) ? p : nodePath.resolve(effectiveCwd, p);
          const relativePath = nodePath.isAbsolute(p) ? nodePath.relative(effectiveCwd, p) : p;
          return buildFile(relativePath, absolutePath, content, null);
        }),
      );
    },

    readFile: (absolutePath) => {
      const rel = nodePath.relative(cwd, absolutePath);
      const content = files[absolutePath] ?? files[rel];
      return content !== undefined
        ? Effect.succeed(content)
        : Effect.fail(
            new FileReadError({ path: absolutePath, cause: `not found in memory: ${absolutePath}` }),
          );
    },

    exists: (absolutePath) => {
      const rel = nodePath.relative(cwd, absolutePath);
      return Effect.succeed(absolutePath in files || rel in files);
    },
  });
};
