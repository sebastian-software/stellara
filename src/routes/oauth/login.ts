/**
 * `POST /oauth/login` — handles the credential-submit step of the browser
 * flow. The form posts back every authorize-query field plus the user's
 * `STELLARA_TOKEN_<USERID>` value; this handler:
 *
 *   1. Validates the body against {@link loginFormSchema}.
 *   2. Matches the token against `Config.tokens` in constant time. On
 *      mismatch, re-renders the login form with a short error message.
 *   3. On success: creates a session row, sets the `stellara_session`
 *      cookie (HttpOnly, SameSite=Lax, 12h TTL) and 302-redirects to
 *      `/oauth/authorize` with the original query string so the GET handler
 *      can finish the flow now that a valid session exists.
 *
 * The login form lives at `GET /oauth/authorize` — see `authorize.ts`. We
 * never re-render the form here from scratch except on credential mismatch.
 *
 * Public endpoint, no bearer required. Hidden from OpenAPI.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { createHash, timingSafeEqual } from "node:crypto";

import { ClientMetadataError, type ResolvedClient } from "../../oauth/client-metadata.js";
import { type LoginFormState, renderLoginForm } from "../../oauth/login-form.js";
import { hashClientId, validateResolvedClientResource } from "../../oauth/resource.js";
import { type LoginForm, loginFormSchema, SCOPE } from "../../schemas/oauth.js";

const SESSION_COOKIE_NAME = "stellara_session";

/** Registers `POST /oauth/login`. */
export function registerOAuthLoginRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { storage, sessions } = app.services.oauth;
  typed.route({
    method: "POST",
    url: "/oauth/login",
    schema: {
      hide: true,
      body: loginFormSchema,
    },
    async handler(request, reply) {
      const body = request.body;
      const client = await revalidateFormState({ app, body, sourceIp: request.ip, reply });
      if (client === undefined) return;
      const userId = resolveTokenConstantTime(body.token, app.config.tokens);
      if (userId === undefined) {
        handleInvalidToken({ reply, body, client, sourceIp: request.ip });
        return;
      }
      const session = sessions.createSession(storage, userId);
      request.log.info(
        {
          event: "oauth_login_succeeded",
          userId,
          clientIdHash: hashClientId(body.client_id),
          ip: request.ip,
        },
        "oauth login succeeded",
      );
      const target = buildAuthorizeUrl(body);
      void reply
        .code(302)
        .setCookie(SESSION_COOKIE_NAME, session.sessionId, {
          httpOnly: true,
          sameSite: "lax",
          secure: app.config.nodeEnv === "production",
          path: "/oauth/",
          maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
        })
        .header("location", target)
        .send();
    },
  });
}

function handleInvalidToken(args: {
  reply: FastifyReply;
  body: LoginForm;
  client: ResolvedClient;
  sourceIp: string;
}): void {
  args.reply.request.log.warn(
    {
      event: "oauth_login_failed",
      clientIdHash: hashClientId(args.body.client_id),
      ip: args.sourceIp,
    },
    "oauth login rejected",
  );
  renderLoginAgain({
    reply: args.reply,
    body: args.body,
    client: args.client,
    message: "Invalid token. Please try again.",
  });
}

/**
 * Constant-time bearer-token lookup. Identical to the static path in
 * `src/auth.ts` so the login form has the same timing characteristics as
 * direct API auth.
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

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Re-renders the login form with an inline error and a 400 status. The
 * submitted token value is **not** echoed back into the form — the user has
 * to retype it, which is mild UX friction in exchange for not splashing the
 * credential across browser history / shared screens.
 */
function renderLoginAgain(args: {
  reply: FastifyReply;
  body: LoginForm;
  client: ResolvedClient;
  message: string;
}): void {
  const state = toVerifiedFormState(args.body, args.client);
  void args.reply
    .code(400)
    .header("content-type", "text/html; charset=utf-8")
    .send(renderLoginForm(state, { message: args.message }));
}

function toVerifiedFormState(body: LoginForm, client: ResolvedClient): LoginFormState {
  const redirect = new URL(body.redirect_uri);
  return {
    client_id: body.client_id,
    redirect_uri: body.redirect_uri,
    response_type: body.response_type,
    scope: body.scope,
    state: body.state,
    code_challenge: body.code_challenge,
    code_challenge_method: body.code_challenge_method,
    resource: body.resource,
    client_name: client.clientName ?? "An unnamed client",
    redirect_host: redirect.host,
    localhost_redirect: ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname),
  };
}

/** Rebuilds the `/oauth/authorize` URL from the form fields. */
function buildAuthorizeUrl(body: LoginForm): string {
  const params = new URLSearchParams({
    response_type: body.response_type,
    client_id: body.client_id,
    redirect_uri: body.redirect_uri,
    scope: body.scope,
    state: body.state,
    code_challenge: body.code_challenge,
    code_challenge_method: body.code_challenge_method,
  });
  if (body.resource !== undefined) params.set("resource", body.resource);
  return `/oauth/authorize?${params.toString()}`;
}

async function revalidateFormState(args: {
  app: FastifyInstance;
  body: LoginForm;
  sourceIp: string;
  reply: FastifyReply;
}): Promise<ResolvedClient | undefined> {
  const { app, body, sourceIp, reply } = args;
  let client: ResolvedClient;
  try {
    client = await app.services.oauth.clientResolver.resolveClient(body.client_id, sourceIp);
  } catch (error) {
    sendClientResolutionError(reply, error);
    return undefined;
  }
  if (!client.redirectUris.includes(body.redirect_uri) || body.scope !== SCOPE) {
    sendLocalFormError(reply);
    return undefined;
  }
  const resource = validateResolvedClientResource({
    client,
    requestedResource: body.resource,
    canonicalResource: `${app.config.publicBaseUrl}/mcp`,
    cutover: app.services.oauth.resourceRequiredSince,
  });
  if (resource.kind === "invalid") {
    sendLocalFormError(reply);
    return undefined;
  }
  emitLegacyResourceLog(reply, body.client_id, resource.usedLegacyDefault);
  return client;
}

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

function sendLocalFormError(reply: FastifyReply): void {
  void reply
    .code(400)
    .header("content-type", "text/html; charset=utf-8")
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OAuth error</title></head>' +
        "<body><h1>OAuth error</h1><p>Unable to verify the authorization request.</p></body></html>",
    );
}

function sendClientResolutionError(reply: FastifyReply, error: unknown): void {
  if (error instanceof ClientMetadataError && error.kind === "rate_limited") {
    void reply
      .code(429)
      .header("retry-after", String(error.retryAfterSeconds ?? 60))
      .send({ error: "temporarily_unavailable", error_description: "Client lookup rate limited" });
    return;
  }
  if (error instanceof ClientMetadataError && error.kind === "temporarily_unavailable") {
    void reply.code(503).send({
      error: "temporarily_unavailable",
      error_description: "Client lookup temporarily unavailable",
    });
    return;
  }
  sendLocalFormError(reply);
}
