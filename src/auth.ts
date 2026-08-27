/**
 * Bearer-token resolution for Stellara (concept §6 + §6.6).
 *
 * Two-pathed bearer auth:
 * 1. **Static-Token** — `STELLARA_TOKEN_<USERID>`-mapped credentials looked up
 *    in {@link Config.tokens} via constant-time comparison.
 * 2. **OAuth-2.1 JWT** — RS256-signed access tokens issued by the in-process
 *    Authorization Server (`src/routes/oauth/*`). The token's `sub` claim
 *    becomes the userId; `client_id`/`jti` enrich the audit log.
 *
 * Format heuristic decides which path runs: a header value containing exactly
 * two `.` separators (compact-JWS) is parsed as a JWT candidate. JWT-format
 * tokens that fail verification are rejected with 401 and **never** fall
 * back to the static-token map — that asymmetry prevents an attacker from
 * smuggling a malformed JWT to learn whether a similar string exists in the
 * static map.
 *
 * Exports {@link PUBLIC_PATHS}, the bypass allowlist that contains both the
 * legacy health endpoints and the new OAuth discovery/flow endpoints.
 */
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { createHash, timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";
import type { ActiveSigningKey } from "./oauth/keys.js";

import { AppError, ErrorCode, toErrorResponse } from "./errors.js";
import { type VerifiedAccessToken, verifyAccessToken } from "./oauth/tokens.js";

/**
 * Routes that are exempt from bearer-token auth (concept §6.4 + §6.6). They
 * are also exempt from rate-limit accounting (see `rate-limit.ts`).
 *
 * The OAuth discovery + flow endpoints must be reachable without a bearer
 * because the bearer itself is obtained through them.
 */
export const PUBLIC_PATHS: readonly string[] = [
  "/health",
  "/ready",
  "/openapi.json",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/oauth/authorize",
  "/oauth/login",
  "/oauth/token",
  "/oauth/register",
  "/oauth/jwks",
];

/**
 * Resolves `request.userId` or throws `INTERNAL_ERROR`. The auth hook
 * guarantees `userId` is set on every non-public route, so reaching the
 * fallback indicates a hook ordering bug rather than a client error.
 */
export function requireUserId(request: FastifyRequest): string {
  const userId = request.userId;
  if (userId === undefined) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Resolved userId missing from request",
    });
  }
  return userId;
}

function stripQuery(pathOrUrl: string): string {
  const queryStart = pathOrUrl.indexOf("?");
  return queryStart === -1 ? pathOrUrl : pathOrUrl.slice(0, queryStart);
}

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

/**
 * Returns true if the literal path (without query, with a tolerated trailing
 * slash) is on the public allowlist.
 */
export function isPublicPath(pathOrUrl: string): boolean {
  const path = stripTrailingSlash(stripQuery(pathOrUrl));
  return PUBLIC_PATHS.includes(path);
}

/**
 * Returns true if the request targets a public, auth-free endpoint — used by
 * both the auth hook and the rate-limit allowList so they stay in sync.
 */
export function isPublicRequest(request: FastifyRequest): boolean {
  const candidate = request.routeOptions.url ?? request.url;
  return isPublicPath(candidate);
}

function parseBearerToken(headerValue: string | undefined): string | undefined {
  if (typeof headerValue !== "string") return undefined;
  // RFC 6750 §2.1 requires case-insensitive scheme matching; iOS Shortcuts
  // and other clients sometimes send `authorization: bearer …` lowercase.
  const spaceIndex = headerValue.indexOf(" ");
  if (spaceIndex === -1) return undefined;
  const scheme = headerValue.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== "bearer") return undefined;
  const token = headerValue.slice(spaceIndex + 1).trim();
  return token === "" ? undefined : token;
}

/**
 * SHA-256 digest of a UTF-8-encoded string. The fixed 32-byte output makes
 * downstream {@link timingSafeEqual} calls length-independent — comparing
 * raw token strings would leak the known token's length through the early
 * length check that `timingSafeEqual` performs on mismatched buffers.
 */
