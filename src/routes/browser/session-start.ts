/**
 * Route handler for `POST /tools/browser/session/start` (concept §8.19).
 *
 * Opens a new Playwright session anchored on the supplied URL and returns
 * the freshly minted `sessionId` plus the initial page metadata. Delegates
 * to {@link runBrowserSessionStart} so REST and MCP share a single
 * implementation. Per-route timeout from §17 (60 s — covers Chromium
 * launch + initial navigation in the worst case).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserSessionStartRequestSchema,
  browserSessionStartResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserSessionStart } from "../../tools/browser.js";

/** Registers `POST /tools/browser/session/start`. */
export function registerBrowserSessionStartRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/session/start",
    schema: {
      operationId: "browser_session_start",
      tags: ["tools", "browser"],
      summary: "Open a Playwright session anchored on a URL",
      description: describeMcpTool("browser_session_start"),
      security: [{ bearerAuth: [] }],
      body: browserSessionStartRequestSchema,
      response: { 200: browserSessionStartResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserSessionStart(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
