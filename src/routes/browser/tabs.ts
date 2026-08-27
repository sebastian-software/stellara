/**
 * Route handler for `POST /tools/browser/tabs` (concept §8.30, plan 0010).
 *
 * Discriminated union over `mode: list|switch|close|new`. Closing the
 * last tab is rejected (`cannot_close_last_tab`) — `browser_session_stop`
 * is the right tool for that. New tabs are capped at five per session.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import { browserTabsRequestSchema, browserTabsResponseSchema } from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserTabs } from "../../tools/browser.js";

/** Registers `POST /tools/browser/tabs`. */
export function registerBrowserTabsRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/tabs",
    schema: {
      operationId: "browser_tabs",
      tags: ["tools", "browser"],
      summary: "List, switch, close or open tabs within a Playwright session",
      description: describeMcpTool("browser_tabs"),
      security: [{ bearerAuth: [] }],
      body: browserTabsRequestSchema,
      response: { 200: browserTabsResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserTabs(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
