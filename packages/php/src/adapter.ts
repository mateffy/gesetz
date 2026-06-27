/**
 * PhpAdapterLive — the live tree-sitter-php implementation.
 * tree-sitter and tree-sitter-php are optional peer dependencies.
 * Gracefully degrades when not installed.
 */
import { Effect, Layer } from 'effect';
import { PhpAdapter, PhpAdapterError } from '@regeln/core';
import type { PhpSyntaxNode } from '@regeln/core';

/** Minimal typed view of the tree-sitter Parser. */
interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(content: string): { readonly rootNode: PhpSyntaxNode };
}
interface TreeSitterModule {
  readonly default: new () => TreeSitterParser;
}
/** Minimal typed view of the tree-sitter-php module (exposes `.php` grammar). */
interface TreeSitterPhpModule {
  readonly default: { readonly php: unknown };
}

export const PhpAdapterLive: Layer.Layer<PhpAdapter> = Layer.effect(
  PhpAdapter,
  Effect.gen(function* () {
    const available = yield* Effect.tryPromise({
      try: async () => {
        await import('tree-sitter');
        await import('tree-sitter-php');
        return true;
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => false));

    return {
      parse: (content: string) => {
        if (!available) {
          return Effect.fail(
            new PhpAdapterError({
              message:
                'tree-sitter-php is not installed. Run: bun add tree-sitter tree-sitter-php',
            }),
          );
        }
        return Effect.tryPromise({
          try: async () => {
            const ParserModule = (await import('tree-sitter')) as unknown as TreeSitterModule;
            if (typeof ParserModule.default !== 'function') {
              throw new Error('tree-sitter module does not export Parser class');
            }
            // @ts-ignore — tree-sitter-php is an optional peer dep; present in
            // some workspaces, absent in others. Cast to our minimal interface.
            const PHP = (await import('tree-sitter-php')) as unknown as TreeSitterPhpModule;
            if (!PHP.default.php) {
              throw new Error('tree-sitter-php module does not export php grammar');
            }
            const parser = new ParserModule.default();
            parser.setLanguage(PHP.default.php);
            const tree = parser.parse(content);
            return tree.rootNode;
          },
          catch: (cause) => new PhpAdapterError({ message: String(cause) }),
        });
      },

      isAvailable: () => Effect.succeed(available),
    };
  }),
);
