/**
 * Route handler for `POST /tools/browser/pdf` (concept §8.26, plan 0010).
 *
 * Returns a PDF render of the active page as Base64. Output capped at
 * 10 MB by the service layer.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../../auth.js";
import { browserPdfRequestSchema, browserPdfResponseSchema } from "../../schemas/browser.js";
import { describeMcpTool } from "../../schemas/mcp.js";
import { runBrowserPdf } from "../../tools/browser.js";

/** Registers `POST /tools/browser/pdf`. */
export function registerBrowserPdfRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/browser/pdf",
    schema: {
      operationId: "browser_pdf",
      tags: ["tools", "browser"],
      summary: "Render the active page as a PDF",
      description: describeMcpTool("browser_pdf"),
      security: [{ bearerAuth: [] }],
      body: browserPdfRequestSchema,
      response: { 200: browserPdfResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runBrowserPdf(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}