function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Resolves a bearer token to its userId in constant time with respect to
 * which entry matches. The loop visits every configured token even after a
 * match so that an attacker cannot infer the matched slot from response
 * latency. Per-request cost is ~3 SHA-256 digests + 3 buffer comparisons,
 * which is in the low microsecond range and negligible compared to the rest
 * of the request lifecycle.
 */
function resolveTokenConstantTime(
  token: string,
  tokens: ReadonlyMap<string, string>,
): string | undefined {
  const inputDigest = digest(token);
  let matched: string | undefined;
  for (const [knownToken, userId] of tokens) {
    const knownDigest = digest(knownToken);
    if (timingSafeEqual(inputDigest, knownDigest)) {
      matched = userId;
    }
  }
  return matched;
}

/**
 * Lightweight predicate the unauth rate-limit hook uses to decide whether a
 * request is even attempting bearer auth. It does NOT validate the token —
 * that is the auth hook's job — it only checks whether the scheme is
 * present, mirroring {@link parseBearerToken}'s scheme handling so the two
 * paths stay in sync.
 */
export function hasBearerHeader(headerValue: string | undefined): boolean {
  return parseBearerToken(headerValue) !== undefined;
}

async function send401(reply: FastifyReply, message: string): Promise<void> {
  // Audit-trail entry for failed authentication (§21). At this point the auth
  // hook has not resolved a userId, so the child logger only carries the
  // requestId/clientIp context — that's enough to correlate offending clients.
  reply.request.log.warn({ reason: message }, "auth rejected");
  const body = toErrorResponse(new AppError({ code: ErrorCode.UNAUTHORIZED, message }));
  const metadataUrl = `${reply.request.server.config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  await reply
    .code(401)
    .header("www-authenticate", `Bearer resource_metadata="${metadataUrl}" scope="mcp"`)
    .send(body);
}

/** Successful resolution payload — carries audit-log context for JWT auth. */
type AuthSuccess = {
  reason: undefined;
  userId: string;
  clientId: string;
  expiresAt?: number;
  jti?: string;
  scopes: readonly string[];
};

type AuthFailure = {
  reason: string;
  userId: undefined;
};

type AuthResolution = AuthFailure | AuthSuccess;

/**
 * Heuristic: a JWT in compact-JWS form has exactly two `.` separators (three
 * base64url segments). Static `STELLARA_TOKEN_<USERID>` values are 64-char
 * hex and never contain a dot, so the two formats are unambiguously
 * separable in practice.
 */
function looksLikeJwt(token: string): boolean {
  let dots = 0;
  for (const ch of token) {
    if (ch === ".") dots += 1;
  }
  return dots === 2;
}

/** Dependencies the auth hook needs beyond the bare `Config`. */
export type AuthHookDeps = {
  /** Active signing key whose public half verifies inbound JWTs. */
  signingKey: ActiveSigningKey;
};

/**
 * Resolves the bearer token against either the OAuth JWT path or the static
 * token map in a single pass. Revocation is checked BEFORE the static lookup
 * so a leaked credential cannot be used even when its env entry is still
 * present (§6.5). JWT-format tokens are validated against the active signing
 * key and the configured issuer/audience; a JWT-format token that fails
 * verification is rejected with 401 and never falls back to the static path.
 */
async function resolveBearerToken(
  config: Pick<Config, "publicBaseUrl" | "revokedTokens" | "tokens">,
  signingKey: ActiveSigningKey,
  headerValue: string | undefined,
): Promise<AuthResolution> {
  const token = parseBearerToken(headerValue);
  if (token === undefined) {
    return { reason: "Missing or malformed Authorization header", userId: undefined };
  }
  if (config.revokedTokens.has(token)) {
    return { reason: "Unknown bearer token", userId: undefined };
  }
  if (looksLikeJwt(token)) {
    return resolveJwtBearer(config, signingKey, token);
  }
  const userId = resolveTokenConstantTime(token, config.tokens);
  if (userId === undefined) {
    return { reason: "Unknown bearer token", userId: undefined };
  }
  return { clientId: `static:${userId}`, reason: undefined, scopes: ["mcp"], userId };
}

/**
 * Verifies a JWT-format bearer token via {@link verifyAccessToken}. Issuer
 * and audience are derived from `config.publicBaseUrl` so an access token
 * issued by another Stellara instance (different `publicBaseUrl`) is
 * rejected.
 */
async function resolveJwtBearer(
  config: Pick<Config, "publicBaseUrl">,
  signingKey: ActiveSigningKey,
  jwt: string,
): Promise<AuthResolution> {
  let verified: VerifiedAccessToken;
  try {
    verified = await verifyAccessToken({
      jwt,
      issuer: config.publicBaseUrl,
      audience: `${config.publicBaseUrl}/mcp`,
      key: signingKey,
    });
  } catch {
    // No fallback to the static-token map: a JWT-format token that fails
    // verification is a stronger signal than an unknown opaque token, so we
    // surface a distinct (but still constant-time-safe) rejection reason.
    return { reason: "Invalid OAuth access token", userId: undefined };
  }
  const scopes = verified.scope.split(/\s+/u).filter((scope) => scope.length > 0);
  if (!scopes.includes("mcp")) {
    return { reason: "OAuth access token lacks required mcp scope", userId: undefined };
  }
  return {
    reason: undefined,
    userId: verified.userId,
    clientId: verified.clientId,
    expiresAt: verified.expiresAt,
    jti: verified.jti,
    scopes,
  };
}

/**
 * Builds the Fastify `onRequest` hook that enforces bearer-token auth.
 * Public paths (§6.4 + §6.6) bypass auth. Revoked tokens are rejected with
 * the same 401 envelope as unknown tokens. On success an `info`-level audit
 * entry is emitted carrying `userId`, `clientIp`, and (for OAuth-issued
 * JWTs) `clientId` and `jti` so an operator can answer "which client used
 * which credential, when, from where?".
 */
export function createAuthHook(config: Config, deps: AuthHookDeps): onRequestAsyncHookHandler {
  return async function authHook(request, reply) {
    if (isPublicRequest(request)) {
      return;
    }

    const resolution = await resolveBearerToken(
      config,
      deps.signingKey,
      request.headers.authorization,
    );
    if (resolution.userId === undefined) {
      await send401(reply, resolution.reason);
      return;
    }

    // `require-atomic-updates` triggers because the assignment follows an
    // await, but Fastify serializes hook execution per request — there is
    // no concurrent path that could clobber `request.userId` between the
    // await and the assignment.
    // eslint-disable-next-line require-atomic-updates
    request.userId = resolution.userId;
    // eslint-disable-next-line require-atomic-updates
    request.mcpAuth = {
      clientId: resolution.clientId,
      expiresAt: resolution.expiresAt,
      scopes: resolution.scopes,
      userId: resolution.userId,
    };
    // Audit-trail success entry (§21). We log `userId`/`clientIp` explicit
    // rather than relying on the child-logger binding because the
    // userId-binding hook only runs AFTER this hook returns — at this point
    // the child logger still only carries `requestId`. For JWT bearers we
    // additionally surface `clientId` + `jti` so an operator can correlate
    // a token back to its DCR-registered client and to its OAuth-issued
    // session without ever logging the token value itself.
    const auditFields: Record<string, string> = {
      userId: resolution.userId,
      clientIp: request.ip,
    };
    auditFields.clientIdHash = digest(resolution.clientId).toString("hex");
    if (resolution.jti !== undefined) auditFields.jti = resolution.jti;
    request.log.info(auditFields, "auth ok");
  };
}
