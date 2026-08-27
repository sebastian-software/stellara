/**
 * Route handler for `POST /tools/crawl/start` (concept §8.15).
 *
 * Starts an asynchronous Firecrawl crawl job and returns the `jobId` so the
 * caller can poll status via `/tools/crawl/status`. Useful for large sites
 * that would not fit inside the synchronous `/tools/crawl` budget (60 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { crawlStartRequestSchema, crawlStartResponseSchema } from "../schemas/web.js";
import { runWebCrawlStart } from "../tools/web.js";

/** Registers `POST /tools/crawl/start` on the given Fastify instance. */
export function registerCrawlStartRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/crawl/start",
    schema: {
      operationId: "web_crawl_start",
      tags: ["tools", "web"],
      summary: "Start an asynchronous Firecrawl crawl job",
      description: describeMcpTool("web_crawl_start"),
      security: [{ bearerAuth: [] }],
      body: crawlStartRequestSchema,
      response: { 200: crawlStartResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebCrawlStart(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
