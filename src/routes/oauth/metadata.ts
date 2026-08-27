/**
 * OAuth discovery endpoints (plan 0004 §6.6, RFC 8414 + RFC 9728).
 *
 * `/.well-known/oauth-authorization-server` advertises the authorization
 * server's endpoint URLs and supported features so MCP clients (Claude
 * Desktop, ChatGPT Connectors, …) can wire up the flow without hard-coded
 * URLs. `/.well-known/oauth-protected-resource` does the same for the
 * resource server side — it points clients at the authorization server they
 * need to talk to in order to obtain a token for `/mcp`.
 *
 * Both endpoints are public (no bearer required) — see `PUBLIC_PATHS` in
 * `src/auth.ts`. Responses are static for a given `Config.publicBaseUrl`
 * and are hidden from the OpenAPI spec.
 */
import type { FastifyInstance } from "fastify";

import { SCOPE } from "../../schemas/oauth.js";

/** Registers both `.well-known` discovery endpoints. */
export function registerOAuthMetadataRoutes(app: FastifyInstance): void {
  const baseUrl = app.config.publicBaseUrl;

  app.route({
    method: "GET",
    url: "/.well-known/oauth-authorization-server",
    schema: { hide: true },
    handler(_request, reply) {
      void reply
        .code(200)
        .header("cache-control", "public, max-age=3600")
        .send({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/oauth/authorize`,
          token_endpoint: `${baseUrl}/oauth/token`,
          registration_endpoint: `${baseUrl}/oauth/register`,
          jwks_uri: `${baseUrl}/oauth/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [SCOPE],
          resource_indicators_supported: true,
          authorization_response_iss_parameter_supported: true,
          client_id_metadata_document_supported: true,
        });
    },
  });

  for (const url of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])
    app.route({
      method: "GET",
      url,
      schema: { hide: true },
      handler(_request, reply) {
        void reply
          .code(200)
          .header("cache-control", "public, max-age=3600")
          .send({
            resource: `${baseUrl}/mcp`,
            authorization_servers: [baseUrl],
            bearer_methods_supported: ["header"],
            scopes_supported: [SCOPE],
          });
      },
    });
}
