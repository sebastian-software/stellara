/**
 * Routes for the per-user memory tools (`upsert`, `search`, `list`, `delete`)
 * per concept §8.5–§8.8.
 *
 * Every read/update/delete is implicitly scoped to the authenticated user via
 * `app.services.qdrant`, which appends a `userId = <caller>` filter (§8.9).
 * The route handler grabs `request.userId` from the auth hook — public/auth
 * failures are short-circuited upstream and never reach these handlers.
 *
 * The orchestration itself lives in `src/tools/memory.ts` so REST and MCP
 * share a single implementation.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { requireUserId } from "../auth.js";
import { MEMORY_UPSERT_BODY_LIMIT } from "../limits.js";
import { describeMcpTool } from "../schemas/mcp.js";
import {
  memoryDeleteRequestSchema,
  memoryDeleteResponseSchema,
  memoryListRequestSchema,
  memoryListResponseSchema,
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  memoryUpsertRequestSchema,
  memoryUpsertResponseSchema,
} from "../schemas/memory.js";
import {
  runMemoryDelete,
  runMemoryList,
  runMemorySearch,
  runMemoryUpsert,
} from "../tools/memory.js";

/** Registers `POST /tools/memory/upsert`. */
function registerUpsertRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/memory/upsert",
    bodyLimit: MEMORY_UPSERT_BODY_LIMIT,
    schema: {
      operationId: "memory_upsert",
      tags: ["tools", "memory"],
      summary: "Insert or replace a memory point for the calling user",
      description: describeMcpTool("memory_upsert"),
      security: [{ bearerAuth: [] }],
      body: memoryUpsertRequestSchema,
      response: { 200: memoryUpsertResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runMemoryUpsert(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}

/** Registers `POST /tools/memory/search`. */
function registerSearchRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/memory/search",
    schema: {
      operationId: "memory_search",
      tags: ["tools", "memory"],
      summary: "Vector-search the calling user's memory points",
      description: describeMcpTool("memory_search"),
      security: [{ bearerAuth: [] }],
      body: memorySearchRequestSchema,
      response: { 200: memorySearchResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runMemorySearch(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}

/** Registers `POST /tools/memory/list`. */
function registerListRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/memory/list",
    schema: {
      operationId: "memory_list",
      tags: ["tools", "memory"],
      summary: "List the calling user's memory points with cursor pagination",
      description: describeMcpTool("memory_list"),
      security: [{ bearerAuth: [] }],
      body: memoryListRequestSchema,
      response: { 200: memoryListResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      const result = await runMemoryList(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}

/** Registers `POST /tools/memory/delete`. */
function registerDeleteRoute(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/tools/memory/delete",
    schema: {
      operationId: "memory_delete",
      tags: ["tools", "memory"],
      summary: "Delete memory points by id or filter (XOR)",
      description: describeMcpTool("memory_delete"),
      security: [{ bearerAuth: [] }],
      body: memoryDeleteRequestSchema,
      response: { 200: memoryDeleteResponseSchema },
    },
    async handler(request, reply) {
      const userId = requireUserId(request);
      // The discriminated union narrows `body` to exactly one variant; the
      // shared tool layer accepts the broader runtime shape and narrows
      // defensively at runtime.
      const result = await runMemoryDelete(app, userId, request.body);
      void reply.code(200).send(result);
    },
  });
}

/** Registers all four memory routes on the given Fastify instance. */
export function registerMemoryRoutes(app: FastifyInstance): void {
  registerUpsertRoute(app);
  registerSearchRoute(app);
  registerListRoute(app);
  registerDeleteRoute(app);
}
