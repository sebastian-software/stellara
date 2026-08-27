/**
 * Route handler for `POST /tools/scrape` (concept §8.2).
 *
 * Delegates the actual scrape to {@link runWebScrape} in `src/tools/` so REST
 * and MCP share a single implementation. Per-route timeout from §17 (30 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { scrapeRequestSchema, scrapeResponseSchema } from "../schemas/web.js";
import { runWebScrape } from "../tools/web.js";

/** Registers `POST /tools/scrape` on the given Fastify instance. */
export function registerScrapeRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/scrape",
    schema: {
      operationId: "web_scrape",
      tags: ["tools", "web"],
      summary: "Scrape a single URL via Firecrawl",
      description: describeMcpTool("web_scrape"),
      security: [{ bearerAuth: [] }],
      body: scrapeRequestSchema,
      response: { 200: scrapeResponseSchema },
    },
    async handler(request, reply) {
      const page = await runWebScrape(app, request.body);
      void reply.code(200).send(page);
    },
  });
}
