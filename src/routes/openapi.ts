/**
 * `@fastify/swagger` registration plus `GET /openapi.json` per concept §20.
 *
 * The Zod-based transform from `fastify-type-provider-zod` converts Zod
 * schemas attached to each route into the OpenAPI 3.1 document. The spec
 * is built once on demand and memoized by `app.swagger()`; subsequent
 * requests to `/openapi.json` reuse the cached object.
 */
import type { FastifyInstance } from "fastify";

import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { STELLARA_SUITE_OVERVIEW } from "../llm-instructions.js";

/**
 * Wires the Zod validator + serializer compilers, registers
 * `@fastify/swagger` in dynamic mode, and exposes the public
 * `GET /openapi.json` endpoint.
 *
 * Must be registered before any route whose schema should appear in the
 * generated spec (see `src/server.ts`).
 */
export async function registerOpenApiPlugin(app: FastifyInstance): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  let openApiServerUrl = app.config.publicBaseUrl;
  while (openApiServerUrl.endsWith("/")) {
    openApiServerUrl = openApiServerUrl.slice(0, -1);
  }

  await app.register(fastifySwagger, {
    mode: "dynamic",
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Stellara",
        version: app.config.appVersion,
        // Mirror the MCP `instructions` text so Custom-GPT Actions and
        // Swagger UI consumers see the same tool-selection guidance as
        // MCP clients (plan 0011).
        description: STELLARA_SUITE_OVERVIEW,
      },
      servers: [{ url: openApiServerUrl, description: "Public API" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      // Empty global security keeps public endpoints (/health, /ready,
      // /openapi.json) unsecured by default; /tools/* routes opt in via
      // their own `security: [{ bearerAuth: [] }]` in Schritte 4+5.
      security: [],
    },
    transform: jsonSchemaTransform,
  });

  app.route({
    method: "GET",
    url: "/openapi.json",
    // Hidden from the spec itself to keep `paths` focused on the tool
    // surface — the OpenAPI document does not need to document its own
    // delivery endpoint.
    schema: { hide: true },
    handler(_request, reply) {
      const spec = app.swagger();
      void reply.code(200).type("application/json").send(spec);
    },
  });
}
