import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryListPage, MemorySearchHit } from "../../../src/services/qdrant.js";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A, TEST_TOKEN_USER_B } from "../helpers/test-config.js";

const USER_A_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };
const USER_B_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_B}` };

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stubEmbeddings(app: FastifyInstance): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(app.services.embeddings!, "embed").mockImplementation(async () => {
    await Promise.resolve();
    return Array.from({ length: 1536 }, () => 0);
  });
}

describe("POST /tools/memory/upsert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a UUID v4 when the caller omits `id` and returns it", async () => {
    const app = await buildApp(makeTestConfig());
    stubEmbeddings(app);
    const upsertSpy = vi.spyOn(app.services.qdrant!, "upsert").mockResolvedValue();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers: USER_A_HEADERS,
        payload: { text: "remember this" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ id: string; status: string }>();
      expect(body.status).toBe("upserted");
      expect(body.id).toMatch(UUID_V4_REGEX);

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const callArgs = upsertSpy.mock.calls[0];
      expect(callArgs?.[0]).toBe("user_a");
      const point = callArgs?.[1];
      expect(point?.id).toBe(body.id);
      expect(point?.text).toBe("remember this");
    } finally {
      await app.close();
    }
  });

  it("uses the caller-supplied `id` verbatim", async () => {
    const app = await buildApp(makeTestConfig());
    stubEmbeddings(app);
    const upsertSpy = vi.spyOn(app.services.qdrant!, "upsert").mockResolvedValue();
    const explicitId = "550e8400-e29b-41d4-a716-446655440000";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers: USER_A_HEADERS,
        payload: { id: explicitId, text: "with id" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ id: explicitId, status: "upserted" });
      const point = upsertSpy.mock.calls[0]?.[1];
      expect(point?.id).toBe(explicitId);
    } finally {
      await app.close();
    }
  });

  it("rejects payloads over the 256 KB body limit with 413 PAYLOAD_TOO_LARGE", async () => {
    const app = await buildApp(makeTestConfig());
    stubEmbeddings(app);
    vi.spyOn(app.services.qdrant!, "upsert").mockResolvedValue();
    // 300 KB of literal `a`s plus a few bytes of JSON envelope easily clears
    // the 256 KB cap configured on `/tools/memory/upsert`.
    const oversizedText = "a".repeat(300 * 1024);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers: USER_A_HEADERS,
        payload: { text: oversizedText },
      });
      expect(response.statusCode).toBe(413);
      const body = response.json<{ error: { code: string; details?: { limit?: number } } }>();
      expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
      // The route-specific 256 KB cap is reported in `details.limit` so the
      // caller learns which limit they hit (§7.2, §16.2).
      expect(body.error.details?.limit).toBe(262_144);
    } finally {
      await app.close();
    }
  });

  it("isolates qdrant calls per user (different tokens → different userIds)", async () => {
    const app = await buildApp(makeTestConfig());
    stubEmbeddings(app);
    const upsertSpy = vi.spyOn(app.services.qdrant!, "upsert").mockResolvedValue();
    try {
      await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers: USER_A_HEADERS,
        payload: { text: "alice text" },
      });
      await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers: USER_B_HEADERS,
        payload: { text: "bob text" },
      });
      expect(upsertSpy).toHaveBeenCalledTimes(2);
      expect(upsertSpy.mock.calls[0]?.[0]).toBe("user_a");
      expect(upsertSpy.mock.calls[1]?.[0]).toBe("user_b");
    } finally {
      await app.close();
    }
  });
});

describe("POST /tools/memory/search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("embeds the query and returns the hits returned by qdrant", async () => {
    const app = await buildApp(makeTestConfig());
    const embedSpy = stubEmbeddings(app);
    const hit: MemorySearchHit = {
      id: "memo-1",
      text: "remember",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      score: 0.95,
    };
    const searchSpy = vi.spyOn(app.services.qdrant!, "search").mockResolvedValue([hit]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/search",
        headers: USER_A_HEADERS,
        payload: { query: "what did I save" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ results: MemorySearchHit[] }>();
      expect(body.results).toHaveLength(1);
      expect(embedSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy.mock.calls[0]?.[0]).toBe("user_a");
    } finally {
      await app.close();
    }
  });
});

describe("POST /tools/memory/list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the qdrant page with `nextCursor: null` and passes the userId through", async () => {
    const app = await buildApp(makeTestConfig());
    const page: MemoryListPage = {
      items: [
        {
          id: "memo-2",
          text: "later",
          createdAt: "2025-02-01T00:00:00.000Z",
          updatedAt: "2025-02-02T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    const listSpy = vi.spyOn(app.services.qdrant!, "list").mockResolvedValue(page);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/list",
        headers: USER_A_HEADERS,
        payload: {},
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ items: unknown[]; nextCursor: null | string }>();
      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).toBeNull();
      // Per-user isolation: the resolved userId from the bearer token MUST be
      // the first positional argument of every qdrant.list invocation (§8.9).
      expect(listSpy).toHaveBeenCalledWith("user_a", expect.any(Object), expect.anything());
    } finally {
      await app.close();
    }
  });

  it("propagates the `nextCursor` when the qdrant store returns one", async () => {
    const app = await buildApp(makeTestConfig());
    const page: MemoryListPage = {
      items: [],
      nextCursor: "opaque-cursor",
    };
    vi.spyOn(app.services.qdrant!, "list").mockResolvedValue(page);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/list",
        headers: USER_A_HEADERS,
        payload: { limit: 5 },
      });
      const body = response.json<{ nextCursor: null | string }>();
      expect(body.nextCursor).toBe("opaque-cursor");
    } finally {
      await app.close();
    }
  });
});

describe("POST /tools/memory/delete", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes by id and returns the affected count", async () => {
    const app = await buildApp(makeTestConfig());
    const deleteSpy = vi.spyOn(app.services.qdrant!, "delete").mockResolvedValue(1);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/delete",
        headers: USER_A_HEADERS,
        payload: { id: "550e8400-e29b-41d4-a716-446655440000" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ deleted: 1 });
      const call = deleteSpy.mock.calls[0];
      expect(call?.[0]).toBe("user_a");
      expect(call?.[1]).toStrictEqual({ id: "550e8400-e29b-41d4-a716-446655440000" });
    } finally {
      await app.close();
    }
  });

  it("deletes by filter and returns the affected count", async () => {
    const app = await buildApp(makeTestConfig());
    const deleteSpy = vi.spyOn(app.services.qdrant!, "delete").mockResolvedValue(3);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/delete",
        headers: USER_A_HEADERS,
        payload: { filter: { tags: ["work"] } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ deleted: 3 });
      const call = deleteSpy.mock.calls[0];
      expect(call?.[1]).toStrictEqual({ filter: { tags: ["work"] } });
    } finally {
      await app.close();
    }
  });

  it("rejects requests that carry both `id` and `filter` with 422", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/delete",
        headers: USER_A_HEADERS,
        payload: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          filter: { tags: ["work"] },
        },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("rejects requests that carry neither `id` nor `filter` with 422", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/memory/delete",
        headers: USER_A_HEADERS,
        payload: {},
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
