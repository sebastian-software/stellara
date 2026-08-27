/**
 * Route handler for `POST /tools/browser/interact` (concept §8.22).
 *
 * Executes an ordered action chain (click/type/wait/…) against the active
 * page of a Playwright session. Stellara owns the action vocabulary via
 * the discriminated union in `src/schemas/browser.ts`, so unknown action
 * types surface as 422 here instead of as runtime exceptions in the
 * dispatcher.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import {
  browserInteractRequestSchema,
  browserInteractResponseSchema,
} from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserInteract } from "../../tools/browser.js";

/** Registers `POST /tools/browser/interact`. */
export function registerBrowserInteractRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/interact",
    schema: {
      operationId: "browser_interact",
      tags: ["tools", "browser"],
      summary: "Run a chain of browser actions inside a Playwright session",
      description: describeMcpTool("browser_interact"),
      security: [{ bearerAuth: [] }],
      body: browserInteractRequestSchema,
      response: { 200: browserInteractResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserInteract(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
