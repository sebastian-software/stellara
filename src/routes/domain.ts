/**
 * Route handler for `POST /tools/domain/availability` (plan 0013).
 *
 * The route is the thin REST surface around the orchestration in
 * {@link runDomainAvailability}. Audit logging mirrors the privacy-careful
 * style of `/tools/fetch`: only the normalised domain, TLD, verdict status
 * and lookup source are logged — never the raw upstream response body.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  domainAvailabilityRequestSchema,
  domainAvailabilityResponseSchema,
} from "../schemas/domain.js";
import { describeMcpTool } from "../schemas/mcp.js";
import { runDomainAvailability } from "../tools/domain.js";

/** Registers `POST /tools/domain/availability` on the given Fastify instance. */
export function registerDomainAvailabilityRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "POST",
    url: "/tools/domain/availability",
    schema: {
      operationId: "domain_availability",
      tags: ["tools", "domain"],
      summary: "Check whether a domain is registered or available",
      description: describeMcpTool("domain_availability"),
      security: [{ bearerAuth: [] }],
      body: domainAvailabilityRequestSchema,
      response: { 200: domainAvailabilityResponseSchema },
    },
    async handler(request, reply) {
      const result = await runDomainAvailability(app, request.body);
      request.log.info(
        {
          tool: "domain_availability",
          domain: result.domain,
          tld: result.tld,
          status: result.status,
          source: result.source,
        },
        "domain_availability completed",
      );
      void reply.code(200).send(result);
    },
  });
}
