/**
 * Route handler for `POST /tools/extract` (concept §8.11).
 *
 * Schema- or prompt-driven structured extraction across one or more URLs.
 * Firecrawl owns the result shape (caller-defined or LLM-generated); Stellara
 * passes the response through 1:1 under `data`. Per-route timeout from §17
 * (90 s) accommodates the LLM-roundtrip.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { extractRequestSchema, extractResponseSchema } from "../schemas/web.js";
import { runWebExtract } from "../tools/web.js";

/** Registers `POST /tools/extract` on the given Fastify instance. */
export function registerExtractRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/extract",
    schema: {
      operationId: "web_extract",
      tags: ["tools", "web"],
      summary: "Extract structured data from one or more URLs via Firecrawl",
      description: describeMcpTool("web_extract"),
      security: [{ bearerAuth: [] }],
      body: extractRequestSchema,
      response: { 200: extractResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebExtract(app, request.body);
      void reply.code(200).send(result);
    },
  });
}
