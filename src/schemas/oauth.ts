/**
 * Zod schemas for the OAuth 2.1 Authorization-Server surface (plan 0004,
 * concept §6.6).
 *
 * Shared by the wire-level validation in the OAuth route handlers (Pass B) and
 * by the library-internal helpers in `src/oauth/*`. Schemas live in this single
 * module so the on-the-wire contracts are documented in one place; runtime
 * helpers re-use the inferred TypeScript types rather than re-declaring shapes.
 *
 * Naming follows the RFC vocabulary: snake_case for fields that travel over
 * the OAuth wire (RFC 6749/7591/8414/9728), camelCase only where a value is
 * purely internal to Stellara.
 */
import { z } from "zod/v4";

import { isOAuthClientIdWithinLimit, MAX_OAUTH_CLIENT_ID_LENGTH } from "../oauth/client-id.js";

/** Shared wire-level bound applied before client IDs reach URL or cache logic. */
const oauthClientIdSchema = z
  .string()
  .min(1)
  .max(MAX_OAUTH_CLIENT_ID_LENGTH)
  .refine(isOAuthClientIdWithinLimit, { message: "client_id exceeds the safe byte limit" });

/**
 * MCP-Spec-conform code challenge method. OAuth 2.1 mandates PKCE-S256 for
 * public clients (RFC 7636 §4.2); the legacy `plain` method is intentionally
 * NOT accepted.
 */
export const codeChallengeMethodSchema = z.literal("S256");

/**
 * Allowed grant types accepted by `/oauth/token`. Authorization-code-grant
 * covers the initial exchange after the browser flow; refresh-token-grant
 * powers the rotation cycle once a client has a session.
 */
export const grantTypeSchema = z.enum(["authorization_code", "refresh_token"]);

/**
 * The single Stellara scope. Future versions may add granular scopes
 * (`tools:web`, `tools:memory`, …); v1 keeps everything under one umbrella so
 * MCP clients that ask for "all tools" do not have to know about the split.
 */
export const SCOPE = "mcp";

/**
 * Dynamic Client Registration request (RFC 7591 §2 — Client Metadata).
 *
 * Stellara accepts the minimum viable subset: a client name (free text, shown
 * in audit logs) plus the redirect URIs the client wants to bind to. Extra
 * fields the spec allows (`token_endpoint_auth_method`, `grant_types`, …) are
 * not honored — Stellara enforces a fixed policy (PKCE-only, public client,
 * authorization-code + refresh-token grants).
 */
export const clientRegistrationRequestSchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
});

/**
 * DCR success response (RFC 7591 §3.2.1). `client_id` is opaque and
 * persistent; Stellara never issues `client_secret` because all clients are
 * public per OAuth 2.1.
 */
export const clientRegistrationResponseSchema = z.object({
  client_id: z.string(),
  client_id_issued_at: z.number().int().positive(),
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.literal("authorization_code").or(z.literal("refresh_token"))),
  response_types: z.array(z.literal("code")),
});

/**
 * `/oauth/authorize` query parameters (RFC 6749 §4.1.1 + RFC 7636 §4.3).
 *
 * `state` is required so the client can correlate the redirect with the
 * original request — Stellara also leans on it as the implicit CSRF token for
 * the login form submit. `code_challenge` + `code_challenge_method` carry the
 * PKCE binding.
 */
export const authorizeQuerySchema = z.object({
  response_type: z.literal("code"),
  client_id: oauthClientIdSchema,
  redirect_uri: z.string().url(),
  scope: z.string().min(1),
  state: z.string().min(1).max(512),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: codeChallengeMethodSchema,
  resource: z.string().url().optional(),
});

/**
 * Form body submitted by the login page (`POST /oauth/login`). Echoes every
 * authorize-query field so the handler can resume the flow after credential
 * verification.
 */
export const loginFormSchema = authorizeQuerySchema.extend({
  token: z.string().min(1),
});

/**
 * Authorization-code-grant token request (RFC 6749 §4.1.3 + RFC 7636 §4.5).
 */
export const tokenRequestAuthCodeSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  client_id: oauthClientIdSchema,
  code_verifier: z.string().min(43).max(128),
  resource: z.string().url().optional(),
});

/**
 * Refresh-token-grant token request (RFC 6749 §6).
 */
export const tokenRequestRefreshSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
  client_id: oauthClientIdSchema,
  scope: z.string().optional(),
  resource: z.string().url().optional(),
});

/**
 * Discriminated union accepted by `/oauth/token`. Fastify's Zod compiler picks
 * the correct branch based on the `grant_type` discriminator before the
 * handler runs.
 */
export const tokenRequestSchema = z.discriminatedUnion("grant_type", [
  tokenRequestAuthCodeSchema,
  tokenRequestRefreshSchema,
]);

/**
 * Token endpoint success response (RFC 6749 §5.1).
 */
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});

/**
 * JSON Web Key Set (RFC 7517 §5). Stellara exposes only its current signing
 * key's public half; the private key never leaves the server.
 */
export const jwksResponseSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

/**
 * Authorization-server metadata (RFC 8414). The fields below are the subset
 * MCP clients actually consume; optional fields the RFC allows (e.g.
 * `service_documentation`, `ui_locales_supported`) are omitted on purpose.
 */
export const authorizationServerMetadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  response_types_supported: z.array(z.literal("code")),
  grant_types_supported: z.array(z.literal("authorization_code").or(z.literal("refresh_token"))),
  code_challenge_methods_supported: z.array(codeChallengeMethodSchema),
  token_endpoint_auth_methods_supported: z.array(z.literal("none")),
  scopes_supported: z.array(z.string()),
  resource_indicators_supported: z.literal(true),
  authorization_response_iss_parameter_supported: z.literal(true),
  client_id_metadata_document_supported: z.literal(true),
});

/**
 * Protected-resource metadata (RFC 9728). Points MCP clients at the
 * authorization server they need to talk to in order to obtain a token for
 * the `/mcp` resource.
 */
export const protectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
  bearer_methods_supported: z.array(z.literal("header")),
  scopes_supported: z.array(z.string()),
});

/**
 * RFC-6749-conform error response envelope used by `/oauth/token`,
 * `/oauth/authorize` (when redirecting) and `/oauth/register`.
 */
export const oauthErrorResponseSchema = z.object({
  error: z.enum([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_target",
    "server_error",
    "temporarily_unavailable",
    "invalid_redirect_uri",
    "invalid_client_metadata",
  ]),
  error_description: z.string().optional(),
});

/** Inferred TypeScript types for ergonomic use in library code. */
export type ClientRegistrationRequest = z.infer<typeof clientRegistrationRequestSchema>;
export type ClientRegistrationResponse = z.infer<typeof clientRegistrationResponseSchema>;
export type AuthorizeQuery = z.infer<typeof authorizeQuerySchema>;
export type LoginForm = z.infer<typeof loginFormSchema>;
export type TokenRequestAuthCode = z.infer<typeof tokenRequestAuthCodeSchema>;
export type TokenRequestRefresh = z.infer<typeof tokenRequestRefreshSchema>;
export type TokenRequest = z.infer<typeof tokenRequestSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type JwksResponse = z.infer<typeof jwksResponseSchema>;
export type AuthorizationServerMetadata = z.infer<typeof authorizationServerMetadataSchema>;
export type ProtectedResourceMetadata = z.infer<typeof protectedResourceMetadataSchema>;
export type OAuthErrorResponse = z.infer<typeof oauthErrorResponseSchema>;
