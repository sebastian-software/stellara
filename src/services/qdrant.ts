/**
 * Qdrant client wrapper for the shared `stellara-memory` collection (§8.5–§8.9).
 *
 * Encapsulates collection bootstrap, deterministic per-user point IDs, and the
 * four CRUD operations needed by Schritt 5's memory routes. Every read/update
 * is automatically scoped to the calling user by attaching a `userId` filter.
 *
 * Schritt 3 only delivers the wrapper and its `/ready` probe; the memory
 * routes themselves arrive in Schritt 5 and may extend this surface (e.g.
 * payload-ordered listing). Public types live in `qdrant-types.ts` and the
 * shared payload/cursor helpers live in `qdrant-payload.ts` — splitting them
 * keeps each module under the project-wide per-file budget.
 */
import type { Schemas } from "@qdrant/js-client-rest";

import { QdrantClient } from "@qdrant/js-client-rest";
import { v5 as uuidv5 } from "uuid";

import type {
  MemoryDeleteTarget,
  MemoryFilter,
  MemoryListOptions,
  MemoryListPage,
  MemoryPointInput,
  MemorySearchHit,
  MemorySearchOptions,
  QdrantLikeClient,
} from "./qdrant-types.js";

import { type Config, ConfigError } from "../config.js";
import { AppError, ErrorCode, mapUpstreamError } from "../errors.js";
import {
  abortPromise,
  asRecord,
  asString,
  buildFilter,
  decodeCursor,
  encodeCursor,
  extractVectorSize,
  toMemoryPoint,
  USER_ID_KEY,
} from "./qdrant-payload.js";

export type {
  MemoryDeleteTarget,
  MemoryFilter,
  MemoryListOptions,
  MemoryListPage,
  MemoryPoint,
  MemoryPointInput,
  MemorySearchHit,
  MemorySearchOptions,
  QdrantLikeClient,
} from "./qdrant-types.js";

/**
 * UUID namespace used to derive deterministic Qdrant point IDs from
 * `(userId, callerId)` tuples (§8.9). This constant must not change once any
 * production data exists — derived IDs would no longer match historical
 * points.
 */
const QDRANT_POINT_NAMESPACE = "4f9a7c11-3e90-4f3c-9b9a-1b2c3d4e5f60";

/** Cosine distance is the §25 default for embedding-based similarity search. */
const DEFAULT_DISTANCE: Schemas["Distance"] = "Cosine";

function isFilterTarget(target: MemoryDeleteTarget): target is { filter: MemoryFilter } {
  return "filter" in target;
}

/**
 * Wraps `@qdrant/js-client-rest` with the Stellara per-user contract.
 *
 * Construction takes an optional pre-built client so tests can inject a
 * fake without monkey-patching the module.
 */
export class QdrantStore {
  private readonly client: QdrantLikeClient;
  private readonly collection: string;
  private readonly expectedDimensions: number;

  public constructor(config: Config, client?: QdrantLikeClient) {
    if (client === undefined) {
      // Defensive guard: callers should consult `Config.features.memory`
      // before instantiating this client. Reaching this branch without a
      // pre-built `client` (i.e. production usage) indicates a wiring bug.
      if (config.qdrantBaseUrl === undefined || config.qdrantApiKey === undefined) {
        throw new ConfigError("Qdrant credentials missing", {
          QDRANT_BASE_URL: [
            "QDRANT_BASE_URL and QDRANT_API_KEY are required to construct QdrantStore",
          ],
        });
      }
      this.client = new QdrantClient({
        url: config.qdrantBaseUrl,
        apiKey: config.qdrantApiKey,
        checkCompatibility: false,
      });
    } else {
      this.client = client;
    }
    this.collection = config.qdrantCollection;
    this.expectedDimensions = config.embeddingsDimensions;
  }

  /**
   * Verifies that the configured collection exists and that its vector
   * dimension matches the embedding configuration. Creates the collection
   * (cosine distance, correct size) when missing. Throws a clear error when
   * dimensions disagree — see concept §25 for the migration story.
   */
  public async ensureCollection(): Promise<void> {
    try {
      const list = await this.client.getCollections();
      const exists = list.collections.some((entry) => entry.name === this.collection);
      if (!exists) {
        await this.client.createCollection(this.collection, {
          vectors: { size: this.expectedDimensions, distance: DEFAULT_DISTANCE },
        });
        return;
      }
      const info = await this.client.getCollection(this.collection);
      const actualSize = extractVectorSize(info);
      if (actualSize !== undefined && actualSize !== this.expectedDimensions) {
        throw new AppError({
          code: ErrorCode.INTERNAL_ERROR,
          message:
            `Qdrant collection "${this.collection}" has vector size ${String(actualSize)}, ` +
            `but EMBEDDINGS_DIMENSIONS is ${String(this.expectedDimensions)}. ` +
            `Run scripts/migrate-embeddings.ts before changing the embedding model (§25).`,
        });
      }
    } catch (error) {
      if (AppError.is(error)) throw error;
      throw mapUpstreamError(error, { service: "qdrant" });
    }
  }

  /**
   * Deterministically maps `(userId, callerId)` to a Qdrant point id via
   * UUID v5 over `${userId}/${callerId}`. Two users sharing a caller id never
   * collide, and the mapping is stable across processes.
   */
  public pointIdFor(userId: string, callerId: string): string {
    return uuidv5(`${userId}/${callerId}`, QDRANT_POINT_NAMESPACE);
  }

