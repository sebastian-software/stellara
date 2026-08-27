/**
 * JWT access tokens + opaque refresh tokens for Stellara's OAuth subsystem
 * (plan 0004 § Tokens).
 *
 * Access tokens are RS256-signed JWTs with the MCP-required claims
 * (`iss`/`sub`/`aud`/`exp`/`iat`/`jti`/`scope`/`client_id`); validation runs
 * offline against the cached JWKS. Refresh tokens are 32-byte hex strings
 * persisted in SQLite with single-use rotation and replay-detection per
 * OAuth-2.1 §6.3.
 */
import { importJWK, type JWTPayload, jwtVerify, SignJWT } from "jose";
import { randomBytes } from "node:crypto";

import type { OAuthRefreshTokenRow, OAuthStorage } from "./storage.js";

import { type ActiveSigningKey, importPrivateKey } from "./keys.js";

/** Length of the opaque refresh-token value in bytes before hex encoding. */
const REFRESH_TOKEN_BYTES = 32;

/** Length of the `jti` claim in bytes before hex encoding. */
const JTI_BYTES = 16;

/** Inputs accepted by {@link signAccessToken}. */
export type AccessTokenClaims = {
  /** Authorization-server issuer URL — must equal the discovery `issuer`. */
  issuer: string;
  /** Resource URL the token grants access to (MCP `aud` claim). */
  audience: string;
  /** Resolved Stellara userId (§6.3). Lands in the `sub` claim. */
  userId: string;
  /** DCR-assigned client identifier. Lands in the `client_id` claim. */
  clientId: string;
  /** Granted scope (single string, space-separated if multiple). */
  scope: string;
  /** Lifetime in seconds; default 3600 (one hour). */
  ttlSeconds: number;
  /** Reference time for `iat`/`exp`; defaults to `Date.now()`. */
  now?: number;
};

/** Inputs accepted by {@link verifyAccessToken}. */
export type AccessTokenVerification = {
  /** Encoded JWT string from the `Authorization: Bearer …` header. */
  jwt: string;
  /** Required `iss` claim — typically the discovery `issuer`. */
  issuer: string;
  /** Required `aud` claim — the resource URL. */
  audience: string;
  /** Active signing key whose public half verifies the signature. */
  key: ActiveSigningKey;
  /**
   * Optional reference clock for `exp`/`nbf` validation, expressed in
   * milliseconds since epoch. Defaults to the system clock. Tests use this
   * to deterministically validate tokens minted at fixed times without
   * relying on wall-clock skew.
   */
  now?: number;
};

/** Verified claims returned by {@link verifyAccessToken}. */
export type VerifiedAccessToken = {
  /** Resolved userId from `sub`. */
  userId: string;
  /** DCR client_id the token was issued to. */
  clientId: string;
  /** Granted scope. */
  scope: string;
  /** Raw JWT id (`jti`) for log correlation. */
  jti: string;
  /** Expiry timestamp (epoch seconds). */
  expiresAt: number;
};

/**
 * Signs an access token with the supplied active key. Returns the encoded
 * JWT string. Errors surface as `Error`; callers are responsible for mapping
 * them onto OAuth `error: server_error` responses.
 */
export async function signAccessToken(
  key: ActiveSigningKey,
  claims: AccessTokenClaims,
): Promise<string> {
  const nowSec = Math.floor((claims.now ?? Date.now()) / 1000);
  const privateKey = await importPrivateKey(key);
  const jti = randomBytes(JTI_BYTES).toString("hex");
  return new SignJWT({
    scope: claims.scope,
    client_id: claims.clientId,
  })
    .setProtectedHeader({ alg: key.algorithm, kid: key.kid, typ: "JWT" })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setSubject(claims.userId)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + claims.ttlSeconds)
    .setJti(jti)
    .sign(privateKey);
}

/**
 * Verifies an access token's signature, expiry, issuer and audience. Throws
 * when any check fails (jose's own `JWTExpired`/`JWSSignatureVerificationFailed`
 * exception types bubble up unchanged so callers can branch on them if needed).
 */
