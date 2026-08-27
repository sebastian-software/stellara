/**
 * Registers every OAuth route in one go (plan 0004 §6.6). Server bootstrap
 * calls this after the OAuth services are decorated onto the Fastify
 * instance but before any tool route, so the discovery endpoints and the
 * flow handlers are reachable for unauthenticated MCP clients.
 */
import type { FastifyInstance } from "fastify";

import { registerOAuthAuthorizeRoute } from "./authorize.js";
import { registerOAuthJwksRoute } from "./jwks.js";
import { registerOAuthLoginRoute } from "./login.js";
import { registerOAuthMetadataRoutes } from "./metadata.js";
import { registerOAuthRegisterRoute } from "./register.js";
import { registerOAuthTokenRoute } from "./token.js";

/** Registers every `/oauth/*` and `/.well-known/oauth-*` route. */
export function registerOAuthRoutes(app: FastifyInstance): void {
  registerOAuthMetadataRoutes(app);
  registerOAuthJwksRoute(app);
  registerOAuthRegisterRoute(app);
  registerOAuthAuthorizeRoute(app);
  registerOAuthLoginRoute(app);
  registerOAuthTokenRoute(app);
}
