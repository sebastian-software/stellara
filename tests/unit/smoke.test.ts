import { describe, expect, it } from "vitest";

describe("toolchain smoke", () => {
  it("evaluates basic arithmetic", () => {
    expect(1 + 1).toBe(2);
  });

  it("runs on Node.js >= 24", () => {
    const [majorStr = "0"] = process.versions.node.split(".");
    expect(Number(majorStr)).toBeGreaterThanOrEqual(24);
  });
});
