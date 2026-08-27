/**
 * Route handler for `POST /tools/research` (concept §8.4).
 *
 * Delegates the actual orchestration (Exa search followed by parallel
 * Firecrawl scrapes within a soft budget) to {@link runWebResearch} in
 * `src/tools/` so REST and MCP share a single implementation. The hard cap is
 * the per-route timeout from §17 (60 s); inside that the request carries a
 * soft `timeBudgetMs` (default 45 s) which bounds the time spent scraping
 * sources. When the soft cap expires already-completed scrapes are returned
 * and pending ones are aborted; failed/timed-out sources keep their snippet
 * but omit `content` (§8.4).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { researchRequestSchema, researchResponseSchema } from "../schemas/web.js";
import { runWebResearch } from "../tools/web.js";

/** Registers `POST /tools/research` on the given Fastify instance. */
export function registerResearchRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/research",
    schema: {
      operationId: "web_research",
      tags: ["tools", "web"],
      summary: "Combined Exa search + Firecrawl scrape pipeline",
      description: describeMcpTool("web_research"),
      security: [{ bearerAuth: [] }],
      body: researchRequestSchema,
      response: { 200: researchResponseSchema },
    },
    async handler(request, reply) {
      const body = await runWebResearch(app, request.body);
      void reply.code(200).send(body);
    },
  });
}
