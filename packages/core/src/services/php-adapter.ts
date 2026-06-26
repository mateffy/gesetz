/**
 * PhpAdapter — abstract service tag + stub.
 *
 * The LIVE implementation lives in /php (PhpAdapterLive).
 * This file contains only the interface, Context.Tag, and a no-op stub
 * so that /core has zero tree-sitter dependency.
 */
import { Context, Effect, Layer } from 'effect';
import { PhpAdapterError } from '../engine/errors';

export interface PhpSyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: PhpSyntaxNode[];
  namedChildren: PhpSyntaxNode[];
  childForFieldName(name: string): PhpSyntaxNode | null;
}

export interface PhpAdapterService {
  parse(content: string): Effect.Effect<PhpSyntaxNode, PhpAdapterError>;
  isAvailable(): Effect.Effect<boolean, never>;
}

export class PhpAdapter extends Context.Tag('qa/PhpAdapter')<PhpAdapter, PhpAdapterService>() {}

/**
 * Stub layer — always reports PhpAdapter as unavailable.
 * Use in tests that don't need PHP AST analysis.
 * For real AST analysis, provide PhpAdapterLive from /php.
 */
export const PhpAdapterStub: Layer.Layer<PhpAdapter> = Layer.succeed(PhpAdapter, {
  parse: (_content: string) =>
    Effect.fail(
      new PhpAdapterError({ message: 'PhpAdapter stub — install /php' }),
    ),
  isAvailable: () => Effect.succeed(false),
});
