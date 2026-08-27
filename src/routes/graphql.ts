/**
 * Route handler for `POST /tools/graphql` (concept §8.18, plan 0006).
 *
 * Thin wrapper around the generic `web_fetch` service that assembles the
 * canonical GraphQL POST body (`{ query, variables, operationName }`) and
 * surfaces `errors`-in-200-body responses 1:1. Per-route timeout from §17
 * (15 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { graphqlRequestSchema, graphqlResponseSchema } from "../schemas/web.js";
import { runWebGraphql } from "../tools/web.js";

/** Registers `POST /tools/graphql` on the given Fastify instance. */
export function registerGraphqlRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/graphql",
    schema: {
      operationId: "web_graphql",
      tags: ["tools", "web"],
      summary: "Issue a GraphQL operation against a public endpoint",
      description: describeMcpTool("web_graphql"),
      security: [{ bearerAuth: [] }],
      body: graphqlRequestSchema,
      response: { 200: graphqlResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebGraphql(app, request.body);
      // Audit-trail per plan 0006: log the endpoint host + path + status,
      // never the query, variables or upstream payload. Operation name (if
      // any) is safe because GraphQL clients use it as a non-secret label.
      const endpoint = new URL(request.body.endpoint);
      request.log.info(
        {
          tool: "web_graphql",
          host: endpoint.host,
          path: endpoint.pathname,
          status: result.status,
          operationName: request.body.operationName,
          hasErrors: result.errors !== undefined && result.errors.length > 0,
        },
        "web_graphql completed",
      );
      void reply.code(200).send(result);
    },
  });
}
