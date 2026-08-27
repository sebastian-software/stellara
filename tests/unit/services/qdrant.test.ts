import type { Schemas } from "@qdrant/js-client-rest";

import { describe, expect, it } from "vitest";

import { ErrorCode } from "../../../src/errors.js";
import { type QdrantLikeClient, QdrantStore } from "../../../src/services/qdrant.js";
import { makeTestConfig } from "../helpers/test-config.js";

const UUID_V5_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Records the call args of every method the QdrantStore touches. */
type CallSink = {
  upsertCalls: Array<{ collection: string; args: unknown }>;
  searchCalls: Array<{ collection: string; args: unknown }>;
  scrollCalls: Array<{ collection: string; args: unknown }>;
  deleteCalls: Array<{ collection: string; args: unknown }>;
  retrieveCalls: Array<{ collection: string; args: unknown }>;
  countCalls: Array<{ collection: string; args: unknown }>;
  createCollectionCalls: Array<{ collection: string; args: unknown }>;
};

type FakeClientOptions = {
  collections?: Array<{ name: string }>;
  collectionInfo?: Schemas["CollectionInfo"];
  getCollectionsImpl?: () => Promise<Schemas["CollectionsResponse"]>;
  retrieveImpl?: () => Promise<Array<Schemas["Record"]>>;
  searchImpl?: () => Promise<Array<Schemas["ScoredPoint"]>>;
  scrollImpl?: () => Promise<Schemas["ScrollResult"]>;
  countImpl?: () => Promise<Schemas["CountResult"]>;
};

/** Real defaults that satisfy the rich Qdrant `CollectionInfo` schema. */
const HNSW_DEFAULTS: Schemas["HnswConfig"] = {
  m: 16,
  ef_construct: 100,
  full_scan_threshold: 10_000,
};

const OPTIMIZER_DEFAULTS: Schemas["OptimizersConfig"] = {
  default_segment_number: 0,
  flush_interval_sec: 5,
  max_optimization_threads: null,
};

function defaultCollectionInfo(size: number): Schemas["CollectionInfo"] {
  return {
    status: "green",
    optimizer_status: "ok",
    segments_count: 1,
    payload_schema: {},
    config: {
      params: { vectors: { size, distance: "Cosine" } },
      hnsw_config: HNSW_DEFAULTS,
      optimizer_config: OPTIMIZER_DEFAULTS,
    },
  };
}

/** Builds a fake QdrantLikeClient plus a sink that captures observed call args. */
function makeFakeClient(options: FakeClientOptions = {}): {
  client: QdrantLikeClient;
  sink: CallSink;
} {
  const sink: CallSink = {
    upsertCalls: [],
    searchCalls: [],
    scrollCalls: [],
    deleteCalls: [],
    retrieveCalls: [],
    countCalls: [],
    createCollectionCalls: [],
  };
  const collectionInfo = options.collectionInfo ?? defaultCollectionInfo(1536);
  const collections = options.collections ?? [];
  const searchImpl = options.searchImpl;
  const retrieveImpl = options.retrieveImpl;
  const scrollImpl = options.scrollImpl;
  const countImpl = options.countImpl;
  const defaultGetCollections = async (): Promise<Schemas["CollectionsResponse"]> => {
    await Promise.resolve();
    return { collections };
  };
  const client: QdrantLikeClient = {
    getCollections: options.getCollectionsImpl ?? defaultGetCollections,
    async getCollection(): Promise<Schemas["CollectionInfo"]> {
      await Promise.resolve();
      return collectionInfo;
    },
    async createCollection(collection: string, args: unknown): Promise<boolean> {
      await Promise.resolve();
      sink.createCollectionCalls.push({ collection, args });
      return true;
    },
    async upsert(collection: string, args: unknown): Promise<Schemas["UpdateResult"]> {
      await Promise.resolve();
      sink.upsertCalls.push({ collection, args });
      return { status: "completed" };
    },
    async search(collection: string, args: unknown): Promise<Array<Schemas["ScoredPoint"]>> {
      await Promise.resolve();
      sink.searchCalls.push({ collection, args });
      return searchImpl === undefined ? [] : searchImpl();
    },
    async retrieve(collection: string, args: unknown): Promise<Array<Schemas["Record"]>> {
      await Promise.resolve();
      sink.retrieveCalls.push({ collection, args });
      return retrieveImpl === undefined ? [] : retrieveImpl();
    },
    async scroll(collection: string, args: unknown): Promise<Schemas["ScrollResult"]> {
      await Promise.resolve();
      sink.scrollCalls.push({ collection, args });
      return scrollImpl === undefined ? { points: [], next_page_offset: null } : scrollImpl();
    },
    async delete(collection: string, args: unknown): Promise<Schemas["UpdateResult"]> {
      await Promise.resolve();
      sink.deleteCalls.push({ collection, args });
      return { status: "completed" };
    },
    async count(collection: string, args: unknown): Promise<Schemas["CountResult"]> {
      await Promise.resolve();
      sink.countCalls.push({ collection, args });
      return countImpl === undefined ? { count: 0 } : countImpl();
    },
  };
  return { client, sink };
}

