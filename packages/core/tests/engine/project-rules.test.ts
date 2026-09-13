import { mkdtemp, rm, writeFile, mkdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { typescriptSyntaxBackend } from "@gesetz/typescript";
import { runAll } from "../../src/engine/runner";
import { defineConfig, type ResolvedConfig } from "../../src/engine/config";
import { noCycles } from "../../src/primitives/graph";
import { defineArchitecture } from "../../src/architecture";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), "gesetz-project-rules-"));
  await mkdir(nodePath.join(dir, "src/a"), { recursive: true });
  await mkdir(nodePath.join(dir, "src/b"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
  await writeFile(nodePath.join(dir, relative), content, "utf8");
}

function config(rules: ResolvedConfig["rules"], dbPath?: string): ResolvedConfig {
  return defineConfig({
    projectRoot: dir,
    adapters: [typescriptSyntaxBackend],
    rules,
    ...(dbPath !== undefined ? { storage: { kind: "sqlite", path: dbPath } } : {}),
  });
}

const run = (cfg: ResolvedConfig) => Effect.runPromise(runAll(cfg));

describe("noCycles (project rule)", () => {
  it("detects an import cycle from resolved edges", async () => {
    await write("src/a/one.ts", 'import "../b/two";\nexport const one = 1;\n');
    await write("src/b/two.ts", 'import "../a/one";\nexport const two = 2;\n');
    const result = await run(config([noCycles("src/**/*.ts")]));
    const violations = result.byRule.find((r) => r.ruleId === "no-cycles")?.violations ?? [];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("Circular dependency");
    expect(violations[0]?.message).toContain("src/a/one.ts");
    expect(violations[0]?.message).toContain("src/b/two.ts");
  });

  it("reports nothing for acyclic graphs", async () => {
    await write("src/a/one.ts", 'import "../b/two";\nexport const one = 1;\n');
    await write("src/b/two.ts", "export const two = 2;\n");
    const result = await run(config([noCycles("src/**/*.ts")]));
    expect(result.totalViolations).toBe(0);
  });

  it("clears a cached cycle violation when the cycle is fixed", async () => {
    const dbPath = nodePath.join(dir, "cache.db");
    await write("src/a/one.ts", 'import "../b/two";\nexport const one = 1;\n');
    await write("src/b/two.ts", 'import "../a/one";\nexport const two = 2;\n');
    const first = await run(config([noCycles("src/**/*.ts")], dbPath));
    expect(first.totalViolations).toBe(1);

    await write("src/b/two.ts", "export const two = 2;\n");
    const second = await run(config([noCycles("src/**/*.ts")], dbPath));
    expect(second.totalViolations).toBe(0);
  });

  it("re-runs when a file is deleted (deletion can dissolve a cycle)", async () => {
    const dbPath = nodePath.join(dir, "cache.db");
    await write("src/a/one.ts", 'import "../b/two";\nexport const one = 1;\n');
    await write("src/b/two.ts", 'import "../a/one";\nexport const two = 2;\n');
    const first = await run(config([noCycles("src/**/*.ts")], dbPath));
    expect(first.totalViolations).toBe(1);

    await unlink(nodePath.join(dir, "src/b/two.ts"));
    const second = await run(config([noCycles("src/**/*.ts")], dbPath));
    expect(second.totalViolations).toBe(0);
  });
});

describe("defineArchitecture (project rule)", () => {
  it("flags imports from disallowed layers with the legacy message", async () => {
    await write("src/a/index.ts", 'import "../b/helper";\nexport const a = 1;\n');
    await write("src/b/helper.ts", "export const helper = 1;\n");
    const result = await run(
      config(
        defineArchitecture({
          layers: [
            { name: "a", pattern: "src/a/**", canImportFrom: [] },
            { name: "b", pattern: "src/b/**" },
          ],
        }),
      ),
    );
    const violations =
      result.byRule.find((r) => r.ruleId === "architecture-layer-violations")?.violations ?? [];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe("Layer 'a' must not import from layer 'b'. Allowed: [].");
    expect(violations[0]?.path).toBe("src/a/index.ts");
  });

  it("passes when all imports are allowed", async () => {
    await write("src/a/index.ts", 'import "../b/helper";\nexport const a = 1;\n');
    await write("src/b/helper.ts", "export const helper = 1;\n");
    const result = await run(
      config(
        defineArchitecture({
          layers: [
            { name: "a", pattern: "src/a/**", canImportFrom: ["b"] },
            { name: "b", pattern: "src/b/**" },
          ],
        }),
      ),
    );
    expect(result.totalViolations).toBe(0);
  });

  it("flags banned external packages from import markers", async () => {
    await write("src/a/index.ts", 'import React from "react";\nexport const a = 1;\n');
    const result = await run(
      config(
        defineArchitecture({
          layers: [{ name: "a", pattern: "src/a/**" }],
          bannedExternals: { a: ["react"] },
        }),
      ),
    );
    const violations =
      result.byRule.find((r) => r.ruleId === "architecture-layer-violations")?.violations ?? [];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe("Layer 'a' must not import external package 'react'.");
  });

  it("honors explicit forbidden pairs with a custom message", async () => {
    await write("src/a/index.ts", 'import "../b/helper";\nexport const a = 1;\n');
    await write("src/b/helper.ts", "export const helper = 1;\n");
    const result = await run(
      config(
        defineArchitecture({
          layers: [
            { name: "a", pattern: "src/a/**" },
            { name: "b", pattern: "src/b/**" },
          ],
          forbidden: [{ from: "a", to: "b", message: "A must never touch B." }],
        }),
      ),
    );
    const violations =
      result.byRule.find((r) => r.ruleId === "architecture-layer-violations")?.violations ?? [];
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toBe("A must never touch B.");
  });
});
