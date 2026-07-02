import { Effect, Layer, Runtime } from 'effect';
import { FileSystem, ProjectRoot, MemoryFileSystem } from '../../src/services/fs';
import { SyntaxTree } from '../../src/services/syntax-tree';
import { ImportResolver } from '../../src/services/import-resolver';
import type { CheckServices } from '../../src/engine/rule';

/**
 * Builds a CheckServices bag from the given Effect layers.
 * Use this in unit tests to run async checks against mocked services.
 */
export async function buildCheckServices(
  ...layers: Layer.Layer<any>[]
): Promise<CheckServices> {
  const program = Effect.gen(function* () {
    const fs = yield* FileSystem;
    const st = yield* SyntaxTree;
    const ir = yield* ImportResolver;
    const root = yield* ProjectRoot;
    const runtime = yield* Effect.runtime<
      FileSystem | SyntaxTree | ImportResolver | ProjectRoot
    >();

    const services: CheckServices = {
      fs: {
        glob: async (pattern, options) =>
          Runtime.runPromise(runtime)(fs.glob(pattern, options)),
        readFile: async (path) => Runtime.runPromise(runtime)(fs.readFile(path)),
        exists: async (path) => Runtime.runPromise(runtime)(fs.exists(path)),
      },
      syntaxTree: {
        canProcess: (file) => st.canProcess(file),
        process: async (file, options) =>
          Runtime.runPromise(runtime)(st.process(file, options)),
      },
      importResolver: {
        resolve: (fromFile, specifier) => ir.resolve(fromFile, specifier),
      },
      projectRoot: root,
    };

    return services;
  });

  // Always include an empty MemoryFileSystem so FileSystem is available
  const allLayers = [MemoryFileSystem({}), ...layers];
  const merged = Layer.mergeAll(allLayers[0]!, ...allLayers.slice(1));
  return Effect.runPromise(Effect.provide(program, merged) as any);
}
