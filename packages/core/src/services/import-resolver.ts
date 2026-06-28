/**
 * ImportResolver — abstract service tag + default implementation.
 *
 * Turns module specifiers into absolute file paths. Needed by
 * `defineArchitecture` and `noCycles` to map imports to concrete files.
 *
 * The default implementation handles relative paths only (`./foo`, `../bar`).
 * External packages (anything not starting with `.` or `/`) return `null`.
 * Language adapters can provide better implementations (tsconfig paths,
 * node_modules, PSR-4) but this is optional.
 */
import * as nodePath from 'node:path';
import { Context, Data, Layer } from 'effect';
import type { File } from '../engine/rule';

export interface ImportResolverService {
  /**
   * Resolves a module specifier from a source file to an absolute path.
   * Returns null for external packages (npm packages, etc.) that can't be
   * resolved to a local file.
   *
   * @param fromFile - The file containing the import
   * @param specifier - The raw import specifier, e.g. "./foo", "../bar", "react"
   */
  resolve(fromFile: File, specifier: string): string | null;
}

export class ImportResolver extends Context.Tag('gesetz/ImportResolver')<
  ImportResolver,
  ImportResolverService
>() {}

export class ImportResolveError extends Data.TaggedError('ImportResolveError')<{
  readonly cause: string;
}> {}

/**
 * Default naive resolver: handles relative paths only.
 * External packages (no leading '.' or '/') return null.
 */
export const ImportResolverDefault: Layer.Layer<ImportResolver> = Layer.succeed(ImportResolver, {
  resolve: (fromFile, specifier) => {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      return null; // external package
    }
    return nodePath.resolve(nodePath.dirname(fromFile.absolutePath), specifier);
  },
});
