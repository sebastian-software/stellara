/**
 * Shared orchestration for the four memory tools (`upsert`, `search`, `list`,
 * `delete`) per concept §8.5–§8.8.
 *
 * Both the REST route handlers (`src/routes/memory.ts`) and the MCP
 * `tools/call` dispatcher (`src/routes/mcp/tools.ts`) delegate to these
 * functions so a single implementation covers both surfaces. Auth and
 * per-user isolation are enforced at the route layer: the caller passes the
 * resolved `userId` into every memory tool, and the Qdrant wrapper appends
 * the `userId = <caller>` filter to every read/update (§8.9).
 *
 * `runMemoryDelete` accepts both shapes of the delete request:
 * the REST surface uses a discriminated union (`{ id }` XOR `{ filter }`),
 * the MCP surface uses a single object with both fields optional plus an XOR
 * refine. After Zod parsing the runtime shape is the same in both cases, so
 * we accept the broader type and narrow defensively at runtime.
 */
import type { FastifyInstance } from "fastify";

import { randomUUID } from "node:crypto";

import type {
  MemoryDeleteRequest,
  MemoryListRequest,
  MemorySearchRequest,
  MemoryUpsertRequest,
} from "../schemas/memory.js";
import type { EmbeddingsProvider } from "../services/embeddings.js";
import type {
  MemoryFilter,
  MemoryPoint,
  MemorySearchHit,
  QdrantStore,
} from "../services/qdrant.js";

import { AppError, ErrorCode } from "../errors.js";
import { PER_ROUTE_TIMEOUTS_MS, withTimeout } from "../timeouts.js";

/**
 * Narrows the optional memory-feature services to a non-optional pair. The
 * memory routes are only registered when `Config.features.memory` is on, so
 * reaching this guard signals a bootstrap-wiring bug — surfaced as
 * INTERNAL_ERROR to stay distinct from missing-credentials errors at boot.
 */
function requireMemoryServices(app: FastifyInstance): {
  embeddings: EmbeddingsProvider;
  qdrant: QdrantStore;
} {
  const { embeddings, qdrant } = app.services;
  if (embeddings === undefined || qdrant === undefined) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Memory feature is not configured for this deployment",
    });
  }
  return { embeddings, qdrant };
}

/** Response shape returned by {@link runMemoryUpsert}. */
export type MemoryUpsertResult = { id: string; status: "upserted" };

/** Response shape returned by {@link runMemorySearch}. */
export type MemorySearchResult = { results: MemorySearchHit[] };

/** Response shape returned by {@link runMemoryList}. */
export type MemoryListResult = {
  items: MemoryPoint[];
  nextCursor: null | string;
};

/** Response shape returned by {@link runMemoryDelete}. */
export type MemoryDeleteResult = { deleted: number };

/**
 * Broader input shape accepted by {@link runMemoryDelete}.
 *
 * The MCP and REST surfaces validate against different Zod schemas — the REST
 * one is a discriminated union, the MCP one is a single object with optional
 * fields. After parsing both reduce to `{ id?: string; filter?: MemoryFilter }`,
 * which is what this type captures.
 */
export type MemoryDeleteInput = { filter?: MemoryFilter; id?: string } | MemoryDeleteRequest;

/** Executes `memory_upsert` for the supplied userId. */
export async function runMemoryUpsert(
  app: FastifyInstance,
  userId: string,
  input: MemoryUpsertRequest,
): Promise<MemoryUpsertResult> {
  const { embeddings, qdrant } = requireMemoryServices(app);
  const id = input.id ?? randomUUID();
  await withTimeout(PER_ROUTE_TIMEOUTS_MS.memoryUpsert, async (signal) => {
    const vector = await embeddings.embed(input.text, signal);
    await qdrant.upsert(
      userId,
      {
        id,
        text: input.text,
        source: input.source,
        tags: input.tags,
        metadata: input.metadata,
        vector,
      },
      signal,
    );
  });
  return { id, status: "upserted" };
}

/** Executes `memory_search` for the supplied userId. */
export async function runMemorySearch(
  app: FastifyInstance,
  userId: string,
  input: MemorySearchRequest,
): Promise<MemorySearchResult> {
  const { embeddings, qdrant } = requireMemoryServices(app);
  const results = await withTimeout(PER_ROUTE_TIMEOUTS_MS.memorySearch, async (signal) => {
    const vector = await embeddings.embed(input.query, signal);
    return qdrant.search(
      userId,
      { vector, topK: input.topK, minScore: input.minScore, filter: input.filter },
      signal,
    );
  });
  return { results };
}

/** Executes `memory_list` for the supplied userId. */
export async function runMemoryList(
  app: FastifyInstance,
  userId: string,
  input: MemoryListRequest,
): Promise<MemoryListResult> {
  const { qdrant } = requireMemoryServices(app);
  const page = await withTimeout(PER_ROUTE_TIMEOUTS_MS.memoryList, async (signal) =>
    qdrant.list(userId, { filter: input.filter, limit: input.limit, cursor: input.cursor }, signal),
  );
  return { items: page.items, nextCursor: page.nextCursor };
}

/**
 * Executes `memory_delete` for the supplied userId.
 *
 * Accepts both the REST discriminated-union shape and the MCP object shape
 * (see {@link MemoryDeleteInput}). The Zod schemas in both surfaces enforce
 * exactly-one-of (`id` XOR `filter`); this function narrows defensively so the
 * impossible "neither branch" path produces a clear `INTERNAL_ERROR` instead
 * of silently mass-deleting.
 */
export async function runMemoryDelete(
  app: FastifyInstance,
  userId: string,
  input: MemoryDeleteInput,
): Promise<MemoryDeleteResult> {
  const { qdrant } = requireMemoryServices(app);
  const deleted = await withTimeout(PER_ROUTE_TIMEOUTS_MS.memoryDelete, async (signal) => {
    if ("id" in input && input.id !== undefined) {
      return qdrant.delete(userId, { id: input.id }, signal);
    }
    if ("filter" in input && input.filter !== undefined) {
      return qdrant.delete(userId, { filter: input.filter }, signal);
    }
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "memory_delete reached neither branch",
    });
  });
  return { deleted };
}
