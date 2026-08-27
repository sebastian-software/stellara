/**
 * Route handler for `POST /tools/search` (concept §8.1).
 *
 * Validates the body with {@link searchRequestSchema} and delegates the actual
 * upstream call to {@link runWebSearch} in `src/tools/` so REST and MCP share
 * a single implementation. Auth + rate-limit + error handling come from the
 * Fastify plumbing in `src/server.ts`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { searchRequestSchema, searchResponseSchema } from "../schemas/web.js";
import { runWebSearch } from "../tools/web.js";

/** Registers `POST /tools/search` on the given Fastify instance. */
export function registerSearchRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/search",
    schema: {
      operationId: "web_search",
      tags: ["tools", "web"],
      summary: "Semantic web search via Exa",
      description: describeMcpTool("web_search"),
      security: [{ bearerAuth: [] }],
      body: searchRequestSchema,
      response: { 200: searchResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebSearch(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
