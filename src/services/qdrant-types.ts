/**
 * Public type surface for the Qdrant memory store wrapper.
 *
 * Extracted from `qdrant.ts` to keep the implementation file under the
 * project-wide per-file line budget. Both files share these declarations.
 */
import type { QdrantClient } from "@qdrant/js-client-rest";

/** Optional metadata filter accepted by memory reads and deletes. */
export type MemoryFilter = {
  tags?: string[];
  source?: string;
};

/** Shape of a memory point sent to `QdrantStore.upsert`. */
export type MemoryPointInput = {
  /** Caller-supplied logical id (UUID v4 per §8.5). */
  id: string;
  text: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  vector: number[];
};

/** Shape of a memory point returned by reads. */
export type MemoryPoint = {
  id: string;
  text: string;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** Hit returned by `QdrantStore.search` — payload plus relevance score. */
export type MemorySearchHit = { score: number } & MemoryPoint;

/** Options accepted by `QdrantStore.search`. */
export type MemorySearchOptions = {
  vector: number[];
  topK?: number;
  minScore?: number;
  filter?: MemoryFilter;
};

/** Options accepted by `QdrantStore.list`. */
export type MemoryListOptions = {
  filter?: MemoryFilter;
  limit?: number;
  /** Opaque cursor produced by a previous `list` response. */
  cursor?: string;
};

/** Page returned by `QdrantStore.list`. */
export type MemoryListPage = {
  items: MemoryPoint[];
  /**
   * Opaque cursor for the next page; `null` when the current page is the
   * last one. Mirrors the wire shape exactly (see `memoryListResponseSchema`)
   * so the wrapper-to-response mapping is a pass-through.
   */
  nextCursor: null | string;
};

/** Target for `QdrantStore.delete`. */
export type MemoryDeleteTarget = { filter: MemoryFilter } | { id: string };

/** Subset of `QdrantClient` the store actually depends on (eases mocking). */
export type QdrantLikeClient = Pick<
  QdrantClient,
  | "count"
  | "createCollection"
  | "delete"
  | "getCollection"
  | "getCollections"
  | "retrieve"
  | "scroll"
  | "search"
  | "upsert"
>;
