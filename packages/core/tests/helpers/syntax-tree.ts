import { Layer } from 'effect';
import { SyntaxTree } from '../../src/services/syntax-tree';
import type {
  SyntaxBackendProcessResult,
  SyntaxTreeProcessOptions,
} from '../../src/services/syntax-tree';
import type { File } from '../../src/engine/rule';
import { Effect } from 'effect';

/**
 * Test helper: builds a SyntaxTree Layer that reports `canProcess: true` and
 * returns controlled fixture data from `process`. Use to unit-test
 * SyntaxTree-backed checks without a real parser.
 */
export function makeSyntaxTreeLayer(
  result: Partial<SyntaxBackendProcessResult>,
  opts: { canProcess?: boolean } = {},
): Layer.Layer<SyntaxTree> {
  const full: SyntaxBackendProcessResult = {
    imports: result.imports ?? [],
    calls: result.calls ?? [],
    exports: result.exports ?? [],
    structure: result.structure ?? [],
  };
  return Layer.succeed(SyntaxTree, {
    canProcess: (_file: File) => opts.canProcess ?? true,
    process: (_file: File, _options: SyntaxTreeProcessOptions) =>
      Effect.succeed(full),
  });
}

/** A SyntaxTree Layer that reports no backend available (canProcess: false). */
export const SyntaxTreeUnavailable: Layer.Layer<SyntaxTree> = Layer.succeed(SyntaxTree, {
  canProcess: () => false,
  process: (_file, _opts) =>
    Effect.fail(
      new (class extends Error {
        readonly _tag = 'SyntaxTreeError';
      })(),
    ) as never,
});
