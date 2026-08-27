/**
 * Route handler for `POST /tools/get` (concept §8.31, plan 0014).
 *
 * Read-only sibling of `web_fetch`: restricted to the HTTP safe methods
 * (`GET`, `HEAD`, `OPTIONS`) and rejecting any request body at the schema
 * level, so the MCP tool can honestly declare `readOnlyHint: true`. SSRF,
 * header sanitization and the body cap live in the shared `runHttpFetch`
 * service, identical to `web_fetch`. Per-route timeout from §17 (15 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { fetchResponseSchema, getRequestSchema } from "../schemas/web.js";
import { runWebGet } from "../tools/web.js";

/** Registers `POST /tools/get` on the given Fastify instance. */
export function registerGetRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/get",
    schema: {
      operationId: "web_get",
      tags: ["tools", "web"],
      summary: "Issue a read-only HTTP request (GET/HEAD/OPTIONS) against a public endpoint",
      description: describeMcpTool("web_get"),
      security: [{ bearerAuth: [] }],
      body: getRequestSchema,
      response: { 200: fetchResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebGet(app, request.body);
      // Audit-trail per plan 0014 / concept §8.31: never log headers or
      // body — they may carry `Authorization` or other secrets. Host +
      // pathname + final status are enough to correlate calls in Pino.
      const finalUrl = new URL(result.url);
      request.log.info(
        {
          tool: "web_get",
          method: request.body.method,
          host: finalUrl.host,
          path: finalUrl.pathname,
          status: result.status,
          truncated: result.truncated,
        },
        "web_get completed",
      );
      void reply.code(200).send(result);
    },
  });
}
