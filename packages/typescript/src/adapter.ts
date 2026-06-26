/**
 * TsAdapterLive — the live ts-morph implementation of the TsAdapter service.
 * Import this from /typescript and provide it when running rules that
 * use TypeScript AST analysis.
 *
 * @example
 * ```ts
 * import { TsAdapterLive } from '@regeln/typescript';
 * const result = await runAll(config).pipe(
 *   Effect.provide(Layer.mergeAll(FileSystemLive, TsAdapterLive, PhpAdapterStub)),
 *   Effect.runPromise,
 * );
 * ```
 */
import { Effect, Layer, Ref } from 'effect';
import { TsAdapter, TsAdapterError } from '@regeln/core';
import type { TsSourceFile } from '@regeln/core';

/** Lazily-referenced ts-morph Project type, so this file type-checks whether or
 * not ts-morph is resolvable at compile time. */
type TsMorphProject = import('ts-morph').Project;

export const TsAdapterLive: Layer.Layer<TsAdapter> = Layer.effect(
  TsAdapter,
  Effect.gen(function* () {
    const projectRef = yield* Ref.make<TsMorphProject | null>(null);

    const getProject = (tsConfigPath: string) =>
      Effect.gen(function* () {
        const existing = yield* Ref.get(projectRef);
        if (existing !== null) {
          return existing;
        }
        const project = yield* Effect.tryPromise({
          try: async () => {
            const { Project } = await import('ts-morph');
            return new Project({
              tsConfigFilePath: tsConfigPath,
              skipAddingFilesFromTsConfig: true,
              skipFileDependencyResolution: true,
            });
          },
          catch: (cause) => new TsAdapterError({ cause }),
        });
        yield* Ref.set(projectRef, project);
        return project;
      });

    return {
      getSourceFile: (
        absolutePath: string,
        tsConfigPath: string,
      ): Effect.Effect<TsSourceFile, TsAdapterError> =>
        Effect.gen(function* () {
          const project = yield* getProject(tsConfigPath);
          return yield* Effect.try({
            try: () => {
              const existing = project.getSourceFile(absolutePath);
              const sf = existing ?? project.addSourceFileAtPath(absolutePath);
              return {
                getFilePath: () => absolutePath,
                getText: () => sf.getText(),
                _tsMorph: sf,
              } satisfies TsSourceFile;
            },
            catch: (cause) => new TsAdapterError({ cause }),
          });
        }),

      isAvailable: (): Effect.Effect<boolean, never> =>
        Effect.tryPromise({
          try: async () => {
            await import('ts-morph');
            return true;
          },
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => false)),
    };
  }),
);
