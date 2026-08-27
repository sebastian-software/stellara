import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initializeResourceCutover,
  validateBoundTokenResource,
  validateResolvedClientResource,
} from "../../../src/oauth/resource.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";

const RESOURCE = "https://stellara.example.test/mcp";

describe("OAuth resource cutover", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("initializes the persistent cutover once without moving it on later boots", () => {
    expect(initializeResourceCutover(storage, 1000)).toBe(1000);
    expect(initializeResourceCutover(storage, 2000)).toBe(1000);
    expect(storage.getMeta("schema_version")).toBe("1");
  });

  it("allows missing resource only for DCR registrations before cutover", () => {
    expect(
      validateResolvedClientResource({
        client: {
          clientId: "legacy",
          redirectUris: ["https://client.example/callback"],
          registration: "dcr",
          createdAt: 999,
        },
        requestedResource: undefined,
        canonicalResource: RESOURCE,
        cutover: 1000,
      }),
    ).toMatchObject({ kind: "ok", usedLegacyDefault: true });
    expect(
      validateResolvedClientResource({
        client: { clientId: "new", redirectUris: [], registration: "dcr", createdAt: 1000 },
        requestedResource: undefined,
        canonicalResource: RESOURCE,
        cutover: 1000,
      }),
    ).toMatchObject({ kind: "invalid" });
    expect(
      validateResolvedClientResource({
        client: { clientId: "https://client.example/doc", redirectUris: [], registration: "cimd" },
        requestedResource: undefined,
        canonicalResource: RESOURCE,
        cutover: 1000,
      }),
    ).toMatchObject({ kind: "invalid" });
  });

  it("rejects every present non-exact resource without normalization", () => {
    const client = {
      clientId: "legacy",
      redirectUris: [],
      registration: "dcr" as const,
      createdAt: 1,
    };
    for (const value of [`${RESOURCE}/`, `${RESOURCE}?x=1`, "https://other.example/mcp"]) {
      expect(
        validateResolvedClientResource({
          client,
          requestedResource: value,
          canonicalResource: RESOURCE,
          cutover: 1000,
        }).kind,
      ).toBe("invalid");
    }
  });

  it("performs token resource checks locally without CIMD resolution", () => {
    storage.insertClient({
      client_id: "legacy",
      client_name: null,
      redirect_uris: "[]",
      created_at: 999,
      last_used_at: 999,
    });
    expect(
      validateBoundTokenResource({
        storage,
        clientId: "legacy",
        requestedResource: undefined,
        canonicalResource: RESOURCE,
        cutover: 1000,
      }),
    ).toMatchObject({ kind: "ok", usedLegacyDefault: true });
    expect(
      validateBoundTokenResource({
        storage,
        clientId: "https://client.example/document",
        requestedResource: undefined,
        canonicalResource: RESOURCE,
        cutover: 1000,
      }).kind,
    ).toBe("invalid");
  });
});
