/**
 * Route handler for `POST /tools/browser/content` (concept §8.24).
 *
 * Returns the current DOM of the active page either as raw HTML (default)
 * or as extracted plain text (`page.innerText("body")`). The 10 MB output
 * cap from the service layer applies here too — large pages are rejected
 * with 502 `output_too_large` rather than truncated, because silent
 * truncation would yield malformed HTML for downstream parsers.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserContentRequestSchema,
  browserContentResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserContent } from "../../tools/browser.js";

/** Registers `POST /tools/browser/content`. */
export function registerBrowserContentRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/content",
    schema: {
      operationId: "browser_content",
      tags: ["tools", "browser"],
      summary: "Read the active page's DOM (HTML or text)",
      description: describeMcpTool("browser_content"),
      security: [{ bearerAuth: [] }],
      body: browserContentRequestSchema,
      response: { 200: browserContentResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserContent(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
