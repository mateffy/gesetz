import * as nodePath from 'node:path';
import { Effect } from 'effect';
import { TsAdapter, ProjectRoot } from '@gesetz/core';
import type { TsSourceFile } from '@gesetz/core';

/**
 * Resolves a tsconfig path (which may be relative) against the ProjectRoot,
 * then loads the source file via the TsAdapter.
 *
 * All TypeScript checks should use this instead of calling
 * `ts.getSourceFile(path, opts.tsConfigPath)` directly, so that the tsconfig
 * resolves against the configured project root rather than `process.cwd()`.
 *
 * Returns `null` when the adapter is unavailable or the file can't be parsed.
 */
export function loadSourceFile(
  absolutePath: string,
  tsConfigPath: string | undefined,
): Effect.Effect<TsSourceFile | null, never, TsAdapter | ProjectRoot> {
  return Effect.gen(function* () {
    const ts = yield* TsAdapter;
    const root = yield* ProjectRoot;
    const resolved = nodePath.isAbsolute(tsConfigPath ?? '')
      ? (tsConfigPath ?? 'tsconfig.json')
      : nodePath.resolve(root, tsConfigPath ?? 'tsconfig.json');
    return yield* ts.getSourceFile(absolutePath, resolved).pipe(
      Effect.catchTag('TsAdapterError', () => Effect.succeed(null)),
    );
  });
}
