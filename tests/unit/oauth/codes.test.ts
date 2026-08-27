import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computePkceChallenge, exchangeAuthCode, issueAuthCode } from "../../../src/oauth/codes.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import { assertKind } from "./helpers.js";

const REDIRECT_URI = "https://example.test/cb";
const CLIENT_ID = "client-1";
const USER_ID = "user_a";

function setupCode(
  storage: OAuthStorage,
  options: { verifier: string; now: number; ttlSeconds?: number },
): string {
  const challenge = computePkceChallenge(options.verifier);
  return issueAuthCode(storage, {
    clientId: CLIENT_ID,
    userId: USER_ID,
    redirectUri: REDIRECT_URI,
    scope: "mcp",
    codeChallenge: challenge,
    now: options.now,
    ttlSeconds: options.ttlSeconds,
  });
}

describe("oauth/codes", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("issues a hex-encoded code and persists it with the supplied scope", () => {
    const code = setupCode(storage, {
      verifier: "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa",
      now: 1000,
    });
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const row = storage.getCode(code);
    expect(row?.scope).toBe("mcp");
    expect(row?.client_id).toBe(CLIENT_ID);
    expect(row?.user_id).toBe(USER_ID);
  });

  it("exchanges a valid code, deletes it, and issues a refresh token", () => {
    const verifier = "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa";
    const code = setupCode(storage, { verifier, now: 1000 });
    const result = exchangeAuthCode(storage, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      refreshTokenTtlSeconds: 86_400,
      now: 2000,
    });
    assertKind(result, "ok");
    expect(result.userId).toBe(USER_ID);
    expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    // Code is single-use: gone after exchange.
    expect(storage.getCode(code)).toBeUndefined();
    // Refresh token persisted.
    expect(storage.getRefreshToken(result.refreshToken)).toBeDefined();
  });

  it("rejects with pkce_mismatch when the verifier does not match the challenge", () => {
    const code = setupCode(storage, {
      verifier: "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa",
      now: 1000,
    });
    const result = exchangeAuthCode(storage, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier-43-chars-bbbbbbbbbbbbbbbbbbbbbbb",
      refreshTokenTtlSeconds: 86_400,
      now: 2000,
    });
    expect(result.kind).toBe("pkce_mismatch");
    // Code remains unconsumed on failure so legitimate retry stays possible.
    expect(storage.getCode(code)).toBeDefined();
  });

  it("rejects with redirect_mismatch when the redirect_uri differs from issuance", () => {
    const verifier = "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa";
    const code = setupCode(storage, { verifier, now: 1000 });
    const result = exchangeAuthCode(storage, {
      code,
      clientId: CLIENT_ID,
      redirectUri: "https://other.example.test/cb",
      codeVerifier: verifier,
      refreshTokenTtlSeconds: 86_400,
      now: 2000,
    });
    expect(result.kind).toBe("redirect_mismatch");
  });

  it("rejects with client_mismatch when the presenting client differs", () => {
    const verifier = "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa";
    const code = setupCode(storage, { verifier, now: 1000 });
    const result = exchangeAuthCode(storage, {
      code,
      clientId: "other-client",
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      refreshTokenTtlSeconds: 86_400,
      now: 2000,
    });
    expect(result.kind).toBe("client_mismatch");
  });

  it("rejects an expired code and removes it from storage", () => {
    const verifier = "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa";
    const code = setupCode(storage, { verifier, now: 1000, ttlSeconds: 1 });
    const result = exchangeAuthCode(storage, {
      code,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: verifier,
      refreshTokenTtlSeconds: 86_400,
      now: 1_000_000,
    });
    expect(result.kind).toBe("expired");
    expect(storage.getCode(code)).toBeUndefined();
  });

  it("returns 'unknown' for a code that was never issued", () => {
    const result = exchangeAuthCode(storage, {
      code: "no-such-code",
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeVerifier: "verifier-43-chars-aaaaaaaaaaaaaaaaaaaaaaa",
      refreshTokenTtlSeconds: 86_400,
      now: 2000,
    });
    expect(result.kind).toBe("unknown");
  });

  it("computePkceChallenge produces a base64url-encoded SHA-256 digest", () => {
    // From RFC 7636 §A.4: verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`
    // → challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`
    const challenge = computePkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
