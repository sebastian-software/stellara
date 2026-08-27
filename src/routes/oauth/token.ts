/**
 * `POST /oauth/token` — token endpoint (plan 0004 §6.6, RFC 6749 §4.1.3 + §6).
 *
 * Handles both grant types via the `grant_type` discriminator from
 * {@link tokenRequestSchema}:
 *
 *   - **authorization_code**: exchanges a PKCE-verified authorization code
 *     for a freshly issued access-token + refresh-token pair.
 *   - **refresh_token**: rotates an opaque refresh token, returning a new
 *     access-token + new refresh-token, and detecting replay (a previously-
 *     rotated token presented again invalidates the entire chain for that
 *     user/client pair per OAuth 2.1 §6.3).
 *
 * All failure paths use the RFC-6749 §5.2 error envelope (`{ error,
 * error_description }`). Public endpoint (no bearer required); the access
 * tokens it mints are the bearer for everything else.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { exchangeAuthCode } from "../../oauth/codes.js";
import { hashClientId, validateBoundTokenResource } from "../../oauth/resource.js";
import { rotateRefreshToken, type RotationResult, signAccessToken } from "../../oauth/tokens.js";
import {
  SCOPE,
  type TokenRequest,
  type TokenRequestAuthCode,
  type TokenRequestRefresh,
  tokenRequestSchema,
  type TokenResponse,
} from "../../schemas/oauth.js";

/** Registers `POST /oauth/token`. */
export function registerOAuthTokenRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "POST",
    url: "/oauth/token",
    schema: {
      hide: true,
      body: tokenRequestSchema,
    },
    async handler(request, reply) {
      const body: TokenRequest = request.body;
      if (body.grant_type === "authorization_code") {
        await handleAuthorizationCodeGrant(app, body, reply);
        return;
      }
      await handleRefreshTokenGrant(app, body, reply);
    },
  });
}

/** Authorization-code-grant happy path + error returns. */
async function handleAuthorizationCodeGrant(
  app: FastifyInstance,
  body: TokenRequestAuthCode,
  reply: FastifyReply,
): Promise<void> {
  const { storage, signingKey } = app.services.oauth;
  if (!validateCodeResource(app, body, reply)) return;
  const result = exchangeAuthCode(storage, {
    code: body.code,
    clientId: body.client_id,
    redirectUri: body.redirect_uri,
    codeVerifier: body.code_verifier,
    refreshTokenTtlSeconds: app.config.oauth.refreshTokenTtlSeconds,
  });
  if (result.kind !== "ok") {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_grant",
      description: describeExchangeFailure(result.kind),
    });
    return;
  }
  const accessToken = await signAccessToken(signingKey, accessTokenClaims(app, result));
  emitTokenIssuedLog({
    reply,
    grant: "authorization_code",
    userId: result.userId,
    clientId: result.clientId,
  });
  sendTokenResponse(
    reply,
    buildTokenResponseBody({
      app,
      accessToken,
      refreshToken: result.refreshToken,
      scope: result.scope,
    }),
  );
}

function validateCodeResource(
  app: FastifyInstance,
  body: TokenRequestAuthCode,
  reply: FastifyReply,
): boolean {
  const { storage } = app.services.oauth;
  const resource = validateBoundTokenResource({
    storage,
    clientId: body.client_id,
    requestedResource: body.resource,
    canonicalResource: `${app.config.publicBaseUrl}/mcp`,
    cutover: app.services.oauth.resourceRequiredSince,
  });
  if (resource.kind === "invalid") {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_target",
      description: resource.reason,
    });
    return false;
  }
  emitLegacyResourceLog(reply, body.client_id, resource.usedLegacyDefault);
  return true;
}

/** Builds the JWT claim set for the authorization-code-grant happy path. */
function accessTokenClaims(
  app: FastifyInstance,
  result: { userId: string; clientId: string; scope: string },
): Parameters<typeof signAccessToken>[1] {
  return {
    issuer: app.config.publicBaseUrl,
    audience: `${app.config.publicBaseUrl}/mcp`,
    userId: result.userId,
    clientId: result.clientId,
    scope: result.scope,
    ttlSeconds: app.config.oauth.accessTokenTtlSeconds,
  };
}

/** Arguments accepted by {@link buildTokenResponseBody}. */
type TokenResponseArgs = {
  app: FastifyInstance;
  accessToken: string;
  refreshToken: string;
  scope: string;
};

/** Shared response-body builder used by both grant types. */
function buildTokenResponseBody(args: TokenResponseArgs): TokenResponse {
  return {
    access_token: args.accessToken,
    token_type: "Bearer",
    expires_in: args.app.config.oauth.accessTokenTtlSeconds,
    refresh_token: args.refreshToken,
    scope: args.scope,
  };
}

/** Arguments accepted by {@link emitTokenIssuedLog}. */
type TokenIssuedLogArgs = {
  reply: FastifyReply;
  grant: "authorization_code" | "refresh_token";
  userId: string;
  clientId: string;
};

