import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };

const developerGuide = readFileSync("docs/developer-guide/entwicklung.md", "utf8");

const scriptRows = developerGuide.split("\n").filter((line) => line.startsWith("| `pnpm "));
const documentedScripts = scriptRows.map((row) => (row.split("`")[1] ?? "").replace("pnpm ", ""));

function scriptRow(name: string): string | undefined {
  return scriptRows.find((row) => row.startsWith(`| \`pnpm ${name}\``));
}

describe("documentation drift", () => {
  it("lists every package script", () => {
    expect(documentedScripts.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      Object.keys(packageJson.scripts).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("matches build and typecheck commands", () => {
    expect(scriptRow("build")).toContain(`\`${packageJson.scripts.build}\``);
    expect(scriptRow("typecheck")).toContain(`\`${packageJson.scripts.typecheck}\``);
    expect(developerGuide).not.toContain("tsconfig.build.json");
  });
});
