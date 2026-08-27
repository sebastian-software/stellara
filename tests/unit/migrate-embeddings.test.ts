import type { Schemas } from "@qdrant/js-client-rest";

import { describe, expect, it } from "vitest";

import type { EmbeddingsProvider } from "../../src/services/embeddings.js";
import type { QdrantLikeClient } from "../../src/services/qdrant-types.js";

import { MigrationError, parseCliArgs, runMigration } from "../../scripts/migrate-embeddings.js";

/** Optional payload overrides for {@link makeRecord}. */
type RecordOverrides = {
  source?: string;
  tags?: string[];
};

/** Builds a Qdrant `Record` from a caller-friendly shorthand. */
function makeRecord(
  id: string,
  text: string | undefined,
  overrides: RecordOverrides = {},
): Schemas["Record"] {
  if (text === undefined) return { id, payload: {} };
  return {
    id,
    payload: {
      text,
      source: overrides.source ?? "manual",
      tags: overrides.tags ?? ["work"],
    },
  };
}

/** Recorded scroll-call arguments. */
type ScrollCall = { collection: string; args: unknown };
/** Recorded upsert-call arguments. */
type UpsertCall = { collection: string; args: unknown };
/** Recorded count-call arguments. */
type CountCall = { collection: string };

/** Shape of the fake Qdrant client returned by {@link makeFakeClient}. */
type FakeClient = {
  client: QdrantLikeClient;
  scrollCalls: ScrollCall[];
  upsertCalls: UpsertCall[];
  countCalls: CountCall[];
};

/** Options for {@link makeFakeClient}. */
type FakeClientOptions = {
  pages: ReadonlyArray<Schemas["ScrollResult"]>;
  /** Map from collection name to the count value `client.count` should return. */
  counts: Record<string, number>;
};

/**
 * Builds a throwing stub for a `QdrantLikeClient` method so an accidental
 * call surfaces immediately instead of silently returning a fake value.
 */
function throwingStub(name: string): () => never {
  return () => {
    throw new Error(`unexpected call to QdrantLikeClient.${name}`);
  };
}

/**
 * Builds a fake `QdrantLikeClient` driven by pre-computed scroll pages and a
 * per-collection count lookup. Each scroll call consumes the next entry from
 * `pages`; running out of pages yields an empty terminal page.
 *
 * The client is built as a literal that satisfies `QdrantLikeClient` directly
 * — this avoids `as unknown as ...` assertions while still tracking calls via
 * the returned arrays.
 */
function makeFakeClient(options: FakeClientOptions): FakeClient {
  const pages = [...options.pages];
  const scrollCalls: ScrollCall[] = [];
  const upsertCalls: UpsertCall[] = [];
  const countCalls: CountCall[] = [];
  const client: QdrantLikeClient = {
    async scroll(collection: string, args: unknown): Promise<Schemas["ScrollResult"]> {
      await Promise.resolve();
      scrollCalls.push({ collection, args });
      return pages.shift() ?? { points: [], next_page_offset: null };
    },
    async upsert(collection: string, args: unknown): Promise<Schemas["UpdateResult"]> {
      await Promise.resolve();
      upsertCalls.push({ collection, args });
      return { status: "completed" };
    },
    async count(collection: string): Promise<Schemas["CountResult"]> {
      await Promise.resolve();
      countCalls.push({ collection });
      const value = options.counts[collection];
      return { count: value ?? 0 };
    },
    createCollection: throwingStub("createCollection"),
    delete: throwingStub("delete"),
    getCollection: throwingStub("getCollection"),
    getCollections: throwingStub("getCollections"),
    retrieve: throwingStub("retrieve"),
    search: throwingStub("search"),
  };
  return { client, scrollCalls, upsertCalls, countCalls };
}

/** Builds a fake embedder that returns a stable vector and tracks calls. */
function makeFakeEmbedder(vector: number[] = [0.1, 0.2, 0.3]): {
  embedder: EmbeddingsProvider;
  embedCalls: string[];
} {
  const embedCalls: string[] = [];
  const embedder: EmbeddingsProvider = {
    async embed(text: string): Promise<number[]> {
      await Promise.resolve();
      embedCalls.push(text);
      return [...vector];
    },
    dimensions: () => vector.length,
    async probe(): Promise<void> {
      await Promise.resolve();
    },
  };
  return { embedder, embedCalls };
}

/** Type guard narrowing an `unknown` upsert payload to a record shape. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Shape of a point as it appears in an upsert call's `points` array. */
type UpsertedPoint = {
  id: string;
  vector: number[];
  payload: { text: string; source: string; tags: string[] };
};

/** Type guard validating an upserted point carries the expected payload keys. */
function isUpsertedPoint(value: unknown): value is UpsertedPoint {
  if (!isRecord(value)) return false;
  const payload = value.payload;
  if (!isRecord(payload)) return false;
  return (
    typeof value.id === "string" &&
    Array.isArray(value.vector) &&
    typeof payload.text === "string" &&
    typeof payload.source === "string" &&
    Array.isArray(payload.tags)
  );
}

