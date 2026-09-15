import { Effect, Layer } from 'effect';
import type { CheckServices } from './rule';
import { FileSystem, FileFilter, FileFilterLive, ProjectRoot } from '../services/fs';
import { ImportResolver } from '../services/import-resolver';
import { SyntaxTree, SyntaxTreeError } from '../services/syntax-tree';

/**
 * Bridges the async `CheckServices` bag onto the Effect service tags that
 * `Rule.run` requires, so project-level rules execute against the same file
 * listing and parsed syntax as per-file checks.
 */
export function servicesLayer(
  services: CheckServices,
  fileFilter: readonly string[] | null,
): Layer.Layer<FileSystem | SyntaxTree | ImportResolver | ProjectRoot | FileFilter> {
  return Layer.mergeAll(
    Layer.succeed(FileSystem, {
      glob: (pattern, options) => Effect.promise(() => services.fs.glob(pattern, options)),
      readFile: (absolutePath) => Effect.promise(() => services.fs.readFile(absolutePath)),
      exists: (absolutePath) => Effect.promise(() => services.fs.exists(absolutePath)),
    }),
    Layer.succeed(SyntaxTree, {
      canProcess: (file) => services.syntax.canProcess(file),
      process: (file, options) =>
        Effect.tryPromise({
          try: () => services.syntax.process(file, options),
          catch: (cause) => new SyntaxTreeError({ cause: String(cause) }),
        }),
    }),
    Layer.succeed(ImportResolver, {
      resolve: (fromFile, specifier) => services.imports.resolve(fromFile, specifier),
    }),
    Layer.succeed(ProjectRoot, services.projectRoot),
    FileFilterLive(fileFilter),
  );
}
