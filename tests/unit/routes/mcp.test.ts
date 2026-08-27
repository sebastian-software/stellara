import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";
import type {
  FirecrawlCrawlResult,
  FirecrawlScrapeResult,
} from "../../../src/services/firecrawl.js";
import type { MemoryListPage, MemoryPoint, MemorySearchHit } from "../../../src/services/qdrant.js";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A, TEST_TOKEN_USER_B } from "../helpers/test-config.js";

const USER_A_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN_USER_A}`,
  accept: "application/json",
  "content-type": "application/json",
  host: "stellara.example.test",
  "x-forwarded-proto": "https",
};
const USER_B_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN_USER_B}`,
  accept: "application/json",
  "content-type": "application/json",
  host: "stellara.example.test",
  "x-forwarded-proto": "https",
};
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: null | number | string;
  method: string;
  params?: unknown;
};

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: null | number | string;
  result: T;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: null | number | string;
  error: { code: number; message: string; data?: unknown };
};

type JsonRpcResponse<T> = JsonRpcFailure | JsonRpcSuccess<T>;

function expectFailure<T>(body: JsonRpcResponse<T>): JsonRpcFailure {
  if (!("error" in body)) {
    throw new Error("Expected a JSON-RPC failure envelope, got a success envelope");
  }
  return body;
}

/**
 * Narrows the `data` payload of a JSON-RPC error envelope onto an array of
 * issue records. Keeps the leak-test free of inline type casts that would
 * trip `@typescript-eslint/no-unsafe-type-assertion`.
 */
function extractIssueRecords(data: unknown): ReadonlyArray<Record<string, unknown>> {
  if (typeof data !== "object" || data === null || !("issues" in data)) {
    throw new TypeError("Expected error.data.issues to be present");
  }
  const { issues } = data;
  if (!Array.isArray(issues)) {
    throw new TypeError("Expected error.data.issues to be an array");
  }
  return issues as ReadonlyArray<Record<string, unknown>>;
}

/**
 * MCP annotations shape mirrored from the source `ToolAnnotations`
 * type. Local to the test file because we deliberately exercise the
 * wire format (post JSON round-trip), not the TypeScript source type.
 */
type WireToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
};

/**
 * Issues a `tools/list` call and returns a `name → annotations` map.
 * Throws if any tool is missing its annotations entry, so callers can
 * compare against the spec without per-test optional-chain noise.
 */
async function fetchToolAnnotationsByName(
  app: FastifyInstance,
): Promise<Map<string, WireToolAnnotations>> {
  const response = await app.inject(jsonRpcCall("tools/list", {}));
  const body =
    response.json<
      JsonRpcSuccess<{ tools: Array<{ name: string; annotations?: WireToolAnnotations }> }>
    >();
  const result = new Map<string, WireToolAnnotations>();
  for (const tool of body.result.tools) {
    const annotations = tool.annotations;
    if (annotations === undefined) {
      throw new Error(`Tool "${tool.name}" is missing the expected annotations envelope`);
    }
    result.set(tool.name, annotations);
  }
  return result;
}

/** Wrap a JSON-RPC payload in a Fastify inject() shape with auth headers. */
function jsonRpcCall(
  method: string,
  params: unknown,
  options: { headers?: Record<string, string>; id?: null | number | string } = {},
): { headers: Record<string, string>; method: "POST"; payload: JsonRpcRequest; url: string } {
  const body: JsonRpcRequest = { jsonrpc: "2.0", id: options.id ?? 1, method };
  if (params !== undefined) {
    body.params = params;
  }
  return {
    method: "POST",
    url: "/mcp",
    headers: options.headers ?? USER_A_HEADERS,
    payload: body,
  };
}

