/**
 * Route handler for `POST /tools/browser/eval` (concept §8.25, plan 0010).
 *
 * Runs a caller-supplied JavaScript expression inside the page's V8
 * context. The 1 MB JSON-output cap and 30 s timeout from §17 are the
 * hard guard-rails — the security model assumes the bearer token already
 * grants full browser-tool access.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import { browserEvalRequestSchema, browserEvalResponseSchema } from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserEval } from "../../tools/browser.js";

/** Registers `POST /tools/browser/eval`. */
export function registerBrowserEvalRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/eval",
    schema: {
      operationId: "browser_eval",
      tags: ["tools", "browser"],
      summary: "Evaluate a JavaScript expression in the page's V8 context",
      description: describeMcpTool("browser_eval"),
      security: [{ bearerAuth: [] }],
      body: browserEvalRequestSchema,
      response: { 200: browserEvalResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserEval(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
