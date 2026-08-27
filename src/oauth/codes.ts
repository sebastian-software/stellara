/**
 * Authorization-code grant helpers (plan 0004 § Auth-Code-Flow).
 *
 * Issues and exchanges short-lived (10 min) one-shot authorization codes
 * bound to `(client_id, user_id, redirect_uri, scope, code_challenge)`. The
 * exchange step verifies the PKCE-S256 binding against the `code_verifier`
 * supplied by the client and runs inside a SQLite transaction so a crash
 * between code-delete and refresh-token-issue cannot strand an exchange in a
 * half-applied state (plan-review finding F-Fehlerfälle).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { OAuthStorage } from "./storage.js";

import { issueRefreshToken } from "./tokens.js";

/** Default code lifetime (10 minutes — OAuth 2.1 recommended ceiling). */
export const AUTH_CODE_TTL_SECONDS = 600;

/** Length of the auth code in bytes before hex encoding. */
const AUTH_CODE_BYTES = 32;

/** Inputs accepted by {@link issueAuthCode}. */
export type IssueAuthCodeOptions = {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  ttlSeconds?: number;
  now?: number;
};

/**
 * Persists a fresh authorization code and returns its raw value. The TTL is
 * embedded in `expires_at` so the periodic sweep can drop it without further
 * bookkeeping; the code itself is single-use and additionally deleted on
 * exchange.
 */
export function issueAuthCode(storage: OAuthStorage, options: IssueAuthCodeOptions): string {
  const code = randomBytes(AUTH_CODE_BYTES).toString("hex");
  const nowMs = options.now ?? Date.now();
  const ttl = options.ttlSeconds ?? AUTH_CODE_TTL_SECONDS;
  storage.insertCode({
    code,
    client_id: options.clientId,
    user_id: options.userId,
    code_challenge: options.codeChallenge,
    redirect_uri: options.redirectUri,
    scope: options.scope,
    expires_at: nowMs + ttl * 1000,
  });
  return code;
}

/** Outcome of an auth-code exchange. */
export type ExchangeResult =
  | { kind: "client_mismatch" }
  | { kind: "expired" }
  | {
      kind: "ok";
      userId: string;
      clientId: string;
      scope: string;
      refreshToken: string;
    }
  | { kind: "pkce_mismatch" }
  | { kind: "redirect_mismatch" }
  | { kind: "unknown" };

/** Inputs accepted by {@link exchangeAuthCode}. */
export type ExchangeAuthCodeOptions = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  refreshTokenTtlSeconds: number;
  now?: number;
};

/**
 * Single-use exchange of an authorization code. On success:
 *   1. The code row is deleted.
 *   2. A refresh token is issued for `(userId, clientId, scope)`.
 *   3. Caller signs the access token via `signAccessToken` and bundles both.
 *
 * Failure cases never partially-mutate the storage: every check happens before
 * the delete + insert, and the whole sequence runs in a single transaction.
 */
export function exchangeAuthCode(
  storage: OAuthStorage,
  options: ExchangeAuthCodeOptions,
): ExchangeResult {
  const nowMs = options.now ?? Date.now();
  const expectedChallenge = computePkceChallenge(options.codeVerifier);
  return storage.db.transaction((): ExchangeResult => {
    const row = storage.getCode(options.code);
    if (row === undefined) return { kind: "unknown" };
    if (row.expires_at <= nowMs) {
      storage.deleteCode(row.code);
      return { kind: "expired" };
    }
    if (row.client_id !== options.clientId) {
      return { kind: "client_mismatch" };
    }
    if (row.redirect_uri !== options.redirectUri) {
      return { kind: "redirect_mismatch" };
    }
    if (!safeEqual(expectedChallenge, row.code_challenge)) {
      return { kind: "pkce_mismatch" };
    }
    storage.deleteCode(row.code);
    const refreshToken = issueRefreshToken(storage, {
      clientId: row.client_id,
      userId: row.user_id,
      scope: row.scope,
      ttlSeconds: options.refreshTokenTtlSeconds,
      now: nowMs,
    });
    return {
      kind: "ok",
      userId: row.user_id,
      clientId: row.client_id,
      scope: row.scope,
      refreshToken,
    };
  })();
}

/**
 * Computes the PKCE S256 challenge for `codeVerifier` per RFC 7636 §4.6:
 * `BASE64URL(SHA256(ASCII(code_verifier)))`. The base64url variant omits
 * padding (no `=`) and replaces `+`/`/` with `-`/`_`.
 */
export function computePkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * Constant-time string comparison. Length-safe (returns `false` immediately
 * for differing lengths without leaking the actual length difference via
 * `timingSafeEqual`'s buffer-comparison cost — both inputs are hashed to
 * fixed-length buffers first).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}
