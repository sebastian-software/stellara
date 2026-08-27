/**
 * `GET /oauth/authorize` — entry point of the browser-based OAuth flow.
 *
 * Decision tree:
 *   1. Validate the inbound query string against {@link authorizeQuerySchema}.
 *   2. Resolve `client_id` against the DCR registry; reject unknown clients.
 *   3. Reject `redirect_uri` values not bound to the client at registration.
 *   4. Look up the session cookie. If present and valid → issue an
 *      authorization code immediately and 302-redirect to `redirect_uri`
 *      with `?code=...&state=...` appended.
 *   5. Otherwise → render the login form (200 text/html), with all
 *      authorize-query fields embedded as hidden inputs so the POST handler
 *      can resume the flow after the user submits their token.
 *
 * Public endpoint, no bearer required. Hidden from OpenAPI.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { ClientMetadataError, type ResolvedClient } from "../../oauth/client-metadata.js";
import { issueAuthCode } from "../../oauth/codes.js";
import { type LoginFormState, renderLoginForm } from "../../oauth/login-form.js";
import { hashClientId, validateResolvedClientResource } from "../../oauth/resource.js";
import { type AuthorizeQuery, authorizeQuerySchema, SCOPE } from "../../schemas/oauth.js";

const SESSION_COOKIE_NAME = "stellara_session";

/** Arguments accepted by {@link handleAuthorize}. */
type AuthorizeArgs = {
  app: FastifyInstance;
  query: AuthorizeQuery;
  request: FastifyRequest;
  reply: FastifyReply;
};

/** Registers `GET /oauth/authorize`. */
export function registerOAuthAuthorizeRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "GET",
    url: "/oauth/authorize",
    schema: {
      hide: true,
      querystring: authorizeQuerySchema,
    },
    async handler(request, reply) {
      await handleAuthorize({ app, query: request.query, request, reply });
    },
  });
}

/**
 * Main authorize-flow control sequence — pulled out of the route handler to
 * stay under the per-function statement budget. Pre-validation of the
 * client_id/redirect_uri pair is delegated to {@link resolveAndValidateClient};
 * once that passes the function chooses between issuing a code (active
 * session) or rendering the login form.
 */
async function handleAuthorize(args: AuthorizeArgs): Promise<void> {
  const { app, query, request, reply } = args;
  const client = await resolveAndValidateClient(args);
  if (client === undefined) return;
  const sessionId = readSessionCookie(request);
  const sessionResult =
    sessionId === undefined
      ? { kind: "unknown" as const }
      : app.services.oauth.sessions.resolveSession(app.services.oauth.storage, sessionId);
  if (sessionResult.kind === "ok") {
    issueCodeAndRedirect({ app, query, userId: sessionResult.userId, reply });
    return;
  }
  void reply
    .code(200)
    .header("content-type", "text/html; charset=utf-8")
    .send(renderLoginForm(toFormState(query, client)));
}

/**
 * Checks that the inbound client_id + redirect_uri pair is consistent with a
 * registered DCR entry and that the requested scope matches the server's
 * single supported scope. Sends the appropriate 400/302 reply on failure and
 * returns `false` so the caller can short-circuit.
 */
async function resolveAndValidateClient(args: AuthorizeArgs): Promise<ResolvedClient | undefined> {
  const { app, query, request, reply } = args;
  let client: ResolvedClient;
  try {
    client = await app.services.oauth.clientResolver.resolveClient(query.client_id, request.ip);
  } catch (error) {
    sendClientResolutionError(reply, error);
    return undefined;
  }
  return validateResolvedBinding(args, client) ? client : undefined;
}

