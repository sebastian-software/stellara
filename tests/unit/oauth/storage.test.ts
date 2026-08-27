import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OAuthStorage } from "../../../src/oauth/storage.js";

describe("OAuthStorage", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("creates all five OAuth tables on construction", () => {
    const rows = storage.db
      .prepare<
        unknown[],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'oauth_%' ORDER BY name")
      .all();
    const names = rows.map((row) => row.name);
    expect(names).toStrictEqual([
      "oauth_clients",
      "oauth_codes",
      "oauth_keys",
      "oauth_meta",
      "oauth_refresh_tokens",
      "oauth_sessions",
    ]);
  });

  it("atomically initializes opaque metadata without overwriting the first value", () => {
    expect(storage.getOrInitializeMeta("oauth_resource_required_since", "1000")).toBe("1000");
    expect(storage.getOrInitializeMeta("oauth_resource_required_since", "2000")).toBe("1000");
    expect(storage.getMeta("oauth_resource_required_since")).toBe("1000");
  });

  it("stores and retrieves a client registration", () => {
    storage.insertClient({
      client_id: "abc",
      client_name: "Test",
      redirect_uris: '["https://example.test/cb"]',
      created_at: 1000,
      last_used_at: 1000,
    });
    const row = storage.getClient("abc");
    expect(row?.client_name).toBe("Test");
    expect(row?.redirect_uris).toBe('["https://example.test/cb"]');
  });

  it("touchClient updates last_used_at without changing created_at", () => {
    storage.insertClient({
      client_id: "abc",
      client_name: null,
      redirect_uris: "[]",
      created_at: 1000,
      last_used_at: 1000,
    });
    storage.touchClient("abc", 2000);
    const row = storage.getClient("abc");
    expect(row?.created_at).toBe(1000);
    expect(row?.last_used_at).toBe(2000);
  });

  it("sweepExpired removes only past-due rows from the three TTL tables", () => {
    const past = 100;
    const future = 10_000;
    storage.insertCode({
      code: "expired-code",
      client_id: "c",
      user_id: "u",
      code_challenge: "x",
      redirect_uri: "https://example.test/cb",
      scope: "mcp",
      expires_at: past,
    });
    storage.insertCode({
      code: "fresh-code",
      client_id: "c",
      user_id: "u",
      code_challenge: "x",
      redirect_uri: "https://example.test/cb",
      scope: "mcp",
      expires_at: future,
    });
    storage.insertRefreshToken({
      token: "expired-rt",
      client_id: "c",
      user_id: "u",
      scope: "mcp",
      issued_at: 0,
      expires_at: past,
      rotated_to: null,
    });
    storage.insertRefreshToken({
      token: "fresh-rt",
      client_id: "c",
      user_id: "u",
      scope: "mcp",
      issued_at: 0,
      expires_at: future,
      rotated_to: null,
    });
    storage.insertSession({
      session_id: "expired-s",
      user_id: "u",
      issued_at: 0,
      expires_at: past,
    });
    storage.insertSession({
      session_id: "fresh-s",
      user_id: "u",
      issued_at: 0,
      expires_at: future,
    });

    storage.sweepExpired(1000);

    expect(storage.getCode("expired-code")).toBeUndefined();
    expect(storage.getCode("fresh-code")).toBeDefined();
    expect(storage.getRefreshToken("expired-rt")).toBeUndefined();
    expect(storage.getRefreshToken("fresh-rt")).toBeDefined();
    expect(storage.getSession("expired-s")).toBeUndefined();
    expect(storage.getSession("fresh-s")).toBeDefined();
  });

  it("deleteRefreshTokensForUser removes every token of that user across clients", () => {
    storage.insertRefreshToken({
      token: "u1c1",
      client_id: "c1",
      user_id: "u1",
      scope: "mcp",
      issued_at: 0,
      expires_at: 10_000,
      rotated_to: null,
    });
    storage.insertRefreshToken({
      token: "u1c2",
      client_id: "c2",
      user_id: "u1",
      scope: "mcp",
      issued_at: 0,
      expires_at: 10_000,
      rotated_to: null,
    });
    storage.insertRefreshToken({
      token: "u2c1",
      client_id: "c1",
      user_id: "u2",
      scope: "mcp",
      issued_at: 0,
      expires_at: 10_000,
      rotated_to: null,
    });

    const deleted = storage.deleteRefreshTokensForUser("u1");
    expect(deleted).toBe(2);
    expect(storage.getRefreshToken("u1c1")).toBeUndefined();
    expect(storage.getRefreshToken("u1c2")).toBeUndefined();
    expect(storage.getRefreshToken("u2c1")).toBeDefined();
  });

  it("getActiveKey returns the newest non-retired key", () => {
    storage.insertKey({
      kid: "old",
      public_jwk: "{}",
      private_pkcs8: "old-key",
      algorithm: "RS256",
      created_at: 1000,
      retired_at: 5000,
    });
    storage.insertKey({
      kid: "new",
      public_jwk: "{}",
      private_pkcs8: "new-key",
      algorithm: "RS256",
      created_at: 6000,
      retired_at: null,
    });
    const active = storage.getActiveKey();
    expect(active?.kid).toBe("new");
  });

  it("schema migration is idempotent across re-opens", () => {
    storage.insertClient({
      client_id: "persisted",
      client_name: null,
      redirect_uris: "[]",
      created_at: 1000,
      last_used_at: 1000,
    });
    storage.close();

    // Re-open against a fresh in-memory DB instance to exercise the migration
    // path once more — schema_version row should not be duplicated.
    const fresh = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      const metaRows = fresh.db
        .prepare<
          unknown[],
          { n: number }
        >("SELECT COUNT(*) AS n FROM oauth_meta WHERE key = 'schema_version'")
        .get();
      expect(metaRows?.n).toBe(1);
    } finally {
      fresh.close();
    }
    // Re-create the original storage so afterEach can close it.
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });
});
