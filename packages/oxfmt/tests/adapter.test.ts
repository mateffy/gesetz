import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import { Effect, Layer } from "effect";
import { oxfmt } from "../src/adapter";
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

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

describe("oxfmt adapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("maps unformatted files to warning violations", async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      () => "src/main.rs\nsrc/lib.rs",
    );

    const rule = oxfmt({ cwd: "/project", label: "oxfmt" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations).toHaveLength(2);
    expect(violations[0]?.rule).toBe("oxfmt");
    expect(violations[0]?.severity).toBe("warn");
    expect(violations[0]?.path).toBe("src/main.rs");
    expect(violations[1]?.path).toBe("src/lib.rs");
  });

  it("returns empty array when all files are formatted", async () => {
    const execError = Object.assign(new Error("exit 1"), { stdout: "", status: 1 });
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw execError;
    });

    const rule = oxfmt({ cwd: "/project" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));
    expect(violations).toEqual([]);
  });

  it("passes config file option with -c", async () => {
    const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
    spy.mockImplementation(() => "");

    const rule = oxfmt({ cwd: "/project", configFile: "oxfmt.toml" });
    await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["--list-different", ".", "-c", "oxfmt.toml"]),
      expect.any(Object),
    );
  });

  it("handles absolute paths by making them relative", async () => {
    (childProcess.execFileSync as ReturnType<typeof vi.fn>).mockImplementation(
      () => "/project/src/main.rs",
    );

    const rule = oxfmt({ cwd: "/project" });
    const violations = await Effect.runPromise(Effect.provide(rule.run, TestLayer));

    expect(violations[0]?.path).toBe("src/main.rs");
  });

  describe("FileFilter integration", () => {
    it("passes FileFilter patterns when --files is active", async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() => "");

      const rule = oxfmt({ cwd: "/project" });
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

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["--list-different", "src/app/**", "src/lib/**"]),
        expect.any(Object),
      );
    });

    it("uses adapter pattern when FileFilter is null", async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() => "");

      const rule = oxfmt({ cwd: "/project", pattern: "src/custom" });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["src/custom"]),
        expect.any(Object),
      );
    });

    it('defaults to [\".\"] when no pattern and no FileFilter', async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() => "");

      const rule = oxfmt({ cwd: "/project" });
      await Effect.runPromise(Effect.provide(rule.run, TestLayer));

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["."]),
        expect.any(Object),
      );
    });

    it("FileFilter patterns override adapter pattern", async () => {
      const spy = childProcess.execFileSync as ReturnType<typeof vi.fn>;
      spy.mockImplementation(() => "");

      const rule = oxfmt({ cwd: "/project", pattern: "src/everything" });
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

      const callArgs = spy.mock.calls[spy.mock.calls.length - 1]?.[1] as string[];
      expect(callArgs).toContain("src/subset/**");
      expect(callArgs).not.toContain("src/everything");
    });
  });
});