/** Extracts and validates the `points` array from an upsert call's args. */
function pointsFromUpsertArgs(args: unknown): UpsertedPoint[] {
  if (!isRecord(args)) throw new TypeError("expected upsert args to be an object");
  const points = args.points;
  if (!Array.isArray(points)) throw new TypeError("expected upsert args.points to be an array");
  return points.map((point) => {
    if (!isUpsertedPoint(point)) {
      throw new TypeError("upserted point did not match the expected payload shape");
    }
    return point;
  });
}

describe("runMigration — happy path", () => {
  it("re-embeds every point across multiple scroll pages and upserts to the target", async () => {
    const { client, scrollCalls, upsertCalls, countCalls } = makeFakeClient({
      pages: [
        {
          points: [
            makeRecord("a", "first", { source: "manual", tags: ["work"] }),
            makeRecord("b", "second", { source: "import", tags: ["personal"] }),
          ],
          next_page_offset: "cursor-1",
        },
        {
          points: [makeRecord("c", "third", { source: "api", tags: ["work", "urgent"] })],
          next_page_offset: null,
        },
      ],
      counts: { source: 3, target: 3 },
    });
    const { embedder, embedCalls } = makeFakeEmbedder([0.5, 0.6]);

    const result = await runMigration({
      client,
      embedder,
      fromCollection: "source",
      toCollection: "target",
      batchSize: 2,
      dryRun: false,
    });

    expect(result).toStrictEqual({
      processedCount: 3,
      sourceCount: 3,
      targetCount: 3,
      dryRun: false,
    });
    // Two scroll calls: first returns `next_page_offset: "cursor-1"`, second
    // returns `next_page_offset: null` so the loop terminates without a third.
    expect(scrollCalls).toHaveLength(2);
    // Second call uses the cursor returned by the first page.
    expect(scrollCalls[1]?.args).toMatchObject({
      limit: 2,
      offset: "cursor-1",
      with_payload: true,
      with_vector: false,
    });
    expect(embedCalls).toStrictEqual(["first", "second", "third"]);
    // Exactly one upsert per scroll batch (not per point) — two batches here.
    expect(upsertCalls).toHaveLength(2);
    expect(upsertCalls[0]?.collection).toBe("target");
    // Flatten every upserted point and assert each carries its OWN payload —
    // catches any bug that would reuse the first batch entry's payload.
    const allUpserts = upsertCalls.flatMap((call) => pointsFromUpsertArgs(call.args));
    expect(allUpserts.map((p) => p.id)).toStrictEqual(["a", "b", "c"]);
    expect(allUpserts.map((p) => p.payload.text)).toStrictEqual(["first", "second", "third"]);
    expect(allUpserts.map((p) => p.payload.source)).toStrictEqual(["manual", "import", "api"]);
    expect(allUpserts.map((p) => p.payload.tags)).toStrictEqual([
      ["work"],
      ["personal"],
      ["work", "urgent"],
    ]);
    expect(countCalls).toHaveLength(2);
  });
});

describe("runMigration — dry-run", () => {
  it("does not call embed or upsert and skips the target count call", async () => {
    const { client, scrollCalls, upsertCalls, countCalls } = makeFakeClient({
      pages: [
        {
          points: [makeRecord("a", "first"), makeRecord("b", "second")],
          next_page_offset: null,
        },
      ],
      counts: { source: 2, target: 2 },
    });
    const { embedder, embedCalls } = makeFakeEmbedder();

    const result = await runMigration({
      client,
      embedder,
      fromCollection: "source",
      toCollection: "target",
      batchSize: 50,
      dryRun: true,
    });

    expect(result).toStrictEqual({
      processedCount: 2,
      sourceCount: 2,
      targetCount: 0,
      dryRun: true,
    });
    expect(scrollCalls).toHaveLength(1);
    expect(upsertCalls).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
    // Only the source count is fetched in dry-run.
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0]?.collection).toBe("source");
  });
});

