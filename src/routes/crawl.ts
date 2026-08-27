/**
 * Route handler for `POST /tools/crawl` (concept §8.3).
 *
 * Forwards the crawl request to {@link runWebCrawl} in `src/tools/` so REST
 * and MCP share a single implementation. Per-route timeout from §17 (60 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { crawlRequestSchema, crawlResponseSchema } from "../schemas/web.js";
import { runWebCrawl } from "../tools/web.js";

/** Registers `POST /tools/crawl` on the given Fastify instance. */
export function registerCrawlRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/crawl",
    schema: {
      operationId: "web_crawl",
      tags: ["tools", "web"],
      summary: "Crawl multiple pages via Firecrawl",
      description: describeMcpTool("web_crawl"),
      security: [{ bearerAuth: [] }],
      body: crawlRequestSchema,
      response: { 200: crawlResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebCrawl(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
