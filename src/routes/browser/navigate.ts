/**
 * Route handler for `POST /tools/browser/navigate` (concept §8.21).
 *
 * Drives the active page of an existing Playwright session to a new URL.
 * The SSRF guard from `safeExternalUrl` applies to the supplied URL, same
 * as for `web_scrape` and the other outbound tools (§17.1).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserNavigateRequestSchema,
  browserNavigateResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserNavigate } from "../../tools/browser.js";

/** Registers `POST /tools/browser/navigate`. */
export function registerBrowserNavigateRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/navigate",
    schema: {
      operationId: "browser_navigate",
      tags: ["tools", "browser"],
      summary: "Navigate the active page of a Playwright session",
      description: describeMcpTool("browser_navigate"),
      security: [{ bearerAuth: [] }],
      body: browserNavigateRequestSchema,
      response: { 200: browserNavigateResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserNavigate(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
