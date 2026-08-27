/**
 * Signing-key management for Stellara's OAuth subsystem (plan 0004 §
 * Keypair-Verwaltung).
 *
 * Owns the RSA-2048 keypair used to sign JWT access tokens. On first boot,
 * generates a fresh keypair and persists it to the `oauth_keys` table; on
 * subsequent boots, loads the existing key from storage. The public half is
 * additionally exposed as a JWK for the `/oauth/jwks` discovery endpoint.
 *
 * v1 maintains exactly one active key per running instance. Future work can
 * add rotation by introducing additional rows and a `retired_at` filter; the
 * `oauth_keys` schema is already set up for it.
 */
import type { JWK } from "jose";

import { exportJWK, importPKCS8 } from "jose";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";

import type { OAuthKeyRow, OAuthStorage } from "./storage.js";

/** JWT signing algorithm exposed in JWKS and used by `SignJWT`. */
export const SIGNING_ALGORITHM = "RS256";

/** Bit length of the RSA modulus. 2048 is the OAuth-2.1-recommended floor. */
const RSA_MODULUS_LENGTH = 2048;

/** Number of hex characters retained from the SHA-256 of the public JWK to form the `kid`. */
const KID_HEX_LENGTH = 16;

/**
 * Active OAuth signing key. The private key is materialized as a
 * `CryptoKey`-like opaque handle (in jose terms: `KeyLike`) ready for
 * `SignJWT.sign(...)`; the public JWK is exposed via the JWKS endpoint.
 */
export type ActiveSigningKey = {
  /** Stable identifier (kid) carried in the JWT header. */
  kid: string;
  /** Signing algorithm (`alg` claim and JWKS field). */
  algorithm: typeof SIGNING_ALGORITHM;
  /**
   * PKCS#8-encoded PEM string. `signAccessToken` re-imports it on every call
   * because jose expects a `KeyLike`; keeping the PEM string is cheap and
   * avoids holding a CryptoKey across timer boundaries.
   */
  privatePkcs8: string;
  /** Public JWK exposed via JWKS — includes `kid` and `alg` already merged in. */
  publicJwk: JWK;
};

/**
 * Loads the active signing key from storage. If none exists (first boot),
 * generates a new RSA-2048 keypair, persists it, and returns the resulting
 * key. Idempotent across restarts as long as the SQLite volume survives.
 */
export function loadOrBootstrapSigningKey(
  storage: OAuthStorage,
  now: number = Date.now(),
): ActiveSigningKey {
  const existing = storage.getActiveKey();
  if (existing !== undefined) {
    return toActiveSigningKey(existing);
  }
  return bootstrapNewKey(storage, now);
}

/**
 * Forces generation of a fresh keypair, even when one already exists. Useful
 * for tests; production code should call {@link loadOrBootstrapSigningKey}.
 */
export function bootstrapNewKey(storage: OAuthStorage, now: number = Date.now()): ActiveSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: RSA_MODULUS_LENGTH,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicJwkRaw = publicKeyToJwk(publicKey);
  const kid = computeKid(publicJwkRaw);
  const publicJwk: JWK = { ...publicJwkRaw, kid, alg: SIGNING_ALGORITHM, use: "sig" };
  const row: OAuthKeyRow = {
    kid,
    public_jwk: JSON.stringify(publicJwk),
    private_pkcs8: privateKey,
    algorithm: SIGNING_ALGORITHM,
    created_at: now,
    retired_at: null,
  };
  storage.insertKey(row);
  return { kid, algorithm: SIGNING_ALGORITHM, privatePkcs8: privateKey, publicJwk };
}

/**
 * Re-imports the PKCS#8 PEM into a jose-usable signing key. Done lazily per
 * sign call so the stored representation remains a plain string.
 */
export async function importPrivateKey(key: ActiveSigningKey): Promise<CryptoKey> {
  return importPKCS8(key.privatePkcs8, key.algorithm);
}

/**
 * Computes the `kid` from a public JWK by SHA-256-hashing its canonical JSON
 * form and taking the first {@link KID_HEX_LENGTH} hex characters. Stable
 * across processes and short enough to fit comfortably in a JWT header.
 */
function computeKid(publicJwk: JWK): string {
  // Canonical JSON form: sort keys lexicographically so two identical JWKs
  // hash to identical kids regardless of insertion order.
  const sortedKeys = Object.keys(publicJwk).sort();
  const canonical = JSON.stringify(publicJwk, sortedKeys);
  return createHash("sha256").update(canonical).digest("hex").slice(0, KID_HEX_LENGTH);
}

/**
 * Exports the public half of `publicKeyPem` as a bare JWK (no `kid`/`alg`/
 * `use` yet — those are merged in by {@link bootstrapNewKey} so callers see
 * a fully populated JWK).
 *
 * jose's `exportJWK` is async; `node:crypto`'s `KeyObject.export({format: "jwk"})`
 * is sync and produces the same shape, so we use it to keep this helper
 * synchronous (the bootstrap call site is a constructor-like sync path).
 */
function publicKeyToJwk(publicKeyPem: string): JWK {
  const keyObject = createPublicKey(publicKeyPem);
  return keyObject.export({ format: "jwk" });
}

/** Type guard for a JWK-shaped object — `jose`'s `JWK` is structurally `Record<string, unknown>`. */
function isJwk(value: unknown): value is JWK {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Materializes the in-memory representation from a persisted row. */
function toActiveSigningKey(row: OAuthKeyRow): ActiveSigningKey {
  const parsed: unknown = JSON.parse(row.public_jwk);
  if (!isJwk(parsed)) {
    throw new TypeError(`Invalid public_jwk in oauth_keys row ${row.kid}`);
  }
  if (row.algorithm !== SIGNING_ALGORITHM) {
    throw new TypeError(
      `Unsupported signing algorithm "${row.algorithm}" in oauth_keys row ${row.kid}`,
    );
  }
  return {
    kid: row.kid,
    algorithm: SIGNING_ALGORITHM,
    privatePkcs8: row.private_pkcs8,
    publicJwk: parsed,
  };
}

/** Async alternative to {@link publicKeyToJwk} for code paths that already are async. */
export async function exportPublicJwk(privatePkcs8: string): Promise<JWK> {
  const key = await importPKCS8(privatePkcs8, SIGNING_ALGORITHM);
  return exportJWK(key);
}