describe("POST /mcp — initialize", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns serverInfo and tools capability, echoing the protocolVersion", async () => {
    const app = await buildApp(makeTestConfig({ APP_VERSION: "9.9.9" }));
    try {
      const response = await app.inject(
        jsonRpcCall("initialize", { protocolVersion: "2024-11-05" }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          protocolVersion: string;
          capabilities: { tools: unknown };
          serverInfo: { name: string; version: string };
          instructions: string;
        }>
      >();
      expect(body.result.protocolVersion).toBe("2024-11-05");
      expect(body.result.capabilities).toStrictEqual({ tools: {} });
      expect(body.result.serverInfo).toStrictEqual({ name: "stellara", version: "9.9.9" });
    } finally {
      await app.close();
    }
  });

  it("emits the tool-suite overview as `instructions` (plan 0011)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(jsonRpcCall("initialize", {}));
      const body = response.json<JsonRpcSuccess<{ instructions: string }>>();
      const instructions = body.result.instructions;
      expect(typeof instructions).toBe("string");
      expect(instructions.length).toBeGreaterThanOrEqual(500);
      // Marker check (no fragile wording assertions).
      expect(instructions).toContain("tool families");
      expect(instructions).toContain("web_scrape");
      expect(instructions).toContain("browser_");
      expect(instructions).toContain("memory_");
    } finally {
      await app.close();
    }
  });

  it.each(LEGACY_PROTOCOL_VERSIONS)(
    "preserves initialize, notification, catalog and tool-call semantics for %s",
    async (version) => {
      const app = await buildApp(makeTestConfig());
      const hit: ExaSearchResult = {
        title: `Result for ${version}`,
        url: "https://example.org/legacy",
        snippet: "Legacy result",
      };
      vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
      try {
        const initialized = await app.inject(
          jsonRpcCall("initialize", { protocolVersion: version }),
        );
        const notification = await app.inject({
          method: "POST",
          url: "/mcp",
          headers: USER_A_HEADERS,
          payload: { jsonrpc: "2.0", method: "notifications/initialized" },
        });
        const catalog = await app.inject(jsonRpcCall("tools/list", {}));
        const called = await app.inject(
          jsonRpcCall("tools/call", {
            name: "web_search",
            arguments: { query: `legacy ${version}` },
          }),
        );

        expect(initialized.statusCode).toBe(200);
        expect(
          initialized.json<JsonRpcSuccess<{ protocolVersion: string }>>().result.protocolVersion,
        ).toBe(version);
        expect(notification.statusCode).toBe(202);
        expect(notification.payload).toBe("");
        expect(
          catalog
            .json<JsonRpcSuccess<{ tools: Array<{ name: string }> }>>()
            .result.tools.some((tool) => tool.name === "web_search"),
        ).toBe(true);
        expect(
          called.json<JsonRpcSuccess<{ structuredContent: { results: ExaSearchResult[] } }>>()
            .result.structuredContent,
        ).toStrictEqual({ results: [hit] });
      } finally {
        await app.close();
      }
    },
  );
});

