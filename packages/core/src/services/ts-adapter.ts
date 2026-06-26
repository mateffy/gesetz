/**
 * TsAdapter — abstract service tag + stub.
 *
 * The LIVE implementation lives in /typescript (TsAdapterLive).
 * This file contains only the interface, Context.Tag, and a no-op stub
 * so that /core has zero ts-morph dependency.
 */
import { Context, Effect, Layer } from 'effect';
import { TsAdapterError } from '../engine/errors';

export interface TsSourceFile {
  getFilePath(): string;
  getText(): string;
  /** ts-morph SourceFile. Typed as `any` to avoid importing ts-morph in core. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly _tsMorph: any;
}

export interface TsAdapterService {
  getSourceFile(
    absolutePath: string,
    tsConfigPath: string,
  ): Effect.Effect<TsSourceFile, TsAdapterError>;
  isAvailable(): Effect.Effect<boolean, never>;
}

export class TsAdapter extends Context.Tag('qa/TsAdapter')<TsAdapter, TsAdapterService>() {}

/**
 * Stub layer — always reports TsAdapter as unavailable.
 * Use in tests that don't need TypeScript AST analysis.
 * For real AST analysis, provide TsAdapterLive from /typescript.
 */
export const TsAdapterStub: Layer.Layer<TsAdapter> = Layer.succeed(TsAdapter, {
  getSourceFile: (_absolutePath: string, _tsConfigPath: string) =>
    Effect.fail(new TsAdapterError({ cause: 'TsAdapter stub — install /typescript' })),
  isAvailable: () => Effect.succeed(false),
});
