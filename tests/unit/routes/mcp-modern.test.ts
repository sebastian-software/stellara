import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const AUTH_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN_USER_A}`,
  accept: "application/json",
  "content-type": "application/json",
  host: "stellara.example.test",
  "x-forwarded-proto": "https",
};

type ModernError = {
  jsonrpc: "2.0";
  id: null | number | string;
  error: { code: number; message: string };
};

type ModernSuccess<T> = {
  jsonrpc: "2.0";
  id: null | number | string;
  result: {
    resultType: string;
    _meta: { [SERVER_INFO_META_KEY]: { name: string; version: string } };
  } & T;
};

function requestMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
    [CAPABILITIES_META_KEY]: {},
    [CLIENT_INFO_META_KEY]: { name: "stellara-test", version: "1.0.0" },
    ...overrides,
  };
}

function modernCall(
  method: string,
  params: Record<string, unknown> = {},
  options: { headers?: Record<string, string>; meta?: Record<string, unknown> } = {},
): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  const name = typeof params.name === "string" ? params.name : undefined;
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      ...AUTH_HEADERS,
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...options.headers,
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: options.meta ?? requestMeta() },
    },
  };
}

function expectModernError(body: ModernError | ModernSuccess<unknown>): ModernError {
  if (!("error" in body)) throw new Error("Expected a modern JSON-RPC error");
  return body;
}

function firstTextContent(result: { content: Array<{ type: string; text: string }> }): unknown {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("Expected text content");
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

async function closeApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

describe("POST /mcp — MCP 2026-07-28", () => {
  afterEach(() => vi.restoreAllMocks());

  it("discovers the server without initialize and emits private cache metadata", async () => {
    const app = await buildApp(makeTestConfig({ APP_VERSION: "9.9.9" }));
    try {
      const response = await app.inject(modernCall("server/discover"));
      const body = response.json<
        ModernSuccess<{
          supportedVersions: string[];
          ttlMs: number;
          cacheScope: string;
          instructions: string;
        }>
      >();
      expect(response.statusCode).toBe(200);
      expect(body.result.supportedVersions).toStrictEqual([PROTOCOL_VERSION]);
      expect(body.result.resultType).toBe("complete");
      expect(body.result.ttlMs).toBe(300_000);
      expect(body.result.cacheScope).toBe("private");
      expect(body.result._meta[SERVER_INFO_META_KEY]).toStrictEqual({
        name: "stellara",
        version: "9.9.9",
      });
      expect(body.result.instructions).toContain("tool families");
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      await closeApp(app);
    }
  });

  it("lists enabled tools with input and output schemas and private cache hints", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject(modernCall("tools/list"));
      const body = response.json<
        ModernSuccess<{
          tools: Array<{ name: string; inputSchema: unknown; outputSchema: unknown }>;
          ttlMs: number;
          cacheScope: string;
        }>
      >();
      expect(response.statusCode).toBe(200);
      expect(body.result.resultType).toBe("complete");
      expect(body.result.ttlMs).toBe(300_000);
      expect(body.result.cacheScope).toBe("private");
      expect(body.result.tools.length).toBeGreaterThan(0);
      expect(body.result.tools.every((tool) => tool.inputSchema !== undefined)).toBe(true);
      expect(body.result.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
      expect(body.result._meta[SERVER_INFO_META_KEY]).toMatchObject({ name: "stellara" });
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      await closeApp(app);
    }
  });

  it("returns content and validated structuredContent for a known tool", async () => {
    const app = await buildApp(makeTestConfig());
    const hit: ExaSearchResult = {
      title: "Result",
      url: "https://example.org/result",
      snippet: "Snippet",
    };
    vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    try {
      const response = await app.inject(
        modernCall("tools/call", { name: "web_search", arguments: { query: "hello" } }),
      );
      const body = response.json<
        ModernSuccess<{
          content: Array<{ type: string; text: string }>;
          structuredContent: { results: ExaSearchResult[] };
        }>
      >();
      expect(response.statusCode).toBe(200);
      expect(body.result.resultType).toBe("complete");
      expect(body.result.structuredContent).toStrictEqual({ results: [hit] });
      expect(firstTextContent(body.result)).toStrictEqual({ results: [hit] });
      expect(body.result._meta[SERVER_INFO_META_KEY]).toMatchObject({ name: "stellara" });
      expect(response.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      await closeApp(app);
    }
  });

  it("uses isError results for known-tool argument and execution failures", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const invalid = await app.inject(
        modernCall("tools/call", { name: "web_search", arguments: {} }),
      );
      vi.spyOn(app.services.exa!, "search").mockRejectedValue(new Error("SECRET_INTERNAL_URL"));
      const failed = await app.inject(
        modernCall("tools/call", { name: "web_search", arguments: { query: "hello" } }),
      );
      expect(invalid.json<{ result: { isError: boolean } }>().result.isError).toBe(true);
      expect(failed.json<{ result: { isError: boolean } }>().result.isError).toBe(true);
      expect(failed.payload).not.toContain("SECRET_INTERNAL_URL");
    } finally {
      await closeApp(app);
    }
  });

  it("keeps unknown tools and modern initialize as JSON-RPC errors", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const unknown = await app.inject(
        modernCall("tools/call", { name: "unknown_tool", arguments: {} }),
      );
      const initialize = await app.inject(modernCall("initialize"));
      expect(expectModernError(unknown.json()).error.code).toBeLessThan(0);
      expect(expectModernError(initialize.json()).error.code).toBeLessThan(0);
    } finally {
      await closeApp(app);
    }
  });

  it.each([
    ["mismatched method header", { "mcp-method": "tools/list" }, -32_020],
    ["unsupported protocol version", { "mcp-protocol-version": "2099-01-01" }, -32_020],
  ])("rejects %s without legacy downgrade", async (_label, headers, code) => {
    const app = await buildApp(makeTestConfig());
    try {
      const request = modernCall("server/discover", {}, { headers });
      const response = await app.inject(request);
      const failure = expectModernError(response.json());
      expect(response.statusCode).toBe(400);
      expect(failure.error.code).toBe(code);
    } finally {
      await closeApp(app);
    }
  });

  it("rejects a missing method header without legacy downgrade", async () => {
    const app = await buildApp(makeTestConfig());
    const request = modernCall("server/discover");
    const { "mcp-method": _omitted, ...headers } = request.headers;
    request.headers = headers;
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(expectModernError(response.json()).error.code).toBe(-32_020);
    } finally {
      await closeApp(app);
    }
  });

  it("rejects an unsupported claimed version with -32022", async () => {
    const app = await buildApp(makeTestConfig());
    const meta = requestMeta({ [PROTOCOL_VERSION_META_KEY]: "2099-01-01" });
    try {
      const response = await app.inject(
        modernCall(
          "server/discover",
          {},
          {
            headers: { "mcp-protocol-version": "2099-01-01" },
            meta,
          },
        ),
      );
      expect(response.statusCode).toBe(400);
      expect(expectModernError(response.json()).error.code).toBe(-32_022);
    } finally {
      await closeApp(app);
    }
  });

  it("rejects a missing clientCapabilities metadata member as invalid params", async () => {
    const app = await buildApp(makeTestConfig());
    const meta = {
      [PROTOCOL_VERSION_META_KEY]: PROTOCOL_VERSION,
      [CLIENT_INFO_META_KEY]: { name: "stellara-test", version: "1.0.0" },
    };
    try {
      const response = await app.inject(modernCall("server/discover", {}, { meta }));
      expect(response.statusCode).toBe(400);
      expect(expectModernError(response.json()).error.code).toBe(-32_602);
    } finally {
      await closeApp(app);
    }
  });

  it("allows omitted clientInfo but rejects malformed clientInfo when present", async () => {
    const app = await buildApp(makeTestConfig());
    const { [CLIENT_INFO_META_KEY]: _omitted, ...withoutClientInfo } = requestMeta();
    const malformedClientInfo = requestMeta({
      [CLIENT_INFO_META_KEY]: { name: "missing-version" },
    });
    try {
      const omitted = await app.inject(
        modernCall("server/discover", {}, { meta: withoutClientInfo }),
      );
      const malformed = await app.inject(
        modernCall("server/discover", {}, { meta: malformedClientInfo }),
      );
      expect(omitted.statusCode).toBe(200);
      expect(malformed.statusCode).toBe(400);
      expect(expectModernError(malformed.json()).error.code).toBe(-32_602);
    } finally {
      await closeApp(app);
    }
  });

  it("requires Mcp-Name to exactly match tools/call params without legacy downgrade", async () => {
    const app = await buildApp(makeTestConfig());
    const missing = modernCall("tools/call", {
      name: "web_search",
      arguments: { query: "hello" },
    });
    const { "mcp-name": _omitted, ...headersWithoutName } = missing.headers;
    missing.headers = headersWithoutName;
    try {
      const absent = await app.inject(missing);
      const mismatched = await app.inject(
        modernCall(
          "tools/call",
          { name: "web_search", arguments: { query: "hello" } },
          { headers: { "mcp-name": "web_scrape" } },
        ),
      );
      expect(absent.statusCode).toBe(400);
      expect(expectModernError(absent.json()).error.code).toBe(-32_020);
      expect(mismatched.statusCode).toBe(400);
      expect(expectModernError(mismatched.json()).error.code).toBe(-32_020);
    } finally {
      await closeApp(app);
    }
  });

  it("fails closed as modern when a modern header lacks envelope metadata", async () => {
    const app = await buildApp(makeTestConfig());
    const request = modernCall("tools/list");
    request.payload.params = {};
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(400);
      expect(expectModernError(response.json()).error.code).toBeLessThan(0);
    } finally {
      await closeApp(app);
    }
  });

  it("authenticates before reporting modern protocol errors", async () => {
    const app = await buildApp(makeTestConfig());
    const request = modernCall("server/discover", {}, { headers: { authorization: "" } });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer resource_metadata="https://stellara.example.test/.well-known/oauth-protected-resource/mcp" scope="mcp"',
      );
      expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
    } finally {
      await closeApp(app);
    }
  });
});