/** Returns the recorded payload of the first call in `calls`. */
function firstCall<T>(calls: T[]): T {
  expect(calls.length).toBeGreaterThan(0);
  return calls[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Asserts that `value` is a record and returns it as such. */
function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`Expected an object record, got ${typeof value}`);
  }
  return value;
}

/** Coerces `value` to `unknown[]`, throwing when it is not an array. */
function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected an array, got ${typeof value}`);
  }
  return value;
}

/** Extracts a typed string array from an unknown payload entry. */
function getStringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

/** Promise constructor body that never resolves — kept outside tests to satisfy lint. */
function neverResolveExecutor(): void {
  // Intentionally empty: the returned promise must stay pending so the
  // abort path in QdrantStore.probe is exercised.
}

describe("QdrantStore.pointIdFor", () => {
  it("returns a deterministic UUID v5 for stable inputs", () => {
    const { client } = makeFakeClient();
    const store = new QdrantStore(makeTestConfig(), client);
    const a = store.pointIdFor("alice", "memo-1");
    const b = store.pointIdFor("alice", "memo-1");
    expect(a).toBe(b);
    expect(a).toMatch(UUID_V5_REGEX);
  });

  it("produces different point ids for different users sharing a caller id", () => {
    const { client } = makeFakeClient();
    const store = new QdrantStore(makeTestConfig(), client);
    expect(store.pointIdFor("alice", "memo-1")).not.toBe(store.pointIdFor("bob", "memo-1"));
  });
});

describe("QdrantStore.ensureCollection", () => {
  it("creates the collection with cosine distance when missing", async () => {
    const { client, sink } = makeFakeClient({ collections: [] });
    const store = new QdrantStore(makeTestConfig(), client);
    await store.ensureCollection();
    const call = firstCall(sink.createCollectionCalls);
    expect(call.collection).toBe("stellara-memory");
    expect(call.args).toStrictEqual({
      vectors: { size: 1536, distance: "Cosine" },
    });
  });

  it("resolves silently when the collection exists and dimensions match", async () => {
    const { client, sink } = makeFakeClient({ collections: [{ name: "stellara-memory" }] });
    const store = new QdrantStore(makeTestConfig(), client);
    await expect(store.ensureCollection()).resolves.toBeUndefined();
    expect(sink.createCollectionCalls).toHaveLength(0);
  });

  it("throws a clear error when dimensions disagree", async () => {
    const { client } = makeFakeClient({
      collections: [{ name: "stellara-memory" }],
      collectionInfo: defaultCollectionInfo(768),
    });
    const store = new QdrantStore(makeTestConfig(), client);
    await expect(store.ensureCollection()).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      message: expect.stringContaining("vector size 768"),
    });
  });

  it("maps client failures via mapUpstreamError", async () => {
    const { client } = makeFakeClient({
      async getCollectionsImpl() {
        await Promise.resolve();
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    await expect(store.ensureCollection()).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });
});

describe("QdrantStore.upsert", () => {
  it("includes the userId in the payload and writes to the configured collection", async () => {
    const { client, sink } = makeFakeClient();
    const store = new QdrantStore(makeTestConfig(), client);
    await store.upsert("alice", {
      id: "memo-1",
      text: "remember this",
      tags: ["work"],
      source: "manual",
      vector: [0.1, 0.2],
    });

    const call = firstCall(sink.upsertCalls);
    expect(call.collection).toBe("stellara-memory");
    const args = asRecord(call.args);
    const points = args.points;
    expect(Array.isArray(points)).toBe(true);
    const point = asRecord(firstCall(asArray(points)));
    expect(asRecord(point.payload)).toMatchObject({
      userId: "alice",
      id: "memo-1",
      text: "remember this",
      tags: ["work"],
      source: "manual",
    });
    expect(point.id).toMatch(UUID_V5_REGEX);
  });

  it("preserves createdAt when a previous point exists", async () => {
    const { client, sink } = makeFakeClient({
      async retrieveImpl() {
        await Promise.resolve();
        return [{ id: "x", payload: { createdAt: "2020-01-01T00:00:00.000Z" } }];
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    await store.upsert("alice", { id: "memo-1", text: "t", vector: [0] });

    const call = firstCall(sink.upsertCalls);
    const args = asRecord(call.args);
    const point = asRecord(firstCall(asArray(args.points)));
    const payload = asRecord(point.payload);
    expect(payload.createdAt).toBe("2020-01-01T00:00:00.000Z");
    expect(payload.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("QdrantStore.search", () => {
  it("attaches the userId filter and returns normalized hits", async () => {
    const { client, sink } = makeFakeClient({
      async searchImpl() {
        await Promise.resolve();
        return [
          {
            id: "pid-1",
            version: 1,
            score: 0.99,
            payload: {
              userId: "alice",
              id: "memo-1",
              text: "remember",
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-02T00:00:00.000Z",
              tags: ["work"],
            },
          },
        ];
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    const hits = await store.search("alice", { vector: [0.1, 0.2], topK: 5 });

    const call = firstCall(sink.searchCalls);
    const args = asRecord(call.args);
    const filter = asRecord(args.filter);
    const must = asArray(filter.must);
    expect(asRecord(must[0])).toStrictEqual({
      key: "userId",
      match: { value: "alice" },
    });

    expect(hits).toStrictEqual([
      {
        id: "memo-1",
        text: "remember",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z",
        tags: ["work"],
        score: 0.99,
      },
    ]);
  });
});

describe("QdrantStore.list", () => {
  it("forwards the userId filter to scroll and encodes the next cursor", async () => {
    const { client, sink } = makeFakeClient({
      async scrollImpl() {
        await Promise.resolve();
        return {
          points: [
            {
              id: "pid-2",
              payload: {
                userId: "alice",
                id: "memo-2",
                text: "later",
                createdAt: "2025-02-01T00:00:00.000Z",
                updatedAt: "2025-02-02T00:00:00.000Z",
              },
            },
          ],
          next_page_offset: "pid-3",
        };
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    const page = await store.list("alice", { limit: 50 });

    const call = firstCall(sink.scrollCalls);
    const args = asRecord(call.args);
    const filter = asRecord(args.filter);
    const must = asArray(filter.must);
    expect(asRecord(must[0]).key).toBe("userId");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const cursor = page.nextCursor!;
    expect(Buffer.from(cursor, "base64url").toString("utf8")).toBe("pid-3");
  });
});

describe("QdrantStore.delete", () => {
  it("reports a count of 1 when the targeted id exists", async () => {
    const { client, sink } = makeFakeClient({
      async retrieveImpl() {
        await Promise.resolve();
        return [{ id: "pid-1", payload: {} }];
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    const count = await store.delete("alice", { id: "memo-1" });
    expect(count).toBe(1);
    const retrieveCall = firstCall(sink.retrieveCalls);
    const retrieveArgs = asRecord(retrieveCall.args);
    const retrieveIds = asArray(retrieveArgs.ids);
    expect(typeof retrieveIds[0]).toBe("string");
    expect(String(retrieveIds[0])).toMatch(UUID_V5_REGEX);
    const deleteCall = firstCall(sink.deleteCalls);
    const args = asRecord(deleteCall.args);
    const points = asArray(args.points);
    expect(typeof points[0]).toBe("string");
    expect(String(points[0])).toMatch(UUID_V5_REGEX);
  });

  it("reports a count of 0 when the targeted id does not exist", async () => {
    const { client, sink } = makeFakeClient();
    const store = new QdrantStore(makeTestConfig(), client);
    const count = await store.delete("alice", { id: "missing" });
    expect(count).toBe(0);
    // Delete still fires — Qdrant treats it as a no-op but we keep the call
    // for symmetry with the previous semantics.
    expect(sink.deleteCalls).toHaveLength(1);
  });

  it("returns the exact count for filter-based deletes", async () => {
    const { client, sink } = makeFakeClient({
      async countImpl() {
        await Promise.resolve();
        return { count: 7 };
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    const count = await store.delete("alice", { filter: { tags: ["work"] } });
    expect(count).toBe(7);
    const countCall = firstCall(sink.countCalls);
    const countArgs = asRecord(countCall.args);
    expect(countArgs.exact).toBe(true);
    const countFilter = asRecord(countArgs.filter);
    const countMust = asArray(countFilter.must);
    const countKeys = countMust.map((entry) => asRecord(entry).key);
    expect(getStringArray(countKeys)).toContain("userId");
    expect(getStringArray(countKeys)).toContain("tags");
    const deleteCall = firstCall(sink.deleteCalls);
    const args = asRecord(deleteCall.args);
    const filter = asRecord(args.filter);
    const must = asArray(filter.must);
    const keys = must.map((entry) => asRecord(entry).key);
    expect(getStringArray(keys)).toContain("userId");
    expect(getStringArray(keys)).toContain("tags");
  });
});

describe("QdrantStore.probe", () => {
  it("resolves on getCollections success", async () => {
    const { client } = makeFakeClient();
    const store = new QdrantStore(makeTestConfig(), client);
    await expect(store.probe(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("maps a getCollections failure to UPSTREAM_ERROR", async () => {
    const { client } = makeFakeClient({
      async getCollectionsImpl() {
        await Promise.resolve();
        throw new Error("boom");
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    await expect(store.probe(new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });

  it("aborts via the supplied signal even when the client stays pending", async () => {
    const { client } = makeFakeClient({
      async getCollectionsImpl() {
        // Returns a never-resolving promise so the probe's abort path can
        // run. Using `await Promise.resolve()` first satisfies the
        // `require-await` rule without burning a real microtask.
        await Promise.resolve();
        return new Promise<Schemas["CollectionsResponse"]>(neverResolveExecutor);
      },
    });
    const store = new QdrantStore(makeTestConfig(), client);
    const controller = new AbortController();
    const probe = store.probe(controller.signal);
    controller.abort();
    await expect(probe).rejects.toMatchObject({ code: ErrorCode.TIMEOUT });
  });
});
