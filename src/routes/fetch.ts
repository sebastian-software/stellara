/**
 * Route handler for `POST /tools/fetch` (concept §8.17, plan 0006).
 *
 * Generic HTTP-fetch tool: lets callers issue an authenticated request
 * against an external endpoint and receive the response decoded according
 * to their preferred format. SSRF, header sanitization and the body cap
 * live in the shared `runHttpFetch` service so REST and MCP share the
 * same security policy. Per-route timeout from §17 (15 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { fetchRequestSchema, fetchResponseSchema } from "../schemas/web.js";
import { runWebFetch } from "../tools/web.js";

/** Registers `POST /tools/fetch` on the given Fastify instance. */
export function registerFetchRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/fetch",
    schema: {
      operationId: "web_fetch",
      tags: ["tools", "web"],
      summary: "Issue a generic HTTP request against a public endpoint",
      description: describeMcpTool("web_fetch"),
      security: [{ bearerAuth: [] }],
      body: fetchRequestSchema,
      response: { 200: fetchResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebFetch(app, request.body);
      // Audit-trail per plan 0006 / concept §8.17: never log headers or
      // body — they may carry `Authorization` or other secrets. Host +
      // pathname + final status are enough to correlate calls in Pino.
      const finalUrl = new URL(result.url);
      request.log.info(
        {
          tool: "web_fetch",
          method: request.body.method,
          host: finalUrl.host,
          path: finalUrl.pathname,
          status: result.status,
          truncated: result.truncated,
        },
        "web_fetch completed",
      );
      void reply.code(200).send(result);
    },
  });
}
