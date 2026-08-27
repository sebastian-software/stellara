/**
 * Dynamic Client Registration endpoint (plan 0004 §6.6, RFC 7591).
 *
 * MCP clients POST a minimal JSON body (`client_name` + `redirect_uris`)
 * and receive a `client_id` plus the canonical metadata block describing
 * Stellara's policy (`token_endpoint_auth_method: "none"`, etc.).
 *
 * Per-IP rate-limit is enforced by the registrar (`src/oauth/clients.ts`)
 * before the SQLite insert lands, so a registration flood does not hit the
 * disk. Audit logging records `client_id`, `client_name`, `ip` and the
 * outcome — never the redirect URIs in raw form (only counts) to keep logs
 * scannable; the URIs are recoverable from SQLite when needed.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AppError, ErrorCode, toErrorResponse } from "../../errors.js";
import { hashClientId } from "../../oauth/resource.js";
import { clientRegistrationRequestSchema } from "../../schemas/oauth.js";

/** Registers `POST /oauth/register`. */
export function registerOAuthRegisterRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { storage, registrar } = app.services.oauth;

  typed.route({
    method: "POST",
    url: "/oauth/register",
    schema: {
      hide: true,
      body: clientRegistrationRequestSchema,
    },
    handler(request, reply) {
      const outcome = registrar.registerClient(storage, request.body, request.ip);
      if (outcome.kind === "invalid_redirect_uri") {
        const error = new AppError({
          code: ErrorCode.VALIDATION_ERROR,
          message: outcome.reason,
        });
        void reply.code(400).send(toErrorResponse(error));
        return;
      }
      if (outcome.kind === "rate_limited") {
        const error = new AppError({
          code: ErrorCode.RATE_LIMITED,
          message: "Too many client registrations from this IP",
          details: { retryAfterSeconds: outcome.retryAfterSeconds },
        });
        void reply
          .code(429)
          .header("retry-after", String(outcome.retryAfterSeconds))
          .send(toErrorResponse(error));
        return;
      }
      request.log.info(
        {
          event: "oauth_client_registered",
          clientIdHash: hashClientId(outcome.response.client_id),
          clientName: outcome.response.client_name,
          redirectUriCount: outcome.response.redirect_uris.length,
          ip: request.ip,
        },
        "oauth client registered",
      );
      void reply.code(201).send(outcome.response);
    },
  });
}
