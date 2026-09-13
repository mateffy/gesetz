import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNetwork, defineNetwork } from "netzwerk";
import type { Network } from "netzwerk";
import { defineConfig, select, noGodFile, requireSibling } from "../../src/index.js";
import { noImportFrom } from "../../src/primitives/checks/imports.js";
import { compileConfig, type CompileContext } from "../../src/backend/compile.js";
import { createCheckServices } from "../../src/backend/check-services.js";
import { isViolationMarker, markerToViolation } from "../../src/backend/violation-markers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(nodePath.join(tmpdir(), "gesetz-netzwerk-smoke-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function aNetwork(options?: { storage?: "memory" | "sqlite" }): Network {
  return createNetwork({
    rootPath: dir,
    extensions: [],
    storage:
      options?.storage === "sqlite"
        ? { kind: "sqlite", path: nodePath.join(dir, "cache.db") }
        : { kind: "memory" },
  });
}

describe("netzwerk runtime API", () => {
  it("createNetwork returns a Network with scan, query, glob, and close", () => {
    const net = createNetwork({ rootPath: "/tmp", extensions: [], storage: { kind: "memory" } });
    expect(typeof net.scan).toBe("function");
    expect(typeof net.query).toBe("function");
    expect(typeof net.glob).toBe("function");
    expect(typeof net.close).toBe("function");
    expect(typeof net.file).toBe("function");
    expect(typeof net.createMarker).toBe("function");
  });

  it("defineNetwork is the config helper (not the runtime factory)", () => {
    const cfg = defineNetwork({ rootPath: "/tmp", extensions: [], storage: { kind: "memory" } });
    expect(cfg.rootPath).toBe("/tmp");
    expect(typeof (cfg as Record<string, unknown>).scan).toBe("undefined");
    expect(typeof (cfg as Record<string, unknown>).close).toBe("undefined");
  });

  it("scans a single file and reports it via scan()", async () => {
    await writeFile(nodePath.join(dir, "a.ts"), "export const a = 1;\n");
    const net = aNetwork();
    const result = await net.scan();
    expect(result.filesSeen).toBeGreaterThanOrEqual(1);
    expect(typeof result.durationMs).toBe("number");
    await net.close();
  });

  it("glob returns matching files after a scan", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    await writeFile(nodePath.join(dir, "src/a.ts"), "");
    await writeFile(nodePath.join(dir, "src/b.ts"), "");
    const net = aNetwork();
    await net.scan();
    const files = await net.glob("src/*.ts");
    expect(files.length).toBe(2);
    await net.close();
  });

  it("query returns files with stored markers after createMarker", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    await writeFile(nodePath.join(dir, "src/a.ts"), "");
    const net = aNetwork();
    await net.scan();
    await net.createMarker("src/a.ts", {
      type: "smoke.test",
      data: { rule: "r1", message: "hello", severity: "error", source: "core" },
    });
    const results = await net.query({ limit: 100 });
    expect(results.length).toBe(1);
    const file = results[0]!;
    expect(file.path).toBe("src/a.ts");
    expect(file.hasMarker("smoke.test")).toBe(true);
    await net.close();
  });

  it.skip("scans with sqlite storage and markers survive a close/reopen", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    await writeFile(nodePath.join(dir, "src/a.ts"), "export const a = 1;\n");
    const dbPath = nodePath.join(dir, "cache.db");
    const net = createNetwork({
      rootPath: dir,
      extensions: [],
      storage: { kind: "sqlite", path: dbPath },
    });
    await net.scan();
    await net.createMarker("src/a.ts", {
      type: "smoke",
      data: { key: "value" },
    });
    await net.close();

    const reopened = createNetwork({
      rootPath: dir,
      extensions: [],
      storage: { kind: "sqlite", path: dbPath },
    });
    const file = await reopened.file("src/a.ts");
    expect(file?.hasMarker("smoke")).toBe(true);
    await reopened.close();
  });
});