/** Common audit-log emission for both grant types. */
function emitTokenIssuedLog(args: TokenIssuedLogArgs): void {
  const { reply, grant, userId, clientId } = args;
  const event = grant === "authorization_code" ? "oauth_token_issued" : "oauth_token_refreshed";
  reply.request.log.info(
    { event, grant, userId, clientIdHash: hashClientId(clientId), ip: reply.request.ip },
    grant === "authorization_code" ? "oauth token issued" : "oauth token refreshed",
  );
}

/** Refresh-token-grant happy path + replay/expiry returns. */
async function handleRefreshTokenGrant(
  app: FastifyInstance,
  body: TokenRequestRefresh,
  reply: FastifyReply,
): Promise<void> {
  const { storage, signingKey } = app.services.oauth;
  if (!validateRefreshPreflight(app, body, reply)) return;
  const result = rotateRefreshToken(storage, {
    presentedToken: body.refresh_token,
    expectedClientId: body.client_id,
    ttlSeconds: app.config.oauth.refreshTokenTtlSeconds,
  });
  if (result.kind !== "ok") {
    handleRefreshFailure(reply, result, body);
    return;
  }
  // Refresh-grant cannot widen scope (RFC 6749 §6); we reuse whatever was
  // bound to the original token, which today is always `mcp`.
  const scope = result.row.scope;
  const accessToken = await signAccessToken(signingKey, {
    issuer: app.config.publicBaseUrl,
    audience: `${app.config.publicBaseUrl}/mcp`,
    userId: result.row.user_id,
    clientId: result.row.client_id,
    scope: SCOPE,
    ttlSeconds: app.config.oauth.accessTokenTtlSeconds,
  });
  emitTokenIssuedLog({
    reply,
    grant: "refresh_token",
    userId: result.row.user_id,
    clientId: result.row.client_id,
  });
  sendTokenResponse(
    reply,
    buildTokenResponseBody({ app, accessToken, refreshToken: result.newToken, scope }),
  );
}

function validateRefreshPreflight(
  app: FastifyInstance,
  body: TokenRequestRefresh,
  reply: FastifyReply,
): boolean {
  const { storage } = app.services.oauth;
  const existing = storage.getRefreshToken(body.refresh_token);
  if (existing?.client_id !== body.client_id) return true;
  const resource = validateBoundTokenResource({
    storage,
    clientId: body.client_id,
    requestedResource: body.resource,
    canonicalResource: `${app.config.publicBaseUrl}/mcp`,
    cutover: app.services.oauth.resourceRequiredSince,
  });
  if (resource.kind === "invalid") {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_target",
      description: resource.reason,
    });
    return false;
  }
  if (body.scope !== undefined && body.scope !== existing.scope) {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_scope",
      description: "Refresh cannot widen the granted scope",
    });
    return false;
  }
  emitLegacyResourceLog(reply, body.client_id, resource.usedLegacyDefault);
  return true;
}

/** Branches refresh-rotation failures onto the corresponding RFC error code. */
function handleRefreshFailure(
  reply: FastifyReply,
  result: Exclude<RotationResult, { kind: "ok" }>,
  body: TokenRequestRefresh,
): void {
  if (result.kind === "replay") {
    reply.request.log.warn(
      {
        event: "oauth_refresh_replay_detected",
        clientIdHash: hashClientId(body.client_id),
        chainDeleted: result.chainDeleted,
        ip: reply.request.ip,
      },
      "oauth refresh replay detected",
    );
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_grant",
      description: "Refresh token replay detected",
    });
    return;
  }
  if (result.kind === "expired") {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_grant",
      description: "Refresh token expired",
    });
    return;
  }
  if (result.kind === "unknown_client") {
    sendOAuthError({
      reply,
      status: 400,
      error: "invalid_client",
      description: "Refresh token does not belong to this client",
    });
    return;
  }
  sendOAuthError({
    reply,
    status: 400,
    error: "invalid_grant",
    description: "Unknown refresh token",
  });
}

function describeExchangeFailure(kind: string): string {
  switch (kind) {
    case "expired":
      return "Authorization code expired";
    case "client_mismatch":
      return "Authorization code does not belong to this client";
    case "redirect_mismatch":
      return "redirect_uri does not match the original authorize call";
    case "pkce_mismatch":
      return "code_verifier does not match the original code_challenge";
    default:
      return "Unknown authorization code";
  }
}

function sendTokenResponse(reply: FastifyReply, body: TokenResponse): void {
  void reply.code(200).header("cache-control", "no-store").header("pragma", "no-cache").send(body);
}

/** Arguments accepted by {@link sendOAuthError}. */
type OAuthErrorArgs = {
  reply: FastifyReply;
  status: number;
  error: string;
  description: string;
};

function emitLegacyResourceLog(
  reply: FastifyReply,
  clientId: string,
  usedLegacyDefault: boolean,
): void {
  if (!usedLegacyDefault) return;
  reply.request.log.warn(
    { event: "oauth_resource_legacy_default", clientIdHash: hashClientId(clientId) },
    "oauth resource defaulted for legacy client",
  );
}

function sendOAuthError(args: OAuthErrorArgs): void {
  void args.reply
    .code(args.status)
    .header("cache-control", "no-store")
    .send({ error: args.error, error_description: args.description });
}