describe("POST /mcp — tools/list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the canonical MCP tools with their input JSON schemas", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(jsonRpcCall("tools/list", {}));
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          tools: Array<{
            name: string;
            description: string;
            inputSchema: { type?: string };
          }>;
        }>
      >();
      const names = body.result.tools.map((tool) => tool.name);
      expect(names).toStrictEqual([
        "web_search",
        "web_scrape",
        "web_crawl",
        "web_research",
        "memory_upsert",
        "memory_search",
        "memory_list",
        "memory_delete",
        "web_map",
        "web_extract",
        "web_crawl_start",
        "web_crawl_status",
        "web_fetch",
        "web_get",
        "web_graphql",
        "web_graphql_query",
        "browser_session_start",
        "browser_session_stop",
        "browser_navigate",
        "browser_interact",
        "browser_screenshot",
        "browser_content",
        "browser_eval",
        "browser_pdf",
        "browser_cookies",
        "browser_storage",
        "browser_har",
        "browser_tabs",
        "domain_availability",
      ]);
      for (const tool of body.result.tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.inputSchema).toBeDefined();
      }
    } finally {
      await app.close();
    }
  });

  it("each tool input schema is an object at the root (MCP spec requirement)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(jsonRpcCall("tools/list", {}));
      const body = response.json<
        JsonRpcSuccess<{
          tools: Array<{ name: string; inputSchema: { type?: string } }>;
        }>
      >();
      // MCP's `Tool.inputSchema` must be a top-level object. `memory_delete`
      // uses a dedicated `mcpMemoryDeleteRequestSchema` (single object with
      // both fields optional + XOR refine) so it satisfies this constraint
      // without surfacing as `anyOf`.
      const types = body.result.tools.map((tool) => tool.inputSchema.type);
      expect(types.every((type) => type === "object")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("each tool carries a multi-sentence description (plan 0011)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(jsonRpcCall("tools/list", {}));
      const body =
        response.json<JsonRpcSuccess<{ tools: Array<{ name: string; description: string }> }>>();
      for (const tool of body.result.tools) {
        expect(tool.description.length).toBeGreaterThanOrEqual(100);
      }
    } finally {
      await app.close();
    }
  });

  it("annotates one tool per family with the expected MCP hints (plan 0011)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const byName = await fetchToolAnnotationsByName(app);
      // Spot-check one tool per family to pin the annotation contract.
      expect(byName.get("web_search")?.readOnlyHint).toBe(true);
      expect(byName.get("web_search")?.openWorldHint).toBe(true);
      expect(byName.get("memory_delete")?.destructiveHint).toBe(true);
      expect(byName.get("memory_upsert")?.idempotentHint).toBe(true);
      expect(byName.get("browser_session_start")?.openWorldHint).toBe(true);
      expect(byName.get("browser_eval")?.destructiveHint).toBe(true);
      // The read-only HTTP siblings (plan 0014) must honestly carry
      // `readOnlyHint` — that is the whole point of splitting them off
      // from the write-capable `web_fetch`/`web_graphql`.
      expect(byName.get("web_get")?.readOnlyHint).toBe(true);
      expect(byName.get("web_graphql_query")?.readOnlyHint).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("emits a non-empty annotations object for every tool (plan 0011)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const byName = await fetchToolAnnotationsByName(app);
      const sizes = Array.from(byName.values(), (annotations) => Object.keys(annotations).length);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.min(...sizes)).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("hides tools whose feature is disabled", async () => {
    // Drop every optional credential so only Firecrawl-backed tools remain.
    const app = await buildApp(
      makeTestConfig({
        EXA_API_KEY: "",
        QDRANT_BASE_URL: "",
        QDRANT_API_KEY: "",
        EMBEDDINGS_API_KEY: "",
      }),
    );
    try {
      const response = await app.inject(jsonRpcCall("tools/list", {}));
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcSuccess<{ tools: Array<{ name: string }> }>>();
      const names = body.result.tools.map((t) => t.name);
      expect(names).toStrictEqual([
        "web_scrape",
        "web_crawl",
        "web_map",
        "web_extract",
        "web_crawl_start",
        "web_crawl_status",
        "web_fetch",
        "web_get",
        "web_graphql",
        "web_graphql_query",
        "browser_session_start",
        "browser_session_stop",
        "browser_navigate",
        "browser_interact",
        "browser_screenshot",
        "browser_content",
        "browser_eval",
        "browser_pdf",
        "browser_cookies",
        "browser_storage",
        "browser_har",
        "browser_tabs",
        "domain_availability",
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns structurally identical payloads for consecutive invocations (cached)", async () => {
    // `MCP_TOOLS` is static, so re-computing `inputJsonSchema` per request
    // wastes Zod→JSON-Schema cycles. The dispatcher materializes the payload
    // once at module load and returns it verbatim — this test pins that
    // behavior by asserting two successive responses are byte-identical.
    const app = await buildApp(makeTestConfig());
    try {
      const first = await app.inject(jsonRpcCall("tools/list", {}));
      const second = await app.inject(jsonRpcCall("tools/list", {}));
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.payload).toBe(second.payload);
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the same Exa service and returns the structured result", async () => {
    const app = await buildApp(makeTestConfig());
    const hit: ExaSearchResult = {
      title: "Result",
      url: "https://example.org/x",
      snippet: "snippet",
      score: 0.8,
    };
    const searchSpy = vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_search",
          arguments: { query: "hello" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          content: Array<{ type: string; text: string }>;
          structuredContent: { results: ExaSearchResult[] };
        }>
      >();
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(body.result.structuredContent.results).toStrictEqual([hit]);
      // The text envelope mirrors the structured content for clients that do
      // not understand structuredContent yet.
      const [firstContent] = body.result.content;
      expect(firstContent?.type).toBe("text");
      expect(firstContent?.text).toBeDefined();
      const parsedText: unknown = JSON.parse(String(firstContent?.text));
      expect(parsedText).toStrictEqual({ results: [hit] });
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call memory_search (per-user isolation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes qdrant.search with the user id resolved from the bearer token", async () => {
    const app = await buildApp(makeTestConfig());
    vi.spyOn(app.services.embeddings!, "embed").mockResolvedValue(
      Array.from({ length: 1536 }, () => 0),
    );
    const hit: MemorySearchHit = {
      id: "memo",
      text: "hello",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      score: 0.9,
    };
    const searchSpy = vi.spyOn(app.services.qdrant!, "search").mockResolvedValue([hit]);
    try {
      await app.inject(
        jsonRpcCall(
          "tools/call",
          { name: "memory_search", arguments: { query: "first" } },
          { headers: USER_A_HEADERS },
        ),
      );
      await app.inject(
        jsonRpcCall(
          "tools/call",
          { name: "memory_search", arguments: { query: "second" } },
          { headers: USER_B_HEADERS },
        ),
      );
      expect(searchSpy).toHaveBeenCalledTimes(2);
      expect(searchSpy.mock.calls[0]?.[0]).toBe("user_a");
      expect(searchSpy.mock.calls[1]?.[0]).toBe("user_b");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_scrape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes firecrawl.scrape via tools/call web_scrape and returns the page as structuredContent", async () => {
    const app = await buildApp(makeTestConfig());
    const page: FirecrawlScrapeResult = {
      url: "https://example.org/page",
      title: "Example",
      markdown: "# Example",
    };
    const scrapeSpy = vi.spyOn(app.services.firecrawl, "scrape").mockResolvedValue(page);
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_scrape",
          arguments: { url: "https://example.org/page" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          content: Array<{ type: string; text: string }>;
          structuredContent: FirecrawlScrapeResult;
        }>
      >();
      expect(scrapeSpy).toHaveBeenCalledTimes(1);
      const call = scrapeSpy.mock.calls[0];
      // Adapter forwards `url`, schema-derived `formats` and `onlyMainContent`.
      expect(call?.[0]).toBe("https://example.org/page");
      expect(call?.[1]).toStrictEqual({ formats: ["markdown"], onlyMainContent: true });
      expect(body.result.structuredContent).toStrictEqual(page);
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_crawl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes firecrawl.crawl via tools/call web_crawl and returns the result as structuredContent", async () => {
    const app = await buildApp(makeTestConfig());
    const crawlResult: FirecrawlCrawlResult = {
      status: "completed",
      jobId: "job-mcp",
      pages: [
        { url: "https://example.org/a", markdown: "# A" },
        { url: "https://example.org/b", markdown: "# B" },
      ],
      stats: { pagesScraped: 2, durationMs: 42 },
    };
    const crawlSpy = vi.spyOn(app.services.firecrawl, "crawl").mockResolvedValue(crawlResult);
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_crawl",
          arguments: { url: "https://example.org", maxDepth: 1, maxPages: 5 },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcSuccess<{ structuredContent: FirecrawlCrawlResult }>>();
      expect(crawlSpy).toHaveBeenCalledTimes(1);
      const call = crawlSpy.mock.calls[0];
      expect(call?.[0]).toBe("https://example.org");
      // Schema defaults `includePatterns`/`excludePatterns` to `[]`; the
      // adapter forwards both alongside the explicit overrides above.
      expect(call?.[1]).toStrictEqual({
        maxDepth: 1,
        maxPages: 5,
        includePatterns: [],
        excludePatterns: [],
      });
      expect(body.result.structuredContent).toStrictEqual(crawlResult);
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_research", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes exa.search + firecrawl.scrape via tools/call web_research and returns merged sources", async () => {
    const app = await buildApp(makeTestConfig());
    const hit: ExaSearchResult = {
      title: "Example",
      url: "https://example.org/article",
      snippet: "snippet",
      score: 0.5,
    };
    const searchSpy = vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    const scrapeSpy = vi.spyOn(app.services.firecrawl, "scrape").mockResolvedValue({
      url: hit.url,
      markdown: "# Example body",
    });
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_research",
          arguments: { query: "hello world", maxSources: 1 },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          structuredContent: {
            query: string;
            sources: Array<{ url: string; title: string; snippet: string; content?: string }>;
          };
        }>
      >();
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(searchSpy.mock.calls[0]?.[0]).toBe("hello world");
      expect(scrapeSpy).toHaveBeenCalledTimes(1);
      expect(scrapeSpy.mock.calls[0]?.[0]).toBe(hit.url);
      expect(body.result.structuredContent).toStrictEqual({
        query: "hello world",
        sources: [
          {
            url: hit.url,
            title: hit.title,
            snippet: hit.snippet,
            content: "# Example body",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call memory_upsert (per-user isolation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes qdrant.upsert with the user id from the bearer token and returns the upserted id", async () => {
    const app = await buildApp(makeTestConfig());
    const vector = Array.from({ length: 1536 }, () => 0);
    const embedSpy = vi.spyOn(app.services.embeddings!, "embed").mockResolvedValue(vector);
    const upsertSpy = vi.spyOn(app.services.qdrant!, "upsert").mockResolvedValue();
    const callerId = "550e8400-e29b-41d4-a716-446655440000";
    try {
      const response = await app.inject(
        jsonRpcCall(
          "tools/call",
          {
            name: "memory_upsert",
            arguments: { id: callerId, text: "remember me", tags: ["work"] },
          },
          { headers: USER_B_HEADERS },
        ),
      );
      expect(response.statusCode).toBe(200);
      const body =
        response.json<JsonRpcSuccess<{ structuredContent: { id: string; status: "upserted" } }>>();
      expect(embedSpy).toHaveBeenCalledTimes(1);
      expect(embedSpy.mock.calls[0]?.[0]).toBe("remember me");
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      const call = upsertSpy.mock.calls[0];
      // Per-user isolation: the bearer token resolves to `user_b`.
      expect(call?.[0]).toBe("user_b");
      expect(call?.[1]).toMatchObject({
        id: callerId,
        text: "remember me",
        tags: ["work"],
        vector,
      });
      expect(body.result.structuredContent).toStrictEqual({
        id: callerId,
        status: "upserted",
      });
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call memory_list (per-user isolation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes qdrant.list with the user id and returns items plus nextCursor", async () => {
    const app = await buildApp(makeTestConfig());
    const item: MemoryPoint = {
      id: "memo-1",
      text: "note",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    };
    const page: MemoryListPage = { items: [item], nextCursor: "opaque-cursor" };
    const listSpy = vi.spyOn(app.services.qdrant!, "list").mockResolvedValue(page);
    try {
      const response = await app.inject(
        jsonRpcCall(
          "tools/call",
          { name: "memory_list", arguments: { limit: 5 } },
          { headers: USER_A_HEADERS },
        ),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          structuredContent: { items: MemoryPoint[]; nextCursor: null | string };
        }>
      >();
      expect(listSpy).toHaveBeenCalledTimes(1);
      const call = listSpy.mock.calls[0];
      expect(call?.[0]).toBe("user_a");
      expect(call?.[1]).toMatchObject({ limit: 5 });
      expect(body.result.structuredContent).toStrictEqual({
        items: [item],
        nextCursor: "opaque-cursor",
      });
    } finally {
      await app.close();
    }
  });

  it("propagates a null nextCursor through the structuredContent envelope", async () => {
    const app = await buildApp(makeTestConfig());
    // The wrapper reports `nextCursor: null` for the final page; the MCP
    // adapter passes it through unchanged so the envelope matches REST.
    vi.spyOn(app.services.qdrant!, "list").mockResolvedValue({ items: [], nextCursor: null });
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", { name: "memory_list", arguments: {} }),
      );
      const body =
        response.json<JsonRpcSuccess<{ structuredContent: { nextCursor: null | string } }>>();
      expect(body.result.structuredContent.nextCursor).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call memory_delete (per-user isolation)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes qdrant.delete by id when arguments carry only `id` and returns the affected count", async () => {
    const app = await buildApp(makeTestConfig());
    const deleteSpy = vi.spyOn(app.services.qdrant!, "delete").mockResolvedValue(1);
    const targetId = "550e8400-e29b-41d4-a716-446655440000";
    try {
      const response = await app.inject(
        jsonRpcCall(
          "tools/call",
          { name: "memory_delete", arguments: { id: targetId } },
          { headers: USER_A_HEADERS },
        ),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcSuccess<{ structuredContent: { deleted: number } }>>();
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      const call = deleteSpy.mock.calls[0];
      expect(call?.[0]).toBe("user_a");
      // R-0000009 made the adapter branch on which field is set; the id
      // variant must reach `qdrant.delete` as `{ id }` (no filter key).
      expect(call?.[1]).toStrictEqual({ id: targetId });
      expect(body.result.structuredContent).toStrictEqual({ deleted: 1 });
    } finally {
      await app.close();
    }
  });

  it("invokes qdrant.delete by filter when arguments carry only `filter` and returns the affected count", async () => {
    const app = await buildApp(makeTestConfig());
    const deleteSpy = vi.spyOn(app.services.qdrant!, "delete").mockResolvedValue(3);
    try {
      const response = await app.inject(
        jsonRpcCall(
          "tools/call",
          { name: "memory_delete", arguments: { filter: { tags: ["work"] } } },
          { headers: USER_B_HEADERS },
        ),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcSuccess<{ structuredContent: { deleted: number } }>>();
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      const call = deleteSpy.mock.calls[0];
      // Per-user isolation: the bearer token resolves to `user_b`.
      expect(call?.[0]).toBe("user_b");
      expect(call?.[1]).toStrictEqual({ filter: { tags: ["work"] } });
      expect(body.result.structuredContent).toStrictEqual({ deleted: 3 });
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — JSON-RPC error envelopes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns METHOD_NOT_FOUND (-32601) for an unknown tool name", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", { name: "no_such_tool", arguments: {} }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });

  it("returns METHOD_NOT_FOUND for a tool whose feature is deactivated", async () => {
    // `web_search` belongs to the Exa feature; dropping EXA_API_KEY should
    // make the tool invisible to both `tools/list` and `tools/call` so the
    // failure mode is identical to "unknown tool".
    const app = await buildApp(makeTestConfig({ EXA_API_KEY: "" }));
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", { name: "web_search", arguments: { query: "x" } }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });

  it("returns INVALID_PARAMS (-32602) when tool arguments fail Zod validation", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      // `web_search` requires `query`; sending an empty arguments object trips
      // the schema and the dispatcher returns -32602.
      const response = await app.inject(
        jsonRpcCall("tools/call", { name: "web_search", arguments: {} }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_602);
    } finally {
      await app.close();
    }
  });

  it("does not echo secret argument values back through INVALID_PARAMS issues", async () => {
    // Regression guard: Zod v4 issues include an `input` field (the value
    // that failed validation) — for `invalid_type` / `invalid_value` issues
    // that means the caller's raw value lands in the issue payload. If the
    // caller accidentally placed a secret in a still-invalid field we must
    // strip it before the envelope leaves the gateway. Here `id` must be a
    // UUID v4; we pass the secret directly so Zod's issue carries it as
    // `input`, and assert it never reaches the response payload.
    const app = await buildApp(makeTestConfig());
    const secret = "SECRET_FOO_42";
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "memory_upsert",
          arguments: { id: secret, text: "anything" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_602);
      // The serialized envelope must not carry the secret in any form —
      // neither as the failing `id` field nor inside the issue list.
      expect(response.payload).not.toContain(secret);
      // Each sanitized issue keeps only `path`, `code`, and `message`. We
      // collect the issue keys instead of iterating with a conditional so
      // the assertion stays a single expectation per forbidden field.
      const issues = extractIssueRecords(failure.error.data);
      expect(issues.length).toBeGreaterThan(0);
      const issueKeys = issues.flatMap((issue) => Object.keys(issue));
      expect(issueKeys).not.toContain("input");
      expect(issueKeys).not.toContain("received");
      expect(issueKeys).not.toContain("values");
    } finally {
      await app.close();
    }
  });

  it("returns post-validation execution failures as an isError tool result", async () => {
    const app = await buildApp(makeTestConfig());
    vi.spyOn(app.services.exa!, "search").mockRejectedValue(new Error("SECRET_UPSTREAM_HOST"));
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", { name: "web_search", arguments: { query: "hello" } }),
      );
      const body =
        response.json<JsonRpcSuccess<{ content: Array<{ text: string }>; isError: boolean }>>();
      expect(response.statusCode).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("UPSTREAM_ERROR");
      expect(response.payload).not.toContain("SECRET_UPSTREAM_HOST");
    } finally {
      await app.close();
    }
  });

  it("returns PARSE_ERROR (-32700) with id=null for non-JSON bodies", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: USER_A_HEADERS,
        payload: "{not json",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.id).toBeNull();
      expect(failure.error.code).toBe(-32_700);
    } finally {
      await app.close();
    }
  });

  it("returns METHOD_NOT_FOUND (-32601) for an unknown JSON-RPC method", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(jsonRpcCall("unknown/method", {}));
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });
});

describe("GET /mcp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 405 with allow: POST and the §16.1 error envelope", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "GET",
        url: "/mcp",
        headers: USER_A_HEADERS,
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      const body = response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("GET /mcp");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — auth gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requests without a bearer token with 401 UNAUTHORIZED", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — initialize protocol-version negotiation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the server's default protocolVersion when the requested one is unsupported", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(
        jsonRpcCall("initialize", { protocolVersion: "1999-01-01" }),
      );
      const body = response.json<JsonRpcSuccess<{ protocolVersion: string }>>();
      // 2025-11-25 is currently the newest supported version — see
      // `SUPPORTED_PROTOCOL_VERSIONS` in `src/routes/mcp-dispatch.ts`.
      expect(body.result.protocolVersion).toBe("2025-11-25");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 202 with no body for a JSON-RPC notification (missing id)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: USER_A_HEADERS,
        // No `id` field → JSON-RPC 2.0 §4.1 notification.
        payload: { jsonrpc: "2.0", method: "tools/list" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.payload).toBe("");
    } finally {
      await app.close();
    }
  });

  it("drops notifications/initialized (202, empty body) — never dispatches as tool call", async () => {
    // Validates the drop policy documented in the mcp.ts notification branch:
    // all notifications are silently accepted without side effects. If a future
    // Phase-3 extension were to forget to update that branch, this test would
    // still pass — but it ensures the HTTP contract (202, no body) holds for
    // the most common MCP lifecycle notification.
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: USER_A_HEADERS,
        // `notifications/initialized` has no `id` → JSON-RPC notification.
        payload: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      expect(response.statusCode).toBe(202);
      expect(response.payload).toBe("");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — INVALID_REQUEST envelopes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns INVALID_REQUEST (-32600) when the envelope is missing `jsonrpc`", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: USER_A_HEADERS,
        payload: { id: 1, method: "tools/list" },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.id).toBe(1);
      expect(failure.error.code).toBe(-32_600);
    } finally {
      await app.close();
    }
  });

  it("returns INVALID_REQUEST (-32600) for a body that exceeds the 1 MB limit", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      // The default body limit is 1 MB (`DEFAULT_BODY_LIMIT` in server.ts);
      // a 2 MB payload trips Fastify's 413 handler, which the route-local
      // error handler maps onto a JSON-RPC envelope.
      const huge = "x".repeat(2 * 1024 * 1024);
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: USER_A_HEADERS,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding: huge } },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_600);
    } finally {
      await app.close();
    }
  });
});

