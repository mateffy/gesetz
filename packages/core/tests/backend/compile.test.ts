import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { defineNetwork, type Network, type SourceFile } from "netzwerk";
import { compileConfig, compileRule, type CompileContext } from "../../src/backend/compile";
import { createCheckServices } from "../../src/backend/check-services";
import { syntaxExtension, SYNTAX_EXTENSION } from "../../src/backend/syntax-extension";
import { isViolationMarker } from "../../src/backend/violation-markers";
import { defineConfig } from "../../src/engine/config";
import type { Check, Rule, Violation } from "../../src/engine/rule";
import { select } from "../../src/primitives/select";

let dir: string;
const networks: Network[] = [];

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), "gesetz-compile-"));
});

afterEach(async () => {
  for (const network of networks.splice(0)) await network.close();
  await rm(dir, { recursive: true, force: true });
});

function track(network: Network): Network {
  networks.push(network);
  return network;
}

async function write(relative: string, content: string): Promise<void> {
  const absolute = nodePath.join(dir, relative);
  await mkdir(nodePath.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

const sourceFile = (relativePath: string): SourceFile => ({
  absolutePath: nodePath.join(dir, relativePath),
  relativePath,
  extension: nodePath.extname(relativePath),
  byteSize: 10,
  contentHash: "hash",
  readContent: () => Promise.resolve("content"),
});

const noConsoleLog: Check = async (file) =>
  file.content.includes("console.log")
    ? [{ message: "no console.log", path: file.path, severity: "error", source: "core" }]
    : [];

describe("compileRule (per-file rules)", () => {
  it("compiles select() rules to an extension with include/exclude globs", () => {
    const rule = select("src/**/*.ts")
      .exclude("**/*.test.ts")
      .label("No console log")
      .check(noConsoleLog);
    const ext = compileRule(rule, stubCtx());
    expect(ext.name).toBe("no-console-log");
    expect(ext.include).toEqual(["src/**/*.ts"]);
    expect(ext.exclude).toEqual(["**/*.test.ts"]);
    expect(typeof ext.fingerprint).toBe("string");
  });

  it("process runs checks and returns violation markers", async () => {
    const rule = select("src/**/*.ts")
      .label("X")
      .check(async (file) => [
        { message: "bad", path: file.path, line: 3, severity: "warn", source: "core" },
      ]);
    const ext = compileRule(rule, stubCtx());
    const markers = await ext.process!(sourceFile("src/a.ts"), "whatever", stubExtCtx());
    expect(markers).toHaveLength(1);
    expect(markers[0]!.type).toBe("violation");
    expect(markers[0]!.lines).toEqual([3]);
    const data = markers[0]!.data as { rule: string; description: string; severity: string };
    expect(data.rule).toBe("x");
    expect(data.description).toBe("X");
    expect(data.severity).toBe("warn");
  });

  it("absorbs check errors into an empty marker list", async () => {
    const rule = select("src/**/*.ts")
      .label("Boom")
      .check(async () => {
        throw new Error("check exploded");
      });
    const ext = compileRule(rule, stubCtx());
    const markers = await ext.process!(sourceFile("src/a.ts"), "x", stubExtCtx());
    expect(markers).toEqual([]);
  });

  it("applies predicates before running checks", async () => {
    let ran = 0;
    const rule = select("src/**/*.ts")
      .label("P")
      .filter((file) => file.stem !== "skip")
      .check(async (file) => {
        ran++;
        return [{ message: "m", path: file.path, severity: "info", source: "core" }];
      });
    const ext = compileRule(rule, stubCtx());
    expect(await ext.process!(sourceFile("src/skip.ts"), "x", stubExtCtx())).toEqual([]);
    expect(ran).toBe(0);
    expect(await ext.process!(sourceFile("src/keep.ts"), "x", stubExtCtx())).toHaveLength(1);
  });

  it("fingerprint changes with the check source and patterns", () => {
    const a = compileRule(select("src/**/*.ts").label("A").check(noConsoleLog), stubCtx());
    const b = compileRule(select("lib/**/*.ts").label("A").check(noConsoleLog), stubCtx());
    const c = compileRule(
      select("src/**/*.ts")
        .label("A")
        .check(async () => []),
      stubCtx(),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});

describe("compileRule (run-only rules)", () => {
  it("wraps a hand-built rule in a project extension that stores markers per path", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    await write("src/b.ts", "export const b = 2;\n");
    const rule: Rule = {
      id: "hand-built",
      description: "Hand built",
      run: Effect.succeed<Violation[]>([
        {
          rule: "hand-built",
          message: "issue in a",
          path: "src/a.ts",
          severity: "error",
          source: "custom",
        },
      ]),
    };

    const network = track(
      defineNetwork({ rootPath: dir, extensions: [compileRule(rule, stubCtx())] }),
    );
    await network.scan();

    const a = await network.file("src/a.ts");
    expect(a?.markers.filter(isViolationMarker)).toHaveLength(1);
    const b = await network.file("src/b.ts");
    expect(b?.markers.filter(isViolationMarker)).toHaveLength(0);
  });

  it("clears stale markers when the rule stops producing violations", async () => {
    await write("src/a.ts", "export const a = 1;\n");
    let violations: Violation[] = [
      { rule: "hand-built", message: "m", path: "src/a.ts", severity: "warn", source: "custom" },
    ];
    const rule: Rule = {
      id: "hand-built",
      description: "Hand built",
      run: Effect.suspend(() => Effect.succeed(violations)),
    };
    const network = track(
      defineNetwork({ rootPath: dir, extensions: [compileRule(rule, stubCtx())] }),
    );
    await network.scan();
    expect((await network.file("src/a.ts"))?.markers.filter(isViolationMarker)).toHaveLength(1);

    violations = [];
    // force re-run of the project rule: file content unchanged, but project
    // extensions re-evaluate on every scan (conservative, matches old behavior)
    await network.scan();
    expect((await network.file("src/a.ts"))?.markers.filter(isViolationMarker)).toHaveLength(0);
  });
});

describe("compileConfig", () => {
  it("puts the syntax extension first so its markers exist before rules run", () => {
    const config = defineConfig({
      projectRoot: dir,
      rules: [select("src/**/*.ts").label("R").check(noConsoleLog)],
    });
    const extensions = compileConfig(config, stubCtx());
    expect(extensions[0]!.name).toBe(SYNTAX_EXTENSION);
    expect(extensions[1]!.name).toBe("r");
  });

  it("end to end: scan, query violation markers, rebuild rule results", async () => {
    await write("src/dirty.ts", 'console.log("x");\n');
    await write("src/clean.ts", "export const x = 1;\n");
    const config = defineConfig({
      projectRoot: dir,
      rules: [
        select("src/**/*.ts").label("No console log").category("cleanup").check(noConsoleLog),
      ],
    });

    let services: Awaited<ReturnType<typeof createCheckServices>>;
    const network = track(
      defineNetwork({
        rootPath: dir,
        extensions: compileConfig(config, {
          rootDir: dir,
          getServices: () => services,
        }),
      }),
    );
    services = await createCheckServices(network, config.adapters, dir);
    await network.scan();

    const dirty = await network.file("src/dirty.ts");
    const violationMarkers = dirty!.markers.filter(isViolationMarker);
    expect(violationMarkers).toHaveLength(1);
    expect((violationMarkers[0]!.data as { category: string }).category).toBe("cleanup");

    const clean = await network.file("src/clean.ts");
    expect(clean!.markers.filter(isViolationMarker)).toHaveLength(0);

    // warm run: nothing reprocessed, violations served from cache
    const second = await network.scan();
    expect(second.reused).toBe(2);
    expect((await network.file("src/dirty.ts"))!.markers.filter(isViolationMarker)).toHaveLength(1);
  });
});

function stubCtx(): CompileContext {
  const services = {
    fs: {
      glob: async () => [],
      readFile: async () => "",
      exists: async () => false,
    },
    syntax: {
      canProcess: () => false,
      process: async () => ({ imports: [], calls: [], exports: [], structure: [] }),
    },
    imports: { resolve: () => null },
    projectRoot: dir,
  };
  return { rootDir: dir, getServices: () => services };
}

function stubExtCtx() {
  return { rootPath: dir, storage: {} } as never;
}
