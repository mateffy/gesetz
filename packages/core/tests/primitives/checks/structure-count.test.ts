import { describe, it, expect } from "vitest";
import { requireMinStructureCount } from "../../../src/primitives/checks/structure-count";
import { makeFile, makeCheckServices, runCheck } from "../../../src/test-helpers";
import type { StructureItem } from "../../../src/services/syntax-tree";

function svcs(structure: StructureItem[]) {
  return makeCheckServices({ syntax: { structure } });
}

describe("requireMinStructureCount", () => {
  it("passes when count of kind >= minCount", async () => {
    const v = await runCheck(
      requireMinStructureCount("function", 2),
      makeFile("src/foo.ts"),
      svcs([
        { kind: "function", name: "a", startLine: 1, endLine: 2, docstring: null, children: [] },
        { kind: "function", name: "b", startLine: 3, endLine: 4, docstring: null, children: [] },
      ]),
    );
    expect(v).toHaveLength(0);
  });

  it("fails when count of kind < minCount", async () => {
    const v = await runCheck(
      requireMinStructureCount("function", 2),
      makeFile("src/foo.ts"),
      svcs([
        { kind: "function", name: "a", startLine: 1, endLine: 2, docstring: null, children: [] },
      ]),
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("found 1");
  });

  it("counts nested children recursively", async () => {
    const v = await runCheck(
      requireMinStructureCount("method", 3),
      makeFile("src/foo.ts"),
      svcs([
        {
          kind: "class",
          name: "C",
          startLine: 1,
          endLine: 10,
          docstring: null,
          children: [
            { kind: "method", name: "m1", startLine: 2, endLine: 3, docstring: null, children: [] },
            {
              kind: "method",
              name: "m2",
              startLine: 4,
              endLine: 9,
              docstring: null,
              children: [
                {
                  kind: "method",
                  name: "nested",
                  startLine: 5,
                  endLine: 6,
                  docstring: null,
                  children: [],
                },
              ],
            },
          ],
        },
      ]),
    );
    expect(v).toHaveLength(0); // m1 + m2 + nested = 3
  });

  it("returns [] when canProcess is false", async () => {
    const services = makeCheckServices({ overrides: { syntax: { canProcess: () => false } } });
    const v = await runCheck(
      requireMinStructureCount("function", 1),
      makeFile("src/foo.ts"),
      services,
    );
    expect(v).toHaveLength(0);
  });
});
