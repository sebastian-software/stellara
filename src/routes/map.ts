/**
 * Route handler for `POST /tools/map` (concept §8.10).
 *
 * Discovers the URL set Firecrawl can find for the supplied start URL.
 * Useful as a planning step before issuing a targeted crawl. Per-route
 * timeout from §17 (60 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { mapRequestSchema, mapResponseSchema } from "../schemas/web.js";
import { runWebMap } from "../tools/web.js";

/** Registers `POST /tools/map` on the given Fastify instance. */
export function registerMapRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/map",
    schema: {
      operationId: "web_map",
      tags: ["tools", "web"],
      summary: "Discover URLs reachable from a start URL via Firecrawl",
      description: describeMcpTool("web_map"),
      security: [{ bearerAuth: [] }],
      body: mapRequestSchema,
      response: { 200: mapResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebMap(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
