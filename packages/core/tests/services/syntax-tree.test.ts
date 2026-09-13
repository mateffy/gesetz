import { describe, it, expect } from "vitest";
import { Effect, Exit, Cause, Layer } from "effect";
import { SyntaxTreeLive, SyntaxTreeError, SyntaxTree } from "../../src/services/syntax-tree";
import type { SyntaxBackend } from "../../src/services/syntax-tree";
import type { File } from "../../src/engine/rule";

function makeFile(ext: string): File {
  return {
    path: `src/foo${ext}`,
    absolutePath: `/abs/src/foo${ext}`,
    name: `foo${ext}`,
    stem: "foo",
    ext,
    dir: "src",
    content: "test content",
    size: 12,
    mtimeMs: 0,
  };
}

const dummyBackend: SyntaxBackend = {
  extensions: [".ts"],
  extractImports: () => [],
  extractCalls: () => [],
  extractExports: () => [],
  extractStructure: () => [],
};

function runWithLayer(effect: Effect.Effect<unknown, unknown, SyntaxTree>) {
  const layer = SyntaxTreeLive([dummyBackend]);
  return Effect.provide(effect, layer).pipe(Effect.runPromiseExit);
}

describe("SyntaxTreeLive", () => {
  it("fails with SyntaxTreeError when no backend matches the file extension", async () => {
    const file = makeFile(".unknown");
    const effect = Effect.gen(function* () {
      const st = yield* SyntaxTree;
      return yield* st.process(file, { imports: true });
    });

    const exit = await runWithLayer(effect);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.isFailType(exit.cause)).toBe(true);
      if (Cause.isFailType(exit.cause)) {
        const err = exit.cause.error as SyntaxTreeError;
        expect(err).toBeInstanceOf(SyntaxTreeError);
        expect(err.cause).toContain(".unknown");
      }
    }
  });

  it("succeeds when a backend matches the file extension", async () => {
    const file = makeFile(".ts");
    const effect = Effect.gen(function* () {
      const st = yield* SyntaxTree;
      return yield* st.process(file, { imports: true });
    });

    const exit = await runWithLayer(effect);

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