describe("GET /mcp — auth gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unauthenticated GET requests with 401 before reaching the 405 handler", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/mcp" });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });
});

describe("/openapi.json — /mcp is hidden from the spec", () => {
  it("does not list /mcp in paths (concept §20)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<{ paths: Record<string, unknown> }>();
      expect(Object.keys(body.paths)).not.toContain("/mcp");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes runWebFetch via tools/call and returns the result as structuredContent", async () => {
    const app = await buildApp(makeTestConfig());
    // Stub at the service layer so the HTTP fetch does not go out.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_fetch",
          arguments: {
            url: "https://example.com/api",
            method: "GET",
            responseFormat: "json",
          },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          structuredContent: { status: number; format: string };
        }>
      >();
      expect(body.result.structuredContent.status).toBe(200);
      expect(body.result.structuredContent.format).toBe("json");
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/call web_graphql", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes runWebGraphql via tools/call and returns GraphQL data as structuredContent", async () => {
    const app = await buildApp(makeTestConfig());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"data":{"ping":"pong"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_graphql",
          arguments: {
            endpoint: "https://api.example.com/graphql",
            query: "{ ping }",
          },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<
        JsonRpcSuccess<{
          structuredContent: { status: number; data: unknown };
        }>
      >();
      expect(body.result.structuredContent.status).toBe(200);
      expect(body.result.structuredContent.data).toStrictEqual({ ping: "pong" });
    } finally {
      await app.close();
    }
  });
});

