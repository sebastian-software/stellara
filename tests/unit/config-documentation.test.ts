import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BUILD_OWNED_ENV_KEYS, RUNTIME_ENV_KEYS } from "../../src/config-keys.js";

const reference = readFileSync(
  new URL("../../docs/operations/configuration.md", import.meta.url),
  "utf8",
);
const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

function keysFromReference(): string[] {
  const startMarker = "<!-- runtime-config-keys:start -->";
  const endMarker = "<!-- runtime-config-keys:end -->";
  expect(reference.split(startMarker)).toHaveLength(2);
  expect(reference.split(endMarker)).toHaveLength(2);
  const rows = reference.split(startMarker)[1]?.split(endMarker)[0] ?? "";
  return [...rows.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gmu)].map((match) => match[1]!);
}

function keysFromExample(): string[] {
  return [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]!);
}

describe("operator configuration inventory", () => {
  it("keeps the canonical fixed-key rows exactly aligned with the schema", () => {
    const keys = keysFromReference();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.toSorted()).toStrictEqual([...RUNTIME_ENV_KEYS]);
    expect(BUILD_OWNED_ENV_KEYS).toStrictEqual(["APP_VERSION"]);
    expect(reference).toContain("## Build metadata");
  });

  it("allows only runtime keys, token examples, and Compose-only settings in .env.example", () => {
    const keys = keysFromExample();
    expect(new Set(keys).size).toBe(keys.length);
    const runtime = keys.filter((key) => RUNTIME_ENV_KEYS.includes(key));
    const extras = keys.filter((key) => !RUNTIME_ENV_KEYS.includes(key));
    expect(runtime.toSorted()).toStrictEqual([...RUNTIME_ENV_KEYS]);
    expect(extras.toSorted()).toStrictEqual([
      "STELLARA_IMAGE",
      "STELLARA_PROXY_NETWORK",
      "STELLARA_TOKEN_USER_A",
      "STELLARA_TOKEN_USER_B",
    ]);
    expect(example).not.toMatch(/^APP_VERSION=/mu);
  });
});
