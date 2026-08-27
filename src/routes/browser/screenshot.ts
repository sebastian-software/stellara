/**
 * Route handler for `POST /tools/browser/screenshot` (concept §8.23).
 *
 * Returns a PNG snapshot of the active page or a selected element. The
 * service layer caps the response at the global Playwright output limit
 * (10 MB); larger captures surface as 502 with `details.reason:
 * "output_too_large"` rather than streaming an unbounded blob.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserScreenshotRequestSchema,
  browserScreenshotResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserScreenshot } from "../../tools/browser.js";

/** Registers `POST /tools/browser/screenshot`. */
export function registerBrowserScreenshotRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/screenshot",
    schema: {
      operationId: "browser_screenshot",
      tags: ["tools", "browser"],
      summary: "Capture a PNG screenshot from a Playwright session",
      description: describeMcpTool("browser_screenshot"),
      security: [{ bearerAuth: [] }],
      body: browserScreenshotRequestSchema,
      response: { 200: browserScreenshotResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserScreenshot(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