function validateResolvedBinding(args: AuthorizeArgs, client: ResolvedClient): boolean {
  const { app, query, request, reply } = args;
  if (!client.redirectUris.includes(query.redirect_uri)) {
    sendAuthorizeError(reply, "redirect_uri not registered for this client");
    return false;
  }
  if (query.scope !== SCOPE) {
    redirectWithError({
      reply,
      redirectUri: query.redirect_uri,
      state: query.state,
      error: "invalid_scope",
      issuer: app.config.publicBaseUrl,
    });
    return false;
  }
  const resource = validateResolvedClientResource({
    client,
    requestedResource: query.resource,
    canonicalResource: `${app.config.publicBaseUrl}/mcp`,
    cutover: app.services.oauth.resourceRequiredSince,
  });
  if (resource.kind === "invalid") {
    redirectWithError({
      reply,
      redirectUri: query.redirect_uri,
      state: query.state,
      error: "invalid_request",
      issuer: app.config.publicBaseUrl,
    });
    return false;
  }
  if (resource.usedLegacyDefault) {
    request.log.warn(
      { event: "oauth_resource_legacy_default", clientIdHash: hashClientId(query.client_id) },
      "oauth resource defaulted for legacy client",
    );
  }
  return true;
}

/** Arguments accepted by {@link issueCodeAndRedirect}. */
type IssueCodeArgs = {
  app: FastifyInstance;
  query: AuthorizeQuery;
  userId: string;
  reply: FastifyReply;
};

/** Issues a fresh code for the resolved user and 302s to the redirect URI. */
function issueCodeAndRedirect(args: IssueCodeArgs): void {
  const { app, query, userId, reply } = args;
  const code = issueAuthCode(app.services.oauth.storage, {
    clientId: query.client_id,
    userId,
    redirectUri: query.redirect_uri,
    scope: query.scope,
    codeChallenge: query.code_challenge,
  });
  reply.request.log.info(
    {
      event: "oauth_code_issued",
      clientIdHash: hashClientId(query.client_id),
      userId,
      ip: reply.request.ip,
    },
    "oauth code issued",
  );
  const target = appendCodeAndState({
    redirectUri: query.redirect_uri,
    code,
    state: query.state,
    issuer: app.config.publicBaseUrl,
  });
  void reply.code(302).header("location", target).send();
}

/**
 * Appends `?code=...&state=...` (or `&code=...&state=...` if the URL already
 * carries a query string) to the redirect URI in a tolerant manner.
 */
function appendCodeAndState(args: {
  redirectUri: string;
  code: string;
  state: string;
  issuer: string;
}): string {
  const url = new URL(args.redirectUri);
  url.searchParams.set("code", args.code);
  url.searchParams.set("state", args.state);
  url.searchParams.set("iss", args.issuer);
  return url.toString();
}

function readSessionCookie(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

function toFormState(query: AuthorizeQuery, client: ResolvedClient): LoginFormState {
  const redirect = new URL(query.redirect_uri);
  return {
    client_id: query.client_id,
    redirect_uri: query.redirect_uri,
    response_type: query.response_type,
    scope: query.scope,
    state: query.state,
    code_challenge: query.code_challenge,
    code_challenge_method: query.code_challenge_method,
    resource: query.resource,
    client_name: client.clientName ?? "An unnamed client",
    redirect_host: redirect.host,
    localhost_redirect: ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname),
  };
}

/**
 * Sends a 400 with a plain text/html body explaining the rejection. Used
 * when the redirect URI cannot be trusted (unknown client, mismatched
 * redirect URI) — in that case redirecting the user back would itself
 * become an open-redirect vector, so we deliberately stay on Stellara.
 */
function sendAuthorizeError(reply: FastifyReply, message: string): void {
  void reply
    .code(400)
    .header("content-type", "text/html; charset=utf-8")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>OAuth error</title></head>` +
        `<body style="font-family: system-ui, sans-serif; padding: 2rem;">` +
        `<h1>OAuth error</h1><p>${escapeHtml(message)}</p></body></html>`,
    );
}

/** Arguments accepted by {@link redirectWithError}. */
type RedirectErrorArgs = {
  reply: FastifyReply;
  redirectUri: string;
  state: string;
  error: string;
  issuer: string;
};

/**
 * Redirects back to the client's redirect URI carrying the OAuth `error` +
 * `state` query parameters per RFC 6749 §4.1.2.1. Safe to use only when the
 * redirect URI has been validated against the client's registration.
 */
function redirectWithError(args: RedirectErrorArgs): void {
  const url = new URL(args.redirectUri);
  url.searchParams.set("error", args.error);
  url.searchParams.set("state", args.state);
  url.searchParams.set("iss", args.issuer);
  void args.reply.code(302).header("location", url.toString()).send();
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
  sendAuthorizeError(reply, "Unable to verify OAuth client");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
