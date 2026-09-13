import { describe, it, expect } from "vitest";
import * as nodePath from "node:path";
import { requireSibling, forbidFile } from "../../../src/primitives/checks/fs";
import { makeFile, makeCheckServices, runCheck } from "../../../src/test-helpers";

const CWD = process.cwd();

describe("requireSibling", () => {
  it("passes when sibling exists", async () => {
    const file = makeFile("src/Button.tsx");
    const services = makeCheckServices({
      projectRoot: CWD,
      files: { [nodePath.resolve(CWD, "src/Button.stories.tsx")]: "" },
    });
    const v = await runCheck(requireSibling(".stories.tsx"), file, services);
    expect(v).toHaveLength(0);
  });

  it("fails when sibling is missing", async () => {
    const file = makeFile("src/Button.tsx");
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(requireSibling(".stories.tsx"), file, services);
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain("Button.stories.tsx");
  });

  it("uses custom message when provided", async () => {
    const file = makeFile("src/Button.tsx");
    const services = makeCheckServices({ projectRoot: CWD });
    const v = await runCheck(
      requireSibling(".test.tsx", { message: "Custom error message" }),
      file,
      services,
    );
    expect(v[0]?.message).toBe("Custom error message");
  });
});

describe("forbidFile", () => {
  it("always returns a violation for the matched file", async () => {
    const v = await runCheck(forbidFile(), makeFile("src/legacy/old.ts"), makeCheckServices());
    expect(v).toHaveLength(1);
    expect(v[0]?.path).toBe("src/legacy/old.ts");
  });

  it("uses custom message", async () => {
    const v = await runCheck(
      forbidFile({ message: "Do not use this file" }),
      makeFile("src/foo.ts"),
      makeCheckServices(),
    );
    expect(v[0]?.message).toBe("Do not use this file");
  });
});
