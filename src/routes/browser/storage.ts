/**
 * Route handler for `POST /tools/browser/storage` (concept §8.28, plan 0010).
 *
 * Read or write the active page's `localStorage` / `sessionStorage` via
 * `page.evaluate`. Discriminated union over `mode: get|set|clear` and
 * `target: local|session`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserStorageRequestSchema,
  browserStorageResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserStorage } from "../../tools/browser.js";

/** Registers `POST /tools/browser/storage`. */
export function registerBrowserStorageRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/storage",
    schema: {
      operationId: "browser_storage",
      tags: ["tools", "browser"],
      summary: "Read or write Web Storage on the active Playwright page",
      description: describeMcpTool("browser_storage"),
      security: [{ bearerAuth: [] }],
      body: browserStorageRequestSchema,
      response: { 200: browserStorageResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserStorage(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