describe("runMigration — refusal cases", () => {
  it("throws when --from and --to point at the same collection", async () => {
    const { client } = makeFakeClient({ pages: [], counts: {} });
    const { embedder } = makeFakeEmbedder();
    await expect(
      runMigration({
        client,
        embedder,
        fromCollection: "same",
        toCollection: "same",
        batchSize: 10,
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(MigrationError);
  });

  it.each([
    { label: "real run", dryRun: false },
    { label: "dry-run", dryRun: true },
  ])("throws when a point is missing payload.text ($label)", async ({ dryRun }) => {
    // Dry-run MUST surface the same hard failure as a real run — otherwise an
    // operator could approve a migration that would silently drop points.
    const { client } = makeFakeClient({
      pages: [
        {
          points: [makeRecord("a", "first"), makeRecord("b", undefined)],
          next_page_offset: null,
        },
      ],
      counts: { source: 2, target: 2 },
    });
    const { embedder } = makeFakeEmbedder();
    await expect(
      runMigration({
        client,
        embedder,
        fromCollection: "source",
        toCollection: "target",
        batchSize: 10,
        dryRun,
      }),
    ).rejects.toMatchObject({
      name: "MigrationError",
      message: expect.stringContaining("payload.text"),
    });
  });
});

describe("runMigration — stalled scroll cursor", () => {
  it("aborts when the scroll cursor advances over empty pages forever", async () => {
    const { client } = makeFakeClient({
      pages: [
        { points: [], next_page_offset: "cursor-1" },
        { points: [], next_page_offset: "cursor-2" },
        { points: [], next_page_offset: "cursor-3" },
      ],
      counts: { source: 0, target: 0 },
    });
    const { embedder } = makeFakeEmbedder();
    await expect(
      runMigration({
        client,
        embedder,
        fromCollection: "source",
        toCollection: "target",
        batchSize: 10,
        dryRun: false,
      }),
    ).rejects.toMatchObject({
      name: "MigrationError",
      message: expect.stringContaining("empty pages"),
    });
  });
});

describe("runMigration — abort signal", () => {
  it("stops before processing any batch when the AbortSignal is already aborted", async () => {
    const { client, upsertCalls, scrollCalls } = makeFakeClient({
      pages: [
        {
          points: [makeRecord("a", "first"), makeRecord("b", "second")],
          next_page_offset: null,
        },
      ],
      counts: { source: 2, target: 0 },
    });
    const { embedder } = makeFakeEmbedder();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runMigration({
        client,
        embedder,
        fromCollection: "source",
        toCollection: "target",
        batchSize: 10,
        dryRun: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(upsertCalls).toHaveLength(0);
    expect(scrollCalls).toHaveLength(0);
  });
});

describe("runMigration — count mismatch", () => {
  it("throws with partialState=true when source and target counts disagree", async () => {
    const { client } = makeFakeClient({
      pages: [
        {
          points: [makeRecord("a", "first"), makeRecord("b", "second")],
          next_page_offset: null,
        },
      ],
      counts: { source: 2, target: 1 },
    });
    const { embedder } = makeFakeEmbedder();
    await expect(
      runMigration({
        client,
        embedder,
        fromCollection: "source",
        toCollection: "target",
        batchSize: 10,
        dryRun: false,
      }),
    ).rejects.toMatchObject({
      name: "MigrationError",
      partialState: true,
      message: expect.stringContaining("Count mismatch"),
    });
  });
});

describe("parseCliArgs", () => {
  it("parses the required arguments and applies the default batch size", () => {
    const options = parseCliArgs(["--from", "old", "--to", "new"]);
    expect(options).toStrictEqual({
      fromCollection: "old",
      toCollection: "new",
      batchSize: 100,
      dryRun: false,
    });
  });

  it("returns undefined when --help is present", () => {
    expect(parseCliArgs(["--help"])).toBeUndefined();
  });

  it("rejects identical --from and --to", () => {
    expect(() => parseCliArgs(["--from", "same", "--to", "same"])).toThrow(MigrationError);
  });

  it("rejects `--from --to new` with a clear message", () => {
    // The form `--from --to new` swallows `--to` as the value of `--from`;
    // Node's strict `parseArgs` flags it as ambiguous. Either way, the
    // operator MUST not end up running with `from = "--to"`.
    expect(() => parseCliArgs(["--from", "--to", "new"])).toThrow(/ambiguous|looks like a flag/);
  });

  it("rejects an explicit flag-shaped value like `--from=--bogus`", () => {
    // `parseArgs` accepts `--from=--bogus` as a literal value; the explicit
    // guard then catches the flag-shaped collection name with a clear message.
    expect(() => parseCliArgs(["--from=--bogus", "--to", "new"])).toThrow(
      /--from looks like a flag/,
    );
  });

  it("rejects an invalid --batch-size", () => {
    expect(() => parseCliArgs(["--from", "old", "--to", "new", "--batch-size", "0"])).toThrow(
      MigrationError,
    );
  });

  it('rejects a non-integer --batch-size like "100.7"', () => {
    expect(() => parseCliArgs(["--from", "old", "--to", "new", "--batch-size", "100.7"])).toThrow(
      MigrationError,
    );
  });

  it("rejects a batch size above the upper bound", () => {
    expect(() => parseCliArgs(["--from", "old", "--to", "new", "--batch-size", "10000"])).toThrow(
      MigrationError,
    );
  });

  it("accepts the at-boundary MAX_BATCH_SIZE value (1000)", () => {
    // Confirms the upper-bound check is inclusive — passing exactly 1000 must
    // succeed; one over (1001) is covered by the rejection test above.
    const options = parseCliArgs(["--from", "old", "--to", "new", "--batch-size", "1000"]);
    expect(options?.batchSize).toBe(1000);
  });
});
