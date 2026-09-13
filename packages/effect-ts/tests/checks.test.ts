import { describe, it, expect } from "vitest";
import { makeFile, makeCheckServices, runCheck } from "@gesetz/core";
import {
  noRunPromiseScattered,
  noThrowInEffectGen,
  noYieldWithoutStar,
  noUnboundedEffectAll,
} from "../src/checks";

describe("noRunPromiseScattered", () => {
  it("flags Effect.runPromise outside entry points", async () => {
    const content = `
      import { Effect } from 'effect';
      export const program = Effect.runPromise(Effect.succeed(1));
    `;
    const v = await runCheck(
      noRunPromiseScattered(),
      makeFile("src/lib.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-run-promise-scattered");
    expect(v[0]?.message).toContain("runPromise");
  });

  it("allows Effect.runPromise in entry points", async () => {
    const content = `
      import { Effect } from 'effect';
      Effect.runPromise(main);
    `;
    const v = await runCheck(
      noRunPromiseScattered({ entryPoints: ["src/main.ts"] }),
      makeFile("src/main.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it("allows Effect.runSync in entry points", async () => {
    const content = `
      import { Effect } from 'effect';
      Effect.runSync(main);
    `;
    const v = await runCheck(
      noRunPromiseScattered({ entryPoints: ["src/main.ts"] }),
      makeFile("src/main.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag non-Effect run* calls", async () => {
    const content = `
      const runner = { runPromise: (x: number) => x };
      runner.runPromise(1);
    `;
    const v = await runCheck(
      noRunPromiseScattered(),
      makeFile("src/lib.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe("noThrowInEffectGen", () => {
  it("flags throw inside Effect.gen", async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield* Effect.succeed(1);
        if (x < 0) throw new Error('negative');
        return x;
      });
    `;
    const v = await runCheck(
      noThrowInEffectGen(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-throw-in-effect-gen");
    expect(v[0]?.message).toContain("throw");
  });

  it("ignores throw outside Effect.gen", async () => {
    const content = `
      function plain() {
        if (false) throw new Error('ok');
      }
    `;
    const v = await runCheck(
      noThrowInEffectGen(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it("flags throw inside Effect.fn", async () => {
    const content = `
      import { Effect } from 'effect';
      const work = Effect.fn(function* (n: number) {
        if (n < 0) throw new Error('negative');
        return n;
      });
    `;
    const v = await runCheck(
      noThrowInEffectGen(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
  });
});

describe("noYieldWithoutStar", () => {
  it("flags yield without star in Effect.gen", async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield Effect.succeed(1);
        return x;
      });
    `;
    const v = await runCheck(
      noYieldWithoutStar(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-yield-without-star");
  });

  it("allows yield* with star in Effect.gen", async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.gen(function* () {
        const x = yield* Effect.succeed(1);
        return x;
      });
    `;
    const v = await runCheck(
      noYieldWithoutStar(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it("ignores yield outside Effect.gen", async () => {
    const content = `
      function* plain() {
        yield 1;
      }
    `;
    const v = await runCheck(
      noYieldWithoutStar(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe("noUnboundedEffectAll", () => {
  it("flags Effect.all without concurrency option", async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)]);
    `;
    const v = await runCheck(
      noUnboundedEffectAll(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-unbounded-effect-all");
    expect(v[0]?.message).toContain("concurrency");
  });

  it("allows Effect.all with concurrency option", async () => {
    const content = `
      import { Effect } from 'effect';
      const program = Effect.all([Effect.succeed(1), Effect.succeed(2)], { concurrency: 2 });
    `;
    const v = await runCheck(
      noUnboundedEffectAll(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });

  it("does not flag unrelated Effect calls", async () => {
    const content = `
      import { Effect } from 'effect';
      const x = Effect.succeed(1);
    `;
    const v = await runCheck(
      noUnboundedEffectAll(),
      makeFile("src/test.ts", content),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});
