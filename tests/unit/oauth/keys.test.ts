import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapNewKey,
  loadOrBootstrapSigningKey,
  SIGNING_ALGORITHM,
} from "../../../src/oauth/keys.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";

describe("oauth/keys", () => {
  let storage: OAuthStorage;

  beforeEach(() => {
    storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  });

  afterEach(() => {
    storage.close();
  });

  it("bootstraps a new RSA-2048 keypair on first call", () => {
    const key = loadOrBootstrapSigningKey(storage, 1000);
    expect(key.algorithm).toBe(SIGNING_ALGORITHM);
    expect(key.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(key.privatePkcs8).toContain("BEGIN PRIVATE KEY");
    expect(key.publicJwk.kty).toBe("RSA");
    expect(key.publicJwk.kid).toBe(key.kid);
    expect(key.publicJwk.alg).toBe(SIGNING_ALGORITHM);
    expect(key.publicJwk.use).toBe("sig");
  });

  it("returns the same key on subsequent calls (persistence)", () => {
    const first = loadOrBootstrapSigningKey(storage, 1000);
    const second = loadOrBootstrapSigningKey(storage, 2000);
    expect(second.kid).toBe(first.kid);
    expect(second.privatePkcs8).toBe(first.privatePkcs8);
  });

  it("derives kid deterministically from the canonical JWK", () => {
    const key = bootstrapNewKey(storage, 1000);
    const row = storage.getActiveKey();
    expect(row).toBeDefined();
    expect(row?.kid).toBe(key.kid);
    expect(row?.kid.length).toBe(16);
  });

  it("includes the JWK n, e and kty fields in the persisted public_jwk", () => {
    const key = bootstrapNewKey(storage, 1000);
    expect(key.publicJwk.n).toBeDefined();
    expect(key.publicJwk.e).toBeDefined();
    expect(key.publicJwk.kty).toBe("RSA");
    // Private fields must not leak into the public JWK.
    expect(key.publicJwk.d).toBeUndefined();
    expect(key.publicJwk.p).toBeUndefined();
    expect(key.publicJwk.q).toBeUndefined();
  });
});