export async function verifyAccessToken(
  options: AccessTokenVerification,
): Promise<VerifiedAccessToken> {
  const { jwt: token, issuer, audience, key } = options;
  const publicKey = await importJWK(key.publicJwk, key.algorithm);
  const { payload } = await jwtVerify(token, publicKey, {
    issuer,
    audience,
    algorithms: [key.algorithm],
    currentDate: options.now === undefined ? undefined : new Date(options.now),
  });
  return extractClaims(payload);
}

/**
 * Issues a fresh refresh token and persists it. The returned string is
 * cryptographically random 32-byte hex; storage links it to `(clientId, userId,
 * scope)`.
 */
export function issueRefreshToken(
  storage: OAuthStorage,
  options: {
    clientId: string;
    userId: string;
    scope: string;
    ttlSeconds: number;
    now?: number;
  },
): string {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
  const nowMs = options.now ?? Date.now();
  storage.insertRefreshToken({
    token,
    client_id: options.clientId,
    user_id: options.userId,
    scope: options.scope,
    issued_at: nowMs,
    expires_at: nowMs + options.ttlSeconds * 1000,
    rotated_to: null,
  });
  return token;
}

/** Outcome of a refresh-token rotation attempt. */
export type RotationResult =
  | { kind: "expired" }
  | { kind: "ok"; row: OAuthRefreshTokenRow; newToken: string }
  | { kind: "replay"; chainDeleted: number }
  | { kind: "unknown_client" }
  | { kind: "unknown" };

/**
 * Rotates a refresh token per OAuth 2.1 §6.3. The old token is marked
 * rotated, a new one is issued for the same `(userId, clientId, scope)`, and
 * the new token is returned alongside the verified previous row so callers
 * can issue a paired access token.
 *
 * Replay-detection: if the supplied token has already been rotated, the
 * entire token chain for `(userId, clientId)` is invalidated and `replay`
 * is returned. RFC 6749 §10.4 mandates this — a leaked refresh token must
 * stop being usable once the legitimate client also rotates.
 *
 * Per the build-skill requirement and plan-review F-Fehlerfälle finding, the
 * lookup, replay check, mark-rotated, and insert-new run inside a single
 * SQLite transaction so a crash mid-rotation leaves the chain consistent.
 */
export function rotateRefreshToken(
  storage: OAuthStorage,
  options: {
    presentedToken: string;
    expectedClientId: string;
    ttlSeconds: number;
    now?: number;
  },
): RotationResult {
  const nowMs = options.now ?? Date.now();
  return storage.db.transaction((): RotationResult => {
    const row = storage.getRefreshToken(options.presentedToken);
    if (row === undefined) return { kind: "unknown" };
    if (row.client_id !== options.expectedClientId) return { kind: "unknown_client" };
    if (row.rotated_to !== null) {
      const deleted = storage.deleteRefreshTokenChain(row.user_id, row.client_id);
      return { kind: "replay", chainDeleted: deleted };
    }
    if (row.expires_at <= nowMs) return { kind: "expired" };
    const newToken = randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
    storage.insertRefreshToken({
      token: newToken,
      client_id: row.client_id,
      user_id: row.user_id,
      scope: row.scope,
      issued_at: nowMs,
      expires_at: nowMs + options.ttlSeconds * 1000,
      rotated_to: null,
    });
    storage.markRefreshTokenRotated(row.token, newToken);
    return { kind: "ok", row, newToken };
  })();
}

/** Narrows an unverified jose payload to {@link VerifiedAccessToken}. */
function extractClaims(payload: JWTPayload): VerifiedAccessToken {
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new TypeError("Missing sub claim");
  }
  if (typeof payload.exp !== "number") {
    throw new TypeError("Missing exp claim");
  }
  if (typeof payload.jti !== "string" || payload.jti === "") {
    throw new TypeError("Missing jti claim");
  }
  const scope = readStringClaim(payload, "scope");
  const clientId = readStringClaim(payload, "client_id");
  return {
    userId: payload.sub,
    clientId,
    scope,
    jti: payload.jti,
    expiresAt: payload.exp,
  };
}

function readStringClaim(payload: JWTPayload, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`Missing ${name} claim`);
  }
  return value;
}