describe("POST /mcp — tools/list with STELLARA_FETCH_ENABLED=false", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides web_fetch, web_graphql and their read-only siblings when the fetch feature is disabled", async () => {
    const app = await buildApp(makeTestConfig({ STELLARA_FETCH_ENABLED: "false" }));
    try {
      const response = await app.inject(jsonRpcCall("tools/list", {}));
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcSuccess<{ tools: Array<{ name: string }> }>>();
      const names = body.result.tools.map((t) => t.name);
      expect(names).not.toContain("web_fetch");
      expect(names).not.toContain("web_graphql");
      // The read-only siblings share the same `fetch` gate (plan 0014).
      expect(names).not.toContain("web_get");
      expect(names).not.toContain("web_graphql_query");
    } finally {
      await app.close();
    }
  });

  it("returns METHOD_NOT_FOUND for web_fetch tools/call when fetch is disabled", async () => {
    const app = await buildApp(makeTestConfig({ STELLARA_FETCH_ENABLED: "false" }));
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_fetch",
          arguments: { url: "https://example.com/api" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });

  it("returns METHOD_NOT_FOUND for web_get tools/call when fetch is disabled", async () => {
    const app = await buildApp(makeTestConfig({ STELLARA_FETCH_ENABLED: "false" }));
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_get",
          arguments: { url: "https://example.com/api" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });

  it("returns METHOD_NOT_FOUND for web_graphql_query tools/call when fetch is disabled", async () => {
    const app = await buildApp(makeTestConfig({ STELLARA_FETCH_ENABLED: "false" }));
    try {
      const response = await app.inject(
        jsonRpcCall("tools/call", {
          name: "web_graphql_query",
          arguments: { endpoint: "https://api.example.com/graphql", query: "{ ping }" },
        }),
      );
      expect(response.statusCode).toBe(200);
      const body = response.json<JsonRpcResponse<unknown>>();
      const failure = expectFailure(body);
      expect(failure.error.code).toBe(-32_601);
    } finally {
      await app.close();
    }
  });
});
