import { describe, expect, it } from "vitest";
import { defineConfig } from "../../src/engine/config";

describe("defineConfig storage", () => {
  it("defaults to memory storage", () => {
    const config = defineConfig({ rules: [] });
    expect(config.storage).toEqual({ kind: "memory" });
  });

  it("passes sqlite storage through", () => {
    const config = defineConfig({ rules: [], storage: { kind: "sqlite", path: "/tmp/x.db" } });
    expect(config.storage).toEqual({ kind: "sqlite", path: "/tmp/x.db" });
  });
});
