/**
 * Route handler for `POST /tools/graphql-query` (concept §8.32, plan 0014).
 *
 * Read-only sibling of `web_graphql`: parses the `query` string server-side
 * and rejects any document that carries a `mutation`/`subscription`
 * operation with `BAD_REQUEST`, so the MCP tool can honestly declare
 * `readOnlyHint: true`. Beyond that guard it reuses the exact `web_graphql`
 * path (canonical `{ query, variables, operationName }` body, `errors`-in-
 * 200-body passthrough). Per-route timeout from §17 (15 s).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { describeMcpTool } from "../schemas/mcp.js";
import { graphqlQueryRequestSchema, graphqlResponseSchema } from "../schemas/web.js";
import { runWebGraphqlQuery } from "../tools/web.js";

/** Registers `POST /tools/graphql-query` on the given Fastify instance. */
export function registerGraphqlQueryRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/graphql-query",
    schema: {
      operationId: "web_graphql_query",
      tags: ["tools", "web"],
      summary: "Issue a read-only GraphQL query against a public endpoint",
      description: describeMcpTool("web_graphql_query"),
      security: [{ bearerAuth: [] }],
      body: graphqlQueryRequestSchema,
      response: { 200: graphqlResponseSchema },
    },
    async handler(request, reply) {
      const result = await runWebGraphqlQuery(app, request.body);
      // Audit-trail per plan 0014: log the endpoint host + path + status,
      // never the query, variables or upstream payload. Operation name (if
      // any) is safe because GraphQL clients use it as a non-secret label.
      const endpoint = new URL(request.body.endpoint);
      request.log.info(
        {
          tool: "web_graphql_query",
          host: endpoint.host,
          path: endpoint.pathname,
          status: result.status,
          operationName: request.body.operationName,
          hasErrors: result.errors !== undefined && result.errors.length > 0,
        },
        "web_graphql_query completed",
      );
      void reply.code(200).send(result);
    },
  });
}
