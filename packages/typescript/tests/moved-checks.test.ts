import { describe, it, expect } from "vitest";
import * as nodePath from "node:path";
import { makeFile, makeCheckServices, runCheck } from "@gesetz/core";
import type { CheckServices } from "@gesetz/core";
import {
  noConsoleLog,
  noEmptyCatch,
  noMagicNumbers,
  noTrivialComment,
  relativeImports,
} from "../src";

const CWD = process.cwd();

// ─── Pure sync checks — need no services at all ─────────────────────────────

describe("noConsoleLog (moved from core)", () => {
  it("flags console.log", async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile("src/foo.ts", 'console.log("hello");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-console-log");
  });

  it("flags warn and error by default", async () => {
    const v = await runCheck(
      noConsoleLog(),
      makeFile("src/foo.ts", 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
  });

  it("allows warn and error when allowWarnError is true", async () => {
    const v = await runCheck(
      noConsoleLog({ allowWarnError: true }),
      makeFile("src/foo.ts", 'console.warn("w");\nconsole.error("e");'),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe("noEmptyCatch (moved from core)", () => {
  it("flags empty catch block", async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile("src/foo.ts", "try { x(); } catch { \n }"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe("no-empty-catch");
  });

  it("passes when catch has a body", async () => {
    const v = await runCheck(
      noEmptyCatch(),
      makeFile("src/foo.ts", "try {\n  x();\n} catch (e) {\n  log(e);\n}"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe("noMagicNumbers (moved from core)", () => {
  it("flags unexplained numeric literals", async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile("src/foo.ts", "const r = value * 42;"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("42");
  });

  it("ignores named constants and the default ignore list", async () => {
    const v = await runCheck(
      noMagicNumbers(),
      makeFile("src/foo.ts", "const MAX_RETRIES = 3;\nreturn x === 0 || x === 1;"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

describe("noTrivialComment (moved from core)", () => {
  it("flags narrative comments", async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile("src/foo.ts", "// Import the module\n// Define the component"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(2);
    expect(v[0]?.rule).toBe("no-trivial-comment");
  });

  it("ignores meaningful comments", async () => {
    const v = await runCheck(
      noTrivialComment(),
      makeFile("src/foo.ts", "// This explains why we retry on ECONNRESET"),
      makeCheckServices(),
    );
    expect(v).toHaveLength(0);
  });
});

// ─── relativeImports — needs fs.exists ──────────────────────────────────────

describe("relativeImports (moved from core)", () => {
  it("passes when all relative imports resolve", async () => {
    const file = makeFile(
      "src/foo.ts",
      `import { x } from './bar';\nimport { y } from './baz/index';`,
    );
    const services = makeCheckServices({
      projectRoot: CWD,
      files: {
        [nodePath.resolve(CWD, "src/bar.ts")]: "",
        [nodePath.resolve(CWD, "src/baz/index.ts")]: "",
      },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it("fails when a relative import does not resolve", async () => {
    const file = makeFile("src/foo.ts", `import { x } from './missing';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("./missing");
  });

  it("ignores non-relative imports", async () => {
    const file = makeFile("src/foo.ts", `import React from 'react';\nimport { z } from 'zod';`);
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });

  it("resolves .tsx extensions", async () => {
    const file = makeFile("src/foo.ts", `import { Comp } from './Comp';`);
    const services = makeCheckServices({
      projectRoot: CWD,
      files: { [nodePath.resolve(CWD, "src/Comp.tsx")]: "" },
    });
    const v = await runCheck(relativeImports(), file, services);
    expect(v).toHaveLength(0);
  });
});
