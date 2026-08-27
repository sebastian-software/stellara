/**
 * Route handler for `POST /tools/browser/har` (concept §8.29, plan 0010).
 *
 * Toggles the in-memory HAR recorder. **Privacy warning:** captured
 * request/response headers include `Authorization` and `Cookie` values
 * verbatim — see §8.29 for the rationale. Callers control whether a HAR
 * is ever started.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import { browserHarRequestSchema, browserHarResponseSchema } from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserHar } from "../../tools/browser.js";

/** Registers `POST /tools/browser/har`. */
export function registerBrowserHarRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/har",
    schema: {
      operationId: "browser_har",
      tags: ["tools", "browser"],
      summary: "Start or stop the session's HAR recorder",
      description: describeMcpTool("browser_har"),
      security: [{ bearerAuth: [] }],
      body: browserHarRequestSchema,
      response: { 200: browserHarResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserHar(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
