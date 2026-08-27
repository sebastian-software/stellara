/**
 * Integration smoke test for the MCP handshake (concept §9, §26).
 *
 * Exercises both protocol generations through the official MCP SDK client and
 * Fastify's in-memory transport. Each path performs one read-only web search
 * against the configured integration backend, preserving the real MCP tool
 * bridge without creating write side effects.
 *
 * The suite is excluded from `pnpm test` / `pnpm agent:check` (see
 * `vitest.config.ts`). It runs via `pnpm test:integration`, which loads
 * `vitest.integration.config.ts` and locally supplied environment variables.
 */
import type { FastifyInstance } from "fastify";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { searchResponseSchema } from "../../src/schemas/web.js";
import { buildApp } from "../../src/server.js";
import { createMcpInjectFetch } from "../helpers/mcp-client.js";
import { getIntegrationHeaders } from "./helpers/auth.js";

// Resolved in `beforeAll` so a missing `STELLARA_TOKEN_INTEGRATION` surfaces as
// a clean Vitest failure rather than a module-load crash that gets reported
// as "Failed to collect test file".
let HEADERS: ReturnType<typeof getIntegrationHeaders>;

function createTransport(app: FastifyInstance): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL("/mcp", app.config.publicBaseUrl), {
    fetch: createMcpInjectFetch(app),
    requestInit: { headers: { authorization: HEADERS.authorization } },
  });
}

function requireApp(app: FastifyInstance | undefined): FastifyInstance {
  if (app === undefined) throw new Error("Integration app failed to start");
  return app;
}

describe("integration: MCP handshake", () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    HEADERS = getIntegrationHeaders();
    app = await buildApp(loadConfig());
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns the exact protected-resource challenge before protocol negotiation", async () => {
    const instance = requireApp(app);
    const response = await instance.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "server/discover" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${instance.config.publicBaseUrl}/.well-known/oauth-protected-resource/mcp" scope="mcp"`,
    );
  });

  it.each([
    ["modern", "auto"],
    ["legacy", "legacy"],
  ] as const)(
    "discovers, lists and calls a read-only tool through the official SDK's %s path",
    async (label, mode) => {
      const client = new Client(
        { name: `stellara-integration-${label}`, version: "1.0.0" },
        { versionNegotiation: { mode } },
      );
      try {
        await client.connect(createTransport(requireApp(app)));
        const catalog = await client.listTools();
        expect(catalog.tools.length).toBeGreaterThan(0);
        expect(catalog.tools.every((tool) => Object.keys(tool.inputSchema).length > 0)).toBe(true);
        expect(catalog.tools.find((tool) => tool.name === "web_search")).toMatchObject({
          annotations: { readOnlyHint: true },
        });
        const result = await client.callTool({
          name: "web_search",
          arguments: { query: "model context protocol", maxResults: 3 },
        });
        expect(result.isError).not.toBe(true);
        const output = searchResponseSchema.parse(result.structuredContent);
        expect(Array.isArray(output.results)).toBe(true);
      } finally {
        await client.close();
      }
    },
  );
});
