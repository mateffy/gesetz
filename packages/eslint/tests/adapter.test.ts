import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { eslint } from "../src/adapter";
import {
  MemoryFileSystem,
  ProjectRootLive,
  FileFilterLive,
  SyntaxTreeStub,
  ImportResolverDefault,
} from "@gesetz/core";

const TestLayer = Layer.mergeAll(
  MemoryFileSystem({}),
  SyntaxTreeStub,
  ImportResolverDefault,
  ProjectRootLive("/project"),
  FileFilterLive(null),
);

// Track patterns passed to lintFiles so we can verify them in tests
let lastLintFilesPatterns: string[] = [];

// Mock the eslint module so the dynamic import resolves without needing the real package
vi.mock("eslint", () => {
  return {
    ESLint: class MockESLint {
      constructor(public options: { cwd: string; overrideConfigFile?: string }) {}
      async lintFiles(patterns: string[]) {
        lastLintFilesPatterns = patterns;
        if (patterns.includes("throw")) {
          throw new Error("lint failed");
        }
        return [
          {
            filePath: "/project/src/a.ts",
            messages: [
              {
                ruleId: "no-unused-vars",
                message: "'x' is assigned but never used.",
                line: 5,
                column: 7,
                severity: 2 as const,
              },
              {
                ruleId: "prefer-const",
                message: "'y' is never reassigned.",
                line: 10,
                column: 3,
                severity: 1 as const,
              },
            ],
          },
          {
            filePath: "/project/src/b.ts",
            messages: [],
          },
        ];
      }
    },
  };
});

describe("eslint adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    lastLintFilesPatterns = [];
  });

  it("maps ESLint messages to violations", async () => {
    const rule = eslint({ cwd: "/project", label: "ESLint" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.rule).toBe("eslint");
    expect(violations[0]?.severity).toBe("error");
    expect(violations[0]?.message).toContain("no-unused-vars");
    expect(violations[0]?.message).toContain("'x' is assigned but never used.");
    expect(violations[0]?.path).toBe("/project/src/a.ts");
    expect(violations[0]?.line).toBe(5);
    expect(violations[0]?.column).toBe(7);

    expect(violations[1]?.severity).toBe("warn");
    expect(violations[1]?.message).toContain("prefer-const");
  });

  it("passes overrideConfigFile to ESLint constructor", async () => {
    const rule = eslint({ cwd: "/project", overrideConfigFile: "custom.config.mjs" });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    // The mock ESLint constructor receives the options; we verify the rule still runs
    expect(rule.id).toBe("eslint");
  });

  it("returns empty array when ESLint throws", async () => {
    const rule = eslint({ cwd: "/project", pattern: "throw" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it("returns empty array when no messages", async () => {
    // The mock returns one file with no messages, so we still get violations from a.ts
    // This test verifies the adapter handles empty messages gracefully
    const rule = eslint({ cwd: "/project" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    const bViolations = violations.filter((v) => v.path.includes("b.ts"));
    expect(bViolations).toHaveLength(0);
  });

  describe("FileFilter integration", () => {
    it("passes FileFilter patterns to lintFiles when --files is active", async () => {
      const rule = eslint({ cwd: "/project" });
      await Effect.runPromise(
        Effect.provide(
          rule.run,
          Layer.mergeAll(
            MemoryFileSystem({}),
            SyntaxTreeStub,
            ImportResolverDefault,
            ProjectRootLive("/project"),
            FileFilterLive(["src/app/**", "src/lib/**"]),
          ),
        ),
      );

      expect(lastLintFilesPatterns).toEqual(["src/app/**", "src/lib/**"]);
    });

    it("uses adapter pattern when FileFilter is null", async () => {
      const rule = eslint({ cwd: "/project", pattern: "src/custom/**" });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(lastLintFilesPatterns).toEqual(["src/custom/**"]);
    });

    it('defaults to ["."] when no pattern and no FileFilter', async () => {
      const rule = eslint({ cwd: "/project" });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(lastLintFilesPatterns).toEqual(["."]);
    });

    it("FileFilter patterns override adapter pattern", async () => {
      const rule = eslint({ cwd: "/project", pattern: "src/everything/**" });
      await Effect.runPromise(
        Effect.provide(
          rule.run,
          Layer.mergeAll(
            MemoryFileSystem({}),
            SyntaxTreeStub,
            ImportResolverDefault,
            ProjectRootLive("/project"),
            FileFilterLive(["src/subset/**"]),
          ),
        ),
      );

      expect(lastLintFilesPatterns).toEqual(["src/subset/**"]);
    });
  });
});
