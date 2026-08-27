import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOrBootstrapSigningKey } from "../../../src/oauth/keys.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import {
  issueRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../../../src/oauth/tokens.js";
import { assertKind } from "./helpers.js";

const ISSUER = "https://stellara.example.test";
const AUDIENCE = "https://stellara.example.test/mcp";

describe("oauth/tokens — JWT access tokens", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("signs an access token with required claims and verifies it", async () => {
    const key = loadOrBootstrapSigningKey(storage);
    const jwt = await signAccessToken(key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      userId: "user_a",
      clientId: "client-1",
      scope: "mcp",
      ttlSeconds: 3600,
      now: 1_700_000_000_000,
    });
    const verified = await verifyAccessToken({
      jwt,
      issuer: ISSUER,
      audience: AUDIENCE,
      key,
      now: 1_700_000_000_000 + 60_000,
    });
    expect(verified).toMatchObject({
      userId: "user_a",
      clientId: "client-1",
      scope: "mcp",
      expiresAt: 1_700_000_000 + 3600,
    });
    expect(verified.jti).toMatch(/^[0-9a-f]+$/);
  });

  it("rejects an access token with the wrong audience", async () => {
    const key = loadOrBootstrapSigningKey(storage);
    const jwt = await signAccessToken(key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      userId: "user_a",
      clientId: "client-1",
      scope: "mcp",
      ttlSeconds: 3600,
    });
    await expect(
      verifyAccessToken({
        jwt,
        issuer: ISSUER,
        audience: "https://other.example.test/mcp",
        key,
      }),
    ).rejects.toThrow(/aud/i);
  });

  it("rejects an access token whose signature was made with a different key", async () => {
    const key = loadOrBootstrapSigningKey(storage);
    const jwt = await signAccessToken(key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      userId: "user_a",
      clientId: "client-1",
      scope: "mcp",
      ttlSeconds: 3600,
    });

    const otherStorage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    const otherKey = loadOrBootstrapSigningKey(otherStorage);
    try {
      await expect(
        verifyAccessToken({ jwt, issuer: ISSUER, audience: AUDIENCE, key: otherKey }),
      ).rejects.toThrow(/signature/i);
    } finally {
      otherStorage.close();
    }
  });
});

describe("oauth/tokens — refresh-token rotation", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("rotates a refresh token and invalidates the old value", () => {
    const original = issueRefreshToken(storage, {
      clientId: "client-1",
      userId: "user_a",
      scope: "mcp",
      ttlSeconds: 86_400,
      now: 1000,
    });
    const result = rotateRefreshToken(storage, {
      presentedToken: original,
      expectedClientId: "client-1",
      ttlSeconds: 86_400,
      now: 2000,
    });
    assertKind(result, "ok");
    expect(result.newToken).not.toBe(original);
    const oldRow = storage.getRefreshToken(original);
    expect(oldRow?.rotated_to).toBe(result.newToken);
    const newRow = storage.getRefreshToken(result.newToken);
    expect(newRow?.user_id).toBe("user_a");
    expect(newRow?.rotated_to).toBeNull();
  });

  it("detects replay of an already-rotated refresh token and invalidates the chain", () => {
    const original = issueRefreshToken(storage, {
      clientId: "client-1",
      userId: "user_a",
      scope: "mcp",
      ttlSeconds: 86_400,
      now: 1000,
    });
    const firstRotation = rotateRefreshToken(storage, {
      presentedToken: original,
      expectedClientId: "client-1",
      ttlSeconds: 86_400,
      now: 2000,
    });
    assertKind(firstRotation, "ok");

    // Replay attempt: present the original token again after rotation.
    const replay = rotateRefreshToken(storage, {
      presentedToken: original,
      expectedClientId: "client-1",
      ttlSeconds: 86_400,
      now: 3000,
    });
    assertKind(replay, "replay");
    // The entire chain (original + rotated successor) should be deleted.
    expect(replay.chainDeleted).toBe(2);
    expect(storage.getRefreshToken(original)).toBeUndefined();
    expect(storage.getRefreshToken(firstRotation.newToken)).toBeUndefined();
  });

  it("rejects an expired refresh token", () => {
    const token = issueRefreshToken(storage, {
      clientId: "client-1",
      userId: "user_a",
      scope: "mcp",
      ttlSeconds: 1,
      now: 1000,
    });
    const result = rotateRefreshToken(storage, {
      presentedToken: token,
      expectedClientId: "client-1",
      ttlSeconds: 86_400,
      now: 1_000_000,
    });
    expect(result.kind).toBe("expired");
  });

  it("rejects a refresh token presented with a mismatched client_id", () => {
    const token = issueRefreshToken(storage, {
      clientId: "client-1",
      userId: "user_a",
      scope: "mcp",
      ttlSeconds: 86_400,
      now: 1000,
    });
    const result = rotateRefreshToken(storage, {
      presentedToken: token,
      expectedClientId: "client-other",
      ttlSeconds: 86_400,
      now: 2000,
    });
    expect(result.kind).toBe("unknown_client");
  });

  it("returns 'unknown' for a token that does not exist", () => {
    const result = rotateRefreshToken(storage, {
      presentedToken: "not-a-real-token",
      expectedClientId: "client-1",
      ttlSeconds: 86_400,
      now: 1000,
    });
    expect(result.kind).toBe("unknown");
  });
});