describe("compile pipeline (integration)", () => {
  it("compiles a select() rule, scans, and collects violations", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    // One file over the line limit, one under
    await writeFile(nodePath.join(dir, "src/small.ts"), "x\n".repeat(10));
    await writeFile(nodePath.join(dir, "src/large.ts"), "x\n".repeat(30));

    const rule = select("src/**/*.ts")
      .label("Files must stay under 25 lines")
      .category("structure")
      .check(noGodFile({ maxLines: 25 }));

    const config = defineConfig({ projectRoot: dir, rules: [rule] });
    const pendingViolations: unknown[] = [];
    const sharedPaths = new Set<string>();
    let services: Awaited<ReturnType<typeof createCheckServices>>;
    const compileCtx: CompileContext = {
      rootDir: dir,
      getServices: () => services as ReturnType<typeof createCheckServices>,
      pendingViolations: pendingViolations as never,
      sharedPaths,
    };
    const network = createNetwork({
      rootPath: dir,
      extensions: compileConfig(config, compileCtx),
      storage: { kind: "memory" },
    });

    services = await createCheckServices(network, config.adapters, dir, sharedPaths);
    await network.scan();

    // Query all violation markers that the per-file extension stored
    const entries = await network.query({ limit: Number.MAX_SAFE_INTEGER });
    expect(entries.length).toBe(2);

    const violations = [];
    for (const entry of entries) {
      for (const marker of entry.markers) {
        if (isViolationMarker(marker)) {
          violations.push(markerToViolation(entry.path, marker));
        }
      }
    }
    expect(violations.length).toBe(1);
    expect(violations[0]!.path).toBe("src/large.ts");
    expect(violations[0]!.severity).toBe("warn");
    expect(violations[0]!.message).toContain("31 lines");
    await network.close();
  });

  it("compiles a file-system select() rule with requireSibling", async () => {
    await mkdir(nodePath.join(dir, "components"), { recursive: true });
    // Button.tsx exists but Button.stories.tsx does not
    await writeFile(
      nodePath.join(dir, "components/Button.tsx"),
      "export const Button = () => null;\n",
    );
    await writeFile(nodePath.join(dir, "components/Card.tsx"), "export const Card = () => null;\n");
    await writeFile(nodePath.join(dir, "components/Card.stories.tsx"), "export default {};\n");

    const rule = select("components/**/*.tsx")
      .exclude("**/*.stories.tsx", "**/*.test.tsx")
      .label("Components need stories")
      .category("organization")
      .check(requireSibling(".stories.tsx"));

    const config = defineConfig({ projectRoot: dir, rules: [rule] });
    const pendingViolations: unknown[] = [];
    const sharedPaths = new Set<string>();
    let services: Awaited<ReturnType<typeof createCheckServices>>;
    const compileCtx: CompileContext = {
      rootDir: dir,
      getServices: () => services as ReturnType<typeof createCheckServices>,
      pendingViolations: pendingViolations as never,
      sharedPaths,
    };
    const network = createNetwork({
      rootPath: dir,
      extensions: compileConfig(config, compileCtx),
      storage: { kind: "memory" },
    });

    services = await createCheckServices(network, config.adapters, dir, sharedPaths);
    await network.scan();

    const entries = await network.query({ limit: 100 });
    const violations = [];
    for (const entry of entries) {
      for (const marker of entry.markers) {
        if (isViolationMarker(marker)) {
          violations.push(markerToViolation(entry.path, marker));
        }
      }
    }

    // Button.tsx → missing sibling, Card.tsx → has sibling
    expect(violations.length).toBe(1);
    expect(violations[0]!.path).toBe("components/Button.tsx");
    expect(violations[0]!.severity).toBe("error");
    await network.close();
  });

  it("compiles an import-boundary rule", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    await writeFile(nodePath.join(dir, "src/a.ts"), "import { x } from '@/db';\n");
    await writeFile(nodePath.join(dir, "src/b.ts"), "import { y } from '@/services';\n");

    const rule = select("src/**/*.ts")
      .label("No direct DB imports")
      .category("architecture")
      .check(noImportFrom("@/db"));

    const config = defineConfig({ projectRoot: dir, rules: [rule] });
    const pendingViolations: unknown[] = [];
    const sharedPaths = new Set<string>();
    let services: Awaited<ReturnType<typeof createCheckServices>>;
    const compileCtx: CompileContext = {
      rootDir: dir,
      getServices: () => services as ReturnType<typeof createCheckServices>,
      pendingViolations: pendingViolations as never,
      sharedPaths,
    };
    const network = createNetwork({
      rootPath: dir,
      extensions: compileConfig(config, compileCtx),
      storage: { kind: "memory" },
    });

    services = await createCheckServices(network, config.adapters, dir, sharedPaths);
    await network.scan();

    const entries = await network.query({ limit: 100 });
    const violations = [];
    for (const entry of entries) {
      for (const marker of entry.markers) {
        if (isViolationMarker(marker)) {
          violations.push(markerToViolation(entry.path, marker));
        }
      }
    }
    expect(violations.length).toBe(1);
    expect(violations[0]!.path).toBe("src/a.ts");
    expect(violations[0]!.message).toContain("@/db");
    await network.close();
  });

  it("can scan twice and only reprocess changed files", async () => {
    await mkdir(nodePath.join(dir, "src"), { recursive: true });
    await writeFile(nodePath.join(dir, "src/a.ts"), "x\n".repeat(10));
    await writeFile(nodePath.join(dir, "src/b.ts"), "x\n".repeat(10));

    const rule = select("src/**/*.ts")
      .label("Files must stay under 25 lines")
      .check(noGodFile({ maxLines: 25 }));

    const config = defineConfig({ projectRoot: dir, rules: [rule] });
    const pendingViolations: unknown[] = [];
    const sharedPaths = new Set<string>();
    let services: Awaited<ReturnType<typeof createCheckServices>>;
    const compileCtx: CompileContext = {
      rootDir: dir,
      getServices: () => services as ReturnType<typeof createCheckServices>,
      pendingViolations: pendingViolations as never,
      sharedPaths,
    };
    const network = createNetwork({
      rootPath: dir,
      extensions: compileConfig(config, compileCtx),
      storage: { kind: "memory" },
    });

    services = await createCheckServices(network, config.adapters, dir, sharedPaths);
    // First scan: both files are new
    let result = await network.scan();
    expect(result.filesSeen).toBe(2);
    expect(result.added).toBe(2);
    expect(result.reused).toBe(0);

    // Second scan: nothing changed
    result = await network.scan();
    expect(result.filesSeen).toBe(2);
    expect(result.changed).toBe(0);
    expect(result.reused).toBe(2);

    // Modify one file
    await writeFile(nodePath.join(dir, "src/b.ts"), "x\n".repeat(30));
    result = await network.scan();
    expect(result.changed).toBe(1);
    expect(result.reused).toBe(1);

    // Gather violations from the changed file
    const entries = await network.query({ limit: 100 });
    const violations = [];
    for (const entry of entries) {
      for (const marker of entry.markers) {
        if (isViolationMarker(marker)) {
          violations.push(markerToViolation(entry.path, marker));
        }
      }
    }
    expect(violations.length).toBe(1);
    expect(violations[0]!.path).toBe("src/b.ts");

    await network.close();
  });
});
