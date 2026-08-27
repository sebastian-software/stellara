import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";

import { buildApp } from "../../../src/server.js";
import { createMcpInjectFetch } from "../../helpers/mcp-client.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

function transportOptions(app: Awaited<ReturnType<typeof buildApp>>): {
  fetch: typeof fetch;
  requestInit: RequestInit;
} {
  return {
    fetch: createMcpInjectFetch(app),
    requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` } },
  };
}

describe("official MCP SDK client against Stellara", () => {
  afterEach(() => vi.restoreAllMocks());

  it("auto-negotiates 2026-07-28 and lists and calls tools", async () => {
    const app = await buildApp(makeTestConfig());
    const client = new Client(
      { name: "stellara-modern-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("https://stellara.example.test/mcp"),
      transportOptions(app),
    );
    const hit: ExaSearchResult = {
      title: "Result",
      url: "https://example.org/result",
      snippet: "Snippet",
    };
    vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      const result = await client.callTool({
        name: "web_search",
        arguments: { query: "hello" },
      });
      expect(catalog.tools.some((tool) => tool.name === "web_search")).toBe(true);
      expect(result.structuredContent).toStrictEqual({ results: [hit] });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("keeps the official client's legacy initialize, list and call path working", async () => {
    const app = await buildApp(makeTestConfig());
    const client = new Client(
      { name: "stellara-legacy-test", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL("https://stellara.example.test/mcp"),
      transportOptions(app),
    );
    const hit: ExaSearchResult = {
      title: "Legacy result",
      url: "https://example.org/legacy",
      snippet: "Legacy snippet",
    };
    vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      const result = await client.callTool({
        name: "web_search",
        arguments: { query: "legacy" },
      });
      expect(catalog.tools.some((tool) => tool.name === "web_search")).toBe(true);
      expect(result.structuredContent).toStrictEqual({ results: [hit] });
    } finally {
      await client.close();
      await app.close();
    }
  });
});
