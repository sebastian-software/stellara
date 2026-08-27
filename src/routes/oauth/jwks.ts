/**
 * JWKS endpoint — exposes the public half of the active signing key.
 *
 * Standard OAuth clients fetch this URL (advertised in
 * `/.well-known/oauth-authorization-server` as `jwks_uri`) to verify access
 * tokens offline. Stellara serves a single-key set in v1; future key
 * rotation can extend the set without changing the response shape.
 *
 * Public endpoint, no bearer required. Hidden from OpenAPI.
 */
import type { FastifyInstance } from "fastify";

/** Registers `GET /oauth/jwks`. */
export function registerOAuthJwksRoute(app: FastifyInstance): void {
  app.route({
    method: "GET",
    url: "/oauth/jwks",
    schema: { hide: true },
    handler(_request, reply) {
      void reply
        .code(200)
        .header("cache-control", "public, max-age=3600")
        .send({ keys: [app.services.oauth.signingKey.publicJwk] });
    },
  });
}
