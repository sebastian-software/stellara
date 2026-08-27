import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type ClientRegistrar, createClientRegistrar } from "../../../src/oauth/clients.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import { assertKind } from "./helpers.js";

const IP = "192.0.2.10";

function freshSetup(): {
  storage: OAuthStorage;
  registrar: ClientRegistrar;
  clock: () => number;
  advance: (ms: number) => void;
} {
  const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  let nowMs = 1_000_000;
  const registrar = createClientRegistrar({
    maxPerHour: 3,
    now: () => nowMs,
  });
  return {
    storage,
    registrar,
    clock(): number {
      return nowMs;
    },
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

describe("oauth/clients — DCR", () => {
  let setup: ReturnType<typeof freshSetup>;

  beforeEach(() => {
    setup = freshSetup();
  });

  afterEach(() => {
    setup.storage.close();
  });

  it("registers a client with HTTPS redirect URIs and returns the expected metadata", () => {
    const result = setup.registrar.registerClient(
      setup.storage,
      { client_name: "Test", redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    assertKind(result, "ok");
    expect(result.response.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.response).toMatchObject({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(setup.storage.getClient(result.response.client_id)).toBeDefined();
  });

  it("never backdates new registrations below the persistent resource cutover", () => {
    const registrar = createClientRegistrar({ now: () => 1000, resourceRequiredSince: 2000 });
    const result = registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    assertKind(result, "ok");
    expect(setup.storage.getClient(result.response.client_id)?.created_at).toBe(2000);
  });

  it("allows http://localhost and http://127.0.0.1 as native-client exceptions", () => {
    const result = setup.registrar.registerClient(
      setup.storage,
      {
        redirect_uris: ["http://localhost:6274/callback", "http://127.0.0.1:6274/callback"],
      },
      IP,
    );
    expect(result.kind).toBe("ok");
  });

  it("rejects HTTP redirect URIs outside the loopback allowlist", () => {
    const result = setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["http://example.test/cb"] },
      IP,
    );
    expect(result.kind).toBe("invalid_redirect_uri");
  });

  it("rejects unknown schemes like custom:// in v1", () => {
    const result = setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["custom://example.test/cb"] },
      IP,
    );
    expect(result.kind).toBe("invalid_redirect_uri");
  });

  it("rate-limits the same IP after three registrations within the hour", () => {
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    const blocked = setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    assertKind(blocked, "rate_limited");
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets the rate-limit bucket after the window elapses", () => {
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    setup.advance(3_600_001);
    const ok = setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb"] },
      IP,
    );
    expect(ok.kind).toBe("ok");
  });

  it("resolveClient returns parsed redirect URIs and touches last_used_at", () => {
    const registered = setup.registrar.registerClient(
      setup.storage,
      { redirect_uris: ["https://example.test/cb", "https://other.test/cb"] },
      IP,
    );
    assertKind(registered, "ok");
    const clientId = registered.response.client_id;
    const initialRow = setup.storage.getClient(clientId);
    expect(initialRow).toBeDefined();
    const initialTouch = initialRow!.last_used_at;

    setup.advance(60_000);
    const lookup = setup.registrar.resolveClient(setup.storage, clientId);
    expect(lookup).toMatchObject({
      kind: "ok",
      redirectUris: ["https://example.test/cb", "https://other.test/cb"],
    });
    const updatedRow = setup.storage.getClient(clientId);
    expect(updatedRow).toBeDefined();
    const updatedTouch = updatedRow!.last_used_at;
    expect(updatedTouch).toBeGreaterThan(initialTouch);
  });

  it("resolveClient returns 'unknown' for a never-registered id", () => {
    const lookup = setup.registrar.resolveClient(setup.storage, "no-such-client");
    expect(lookup.kind).toBe("unknown");
  });
});
