/**
 * Zod schemas for the four memory tools (`upsert`, `search`, `list`, `delete`)
 * per concept §8.5–§8.8.
 *
 * Every read/update/delete is implicitly user-scoped by the route handler — the
 * Qdrant wrapper appends a `userId` filter (§8.9), so these schemas only need
 * to describe the wire contract.
 */
import { z } from "zod/v4";

import { metadataSchema } from "./common.js";

/**
 * Optional metadata filter accepted by search/list/delete (§8.6/§8.7/§8.8).
 *
 * `.refine` enforces that at least one criterion is set so that
 * `/tools/memory/delete` cannot be invoked with an empty filter that would
 * resolve to "all of the user's points" once the userId filter is appended
 * server-side.
 */
export const memoryFilterSchema = z
  .object({
    tags: z.array(z.string()).optional(),
    source: z.string().optional(),
  })
  .strict()
  .refine(
    (value) => (value.tags?.length ?? 0) > 0 || value.source !== undefined,
    "filter must constrain by `tags` (non-empty) or `source`",
  );

/**
 * Memory point projection shared by `search.results[]` and `list.items[]`.
 * Search additionally carries a `score`; list does not.
 */
const memoryPointSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Request body for `POST /tools/memory/upsert` (§8.5). */
export const memoryUpsertRequestSchema = z.object({
  id: z
    .uuidv4()
    .optional()
    .describe(
      "Optional UUID v4. When supplied, the entry replaces any existing one with the same id (per-user scope); omit to let the gateway generate a fresh id.",
    ),
  text: z.string().min(1).describe("Memory body to embed and store."),
  source: z.string().optional().describe("Optional provenance label (URL, document name, …)."),
  tags: z.array(z.string()).optional(),
  metadata: metadataSchema.optional(),
});

/** Response body for `POST /tools/memory/upsert` (§8.5). */
export const memoryUpsertResponseSchema = z.object({
  id: z.string(),
  status: z.literal("upserted"),
});

/** Request body for `POST /tools/memory/search` (§8.6). */
export const memorySearchRequestSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Free-text query; embedded and matched against the user's memory points."),
  topK: z.number().int().min(1).max(50).default(5),
  minScore: z.number().min(0).max(1).default(0),
  filter: memoryFilterSchema.optional(),
});

/** Response body for `POST /tools/memory/search` (§8.6). */
export const memorySearchResponseSchema = z.object({
  results: z.array(memoryPointSchema.extend({ score: z.number() })),
});

/** Request body for `POST /tools/memory/list` (§8.7). */
export const memoryListRequestSchema = z.object({
  filter: memoryFilterSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/** Response body for `POST /tools/memory/list` (§8.7). */
export const memoryListResponseSchema = z.object({
  items: z.array(memoryPointSchema),
  nextCursor: z.string().nullable(),
});

/**
 * Request body for `POST /tools/memory/delete` (§8.8).
 *
 * Discriminated union: callers send EITHER `{ id }` OR `{ filter }`, never
 * both. Modeling it as a union (instead of an optional-fields object with a
 * runtime refine) gives the route handler full TypeScript narrowing and
 * eliminates the empty-filter risk: each variant uses `.strict()` so unknown
 * keys are rejected, and the filter variant inherits the non-empty-criterion
 * refine from `memoryFilterSchema`.
 */
export const memoryDeleteRequestSchema = z.union([
  z.object({ id: z.uuidv4() }).strict(),
  z.object({ filter: memoryFilterSchema }).strict(),
]);

/** Response body for `POST /tools/memory/delete` (§8.8). */
export const memoryDeleteResponseSchema = z.object({
  deleted: z.number().int().min(0),
});

/** Inferred TypeScript type for a memory-upsert request body. */
export type MemoryUpsertRequest = z.infer<typeof memoryUpsertRequestSchema>;
/** Inferred TypeScript type for a memory-search request body. */
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;
/** Inferred TypeScript type for a memory-list request body. */
export type MemoryListRequest = z.infer<typeof memoryListRequestSchema>;
/** Inferred TypeScript type for a memory-delete request body. */
export type MemoryDeleteRequest = z.infer<typeof memoryDeleteRequestSchema>;
