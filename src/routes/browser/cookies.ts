/**
 * Route handler for `POST /tools/browser/cookies` (concept §8.27, plan 0010).
 *
 * Discriminated union over `mode: get|set|clear`. Cookies are
 * context-scoped — clearing affects every tab in the session.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserCookiesRequestSchema,
  browserCookiesResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserCookies } from "../../tools/browser.js";

/** Registers `POST /tools/browser/cookies`. */
export function registerBrowserCookiesRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/cookies",
    schema: {
      operationId: "browser_cookies",
      tags: ["tools", "browser"],
      summary: "Read or write cookies on a Playwright session context",
      description: describeMcpTool("browser_cookies"),
      security: [{ bearerAuth: [] }],
      body: browserCookiesRequestSchema,
      response: { 200: browserCookiesResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserCookies(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