  /**
   * Inserts or replaces a memory point.
   *
   * Replace semantics per §8.5: when a point already exists for the same
   * `(userId, callerId)` the previous `createdAt` is preserved and only
   * `updatedAt` advances. A single extra `retrieve` round-trip costs less
   * than the embedding call that always precedes upsert.
   */
  public async upsert(
    userId: string,
    point: MemoryPointInput,
    signal?: AbortSignal,
  ): Promise<void> {
    const pointId = this.pointIdFor(userId, point.id);
    const now = new Date().toISOString();
    const createdAt = (await this.fetchExistingCreatedAt(pointId)) ?? now;

    const payload: Record<string, unknown> = {
      [USER_ID_KEY]: userId,
      id: point.id,
      text: point.text,
      createdAt,
      updatedAt: now,
    };
    if (point.source !== undefined) payload.source = point.source;
    if (point.tags !== undefined) payload.tags = point.tags;
    if (point.metadata !== undefined) payload.metadata = point.metadata;

    try {
      await this.race(
        this.client.upsert(this.collection, {
          wait: true,
          points: [{ id: pointId, vector: point.vector, payload }],
        }),
        signal,
      );
    } catch (error) {
      throw mapUpstreamError(error, { service: "qdrant", signal });
    }
  }

  /** Runs a vector search scoped to `userId`. */
  public async search(
    userId: string,
    opts: MemorySearchOptions,
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]> {
    try {
      const results = await this.race(
        this.client.search(this.collection, {
          vector: opts.vector,
          limit: opts.topK ?? 10,
          score_threshold: opts.minScore,
          filter: buildFilter(userId, opts.filter),
          with_payload: true,
        }),
        signal,
      );
      return results.map((hit) => {
        const payload = asRecord(hit.payload);
        const base = toMemoryPoint(String(hit.id), payload);
        return { ...base, score: hit.score };
      });
    } catch (error) {
      throw mapUpstreamError(error, { service: "qdrant", signal });
    }
  }

  /** Cursor-paginated listing scoped to `userId`. */
  public async list(
    userId: string,
    opts: MemoryListOptions,
    signal?: AbortSignal,
  ): Promise<MemoryListPage> {
    try {
      const result = await this.race(
        this.client.scroll(this.collection, {
          filter: buildFilter(userId, opts.filter),
          limit: opts.limit ?? 50,
          offset: decodeCursor(opts.cursor),
          with_payload: true,
          with_vector: false,
        }),
        signal,
      );
      const items = result.points.map((record) =>
        toMemoryPoint(String(record.id), asRecord(record.payload)),
      );
      const cursor = encodeCursor(result.next_page_offset ?? undefined);
      return { items, nextCursor: cursor ?? null };
    } catch (error) {
      throw mapUpstreamError(error, { service: "qdrant", signal });
    }
  }

  /**
   * Deletes points either by caller id or by metadata filter, always scoped
   * to `userId`. Returns the number of points the operation affected.
   *
   * Qdrant's `delete` API itself never reports an affected-count, so we infer
   * it before the delete runs:
   *
   * - For id-based deletes we issue a `retrieve` for the deterministic point
   *   id; the resulting array length is either 0 (missing) or 1 (present).
   * - For filter-based deletes we run an exact `count` against the same
   *   user-scoped filter. The extra round-trip is cheap compared to the
   *   delete itself and replaces the misleading `statusToCount` heuristic
   *   that always reported "1" on success regardless of how many points
   *   actually matched.
   */
  public async delete(
    userId: string,
    target: MemoryDeleteTarget,
    signal?: AbortSignal,
  ): Promise<number> {
    try {
      if (isFilterTarget(target)) {
        const filter = buildFilter(userId, target.filter);
        const countResult = await this.race(
          this.client.count(this.collection, { exact: true, filter }),
          signal,
        );
        const affectedByFilter = countResult.count;
        await this.race(this.client.delete(this.collection, { wait: true, filter }), signal);
        return affectedByFilter;
      }
      const pointId = this.pointIdFor(userId, target.id);
      const existing = await this.race(
        this.client.retrieve(this.collection, {
          ids: [pointId],
          with_payload: false,
          with_vector: false,
        }),
        signal,
      );
      const affectedById = existing.length;
      await this.race(
        this.client.delete(this.collection, {
          wait: true,
          points: [pointId],
        }),
        signal,
      );
      return affectedById;
    } catch (error) {
      throw mapUpstreamError(error, { service: "qdrant", signal });
    }
  }

  /**
   * Races an upstream call against an optional abort signal. The Qdrant
   * client itself does not accept per-call `AbortSignal` in v1.x, so this
   * helper lets callers enforce their own timeout even though the underlying
   * HTTP request keeps running in the background.
   */
  private async race<T>(call: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return call;
    return Promise.race([call, abortPromise(signal)]);
  }

  /**
   * Lightweight readiness probe.
   *
   * TODO: `@qdrant/js-client-rest` v1.x configures the request timeout at
   * construction time and does not accept a per-call `AbortSignal`. We race
   * the call against an abort-driven rejection so the `/ready` 2-second
   * timeout still applies, even if the client itself keeps running.
   */
  public async probe(signal: AbortSignal): Promise<void> {
    try {
      await Promise.race([this.client.getCollections(), abortPromise(signal)]);
    } catch (error) {
      throw mapUpstreamError(error, { service: "qdrant", signal });
    }
  }

  private async fetchExistingCreatedAt(pointId: string): Promise<string | undefined> {
    // Qdrant's `retrieve` returns an empty array for missing IDs (no exception),
    // so we don't swallow transient failures here — they propagate via
    // `mapUpstreamError` in the upsert caller and surface as UPSTREAM_ERROR
    // instead of silently overwriting an existing `createdAt`.
    const records = await this.client.retrieve(this.collection, {
      ids: [pointId],
      with_payload: true,
      with_vector: false,
    });
    const record = records[0];
    if (record === undefined) return undefined;
    const payload = asRecord(record.payload);
    return asString(payload?.createdAt);
  }
}
