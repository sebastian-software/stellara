/**
 * Route handler for `POST /tools/crawl/status` (concept §8.16).
 *
 * Polls the status of a Firecrawl crawl job started via
 * `/tools/crawl/start` (or the in_progress snapshot returned by
 * `/tools/crawl` once the soft cap fires). Returns the current page list
 * accumulated by Firecrawl so far.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { crawlStatusRequestSchema, crawlStatusResponseSchema } from "../schemas/web.js";
import { runWebCrawlStatus } from "../tools/web.js";

/** Registers `POST /tools/crawl/status` on the given Fastify instance. */
export function registerCrawlStatusRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/crawl/status",
    schema: {
      operationId: "web_crawl_status",
      tags: ["tools", "web"],
      summary: "Poll a Firecrawl crawl job by id",
      description: describeMcpTool("web_crawl_status"),
      security: [{ bearerAuth: [] }],
      body: crawlStatusRequestSchema,
      response: { 200: crawlStatusResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebCrawlStatus(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
