/**
 * Route handler for `POST /tools/browser/session/stop` (concept §8.20).
 *
 * Closes the named Playwright session for the calling user. Foreign or
 * unknown sessions surface as `NOT_FOUND` (see `PlaywrightClient`'s
 * `getOwnedSession` helper) so a caller cannot enumerate other users'
 * active sessions.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserSessionStopRequestSchema,
  browserSessionStopResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserSessionStop } from "../../tools/browser.js";

/** Registers `POST /tools/browser/session/stop`. */
export function registerBrowserSessionStopRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/session/stop",
    schema: {
      operationId: "browser_session_stop",
      tags: ["tools", "browser"],
      summary: "Close a Playwright session",
      description: describeMcpTool("browser_session_stop"),
      security: [{ bearerAuth: [] }],
      body: browserSessionStopRequestSchema,
      response: { 200: browserSessionStopResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserSessionStop(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
