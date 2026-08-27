/**
 * Integration smoke test for the four memory tools (concept §8.5–§8.8, §26).
 *
 * Runs the full CRUD lifecycle end-to-end against the live embeddings provider
 * plus Qdrant: upsert → search → list → delete → search-again. The whole
 * sequence shares one Fastify instance and one tagged data set so an
 * `afterAll` cleanup can `delete by filter` any leftovers from a failed run.
 *
 * The suite is excluded from `pnpm test` / `pnpm agent:check` (see
 * `vitest.config.ts`). It runs via `pnpm test:integration`, which loads
 * `vitest.integration.config.ts` and locally supplied environment variables.
 */
import type { FastifyInstance } from "fastify";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/server.js";
import { getIntegrationHeaders } from "./helpers/auth.js";

// Resolved in `beforeAll` so a missing `STELLARA_TOKEN_INTEGRATION` surfaces as
// a clean Vitest failure rather than a module-load crash that gets reported
// as "Failed to collect test file".
let HEADERS: ReturnType<typeof getIntegrationHeaders>;

/** Tag used to scope cleanup so leftover points never bleed into the next run. */
const TEST_TAG = `stellara-integration-${randomUUID()}`;

type UpsertResponse = {
  id: string;
  status: "upserted";
};

type SearchResponse = {
  results: Array<{
    id: string;
    text: string;
    score: number;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
  }>;
};

type ListResponse = {
  items: Array<{
    id: string;
    text: string;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  nextCursor: null | string;
};

type DeleteResponse = {
  deleted: number;
};

describe("integration: memory CRUD lifecycle", () => {
  let app: FastifyInstance;
  let pointId: string;

  beforeAll(async () => {
    HEADERS = getIntegrationHeaders();
    app = await buildApp(loadConfig());
    pointId = randomUUID();
  });

  afterAll(async () => {
    // Defensive cleanup: even when the inline delete already removed the
    // point, `delete by filter` on the tag is idempotent (returns `deleted: 0`).
    // Errors during cleanup are logged separately so they do not mask a
    // subsequent `app.close()` failure (and vice versa).
    try {
      await app.inject({
        method: "POST",
        url: "/tools/memory/delete",
        headers: HEADERS,
        payload: { filter: { tags: [TEST_TAG] } },
      });
    } catch (error) {
      app.log.warn({ err: error }, "integration cleanup failed");
    }
    await app.close();
  });

  it("runs upsert → search → list → delete → search-empty", async () => {
    const text = "Stellara integration smoke point";

    // 1. Upsert — gateway generates the vector via the embeddings provider and
    //    stores the point under the calling user's userId (§8.5).
    const upsert = await app.inject({
      method: "POST",
      url: "/tools/memory/upsert",
      headers: HEADERS,
      payload: {
        id: pointId,
        text,
        tags: [TEST_TAG],
        source: "stellara-integration",
      },
    });
    expect(upsert.statusCode).toBe(200);
    const upsertBody = upsert.json<UpsertResponse>();
    expect(upsertBody.id).toBe(pointId);
    expect(upsertBody.status).toBe("upserted");

    // 2. Vector-search filtered on the integration tag — the upserted point
    //    must come back as the top hit (§8.6).
    const search = await app.inject({
      method: "POST",
      url: "/tools/memory/search",
      headers: HEADERS,
      payload: {
        query: text,
        topK: 5,
        filter: { tags: [TEST_TAG] },
      },
    });
    expect(search.statusCode).toBe(200);
    const searchBody = search.json<SearchResponse>();
    expect(searchBody.results.length).toBeGreaterThan(0);
    const searchHit = searchBody.results.find((hit) => hit.id === pointId);
    expect(searchHit).toBeDefined();

    // 3. List with the same tag filter — point appears in pagination output (§8.7).
    const list = await app.inject({
      method: "POST",
      url: "/tools/memory/list",
      headers: HEADERS,
      payload: {
        filter: { tags: [TEST_TAG] },
        limit: 10,
      },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<ListResponse>();
    expect(listBody.items.some((item) => item.id === pointId)).toBe(true);

    // 4. Delete by id — must report exactly one removal (§8.8).
    const del = await app.inject({
      method: "POST",
      url: "/tools/memory/delete",
      headers: HEADERS,
      payload: { id: pointId },
    });
    expect(del.statusCode).toBe(200);
    const deleteBody = del.json<DeleteResponse>();
    expect(deleteBody.deleted).toBe(1);

    // 5. Search again — the point must no longer surface for the same query
    //    + tag filter, proving the delete reached Qdrant before this hit fires.
    const searchAfter = await app.inject({
      method: "POST",
      url: "/tools/memory/search",
      headers: HEADERS,
      payload: {
        query: text,
        topK: 5,
        filter: { tags: [TEST_TAG] },
      },
    });
    expect(searchAfter.statusCode).toBe(200);
    const searchAfterBody = searchAfter.json<SearchResponse>();
    const lingering = searchAfterBody.results.find((hit) => hit.id === pointId);
    expect(lingering).toBeUndefined();
  });
});
