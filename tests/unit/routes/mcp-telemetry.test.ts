import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const SECRET_ARGUMENT = "SECRET_TOOL_ARGUMENT";
const SECRET_CLIENT_INFO = "SECRET_CLIENT_INFO";
const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const AUTH_HEADERS = {
  authorization: `Bearer ${TEST_TOKEN_USER_A}`,
  accept: "application/json",
  "content-type": "application/json",
  host: "stellara.example.test",
  "x-forwarded-proto": "https",
};

function parseLogLines(chunks: readonly string[]): Array<Record<string, unknown>> {
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Expected a structured log object");
      }
      return { ...parsed };
    });
}

function telemetryLogs(chunks: readonly string[]): Array<Record<string, unknown>> {
  return parseLogLines(chunks).filter((line) => line.event === "mcp_request_classified");
}

async function buildLoggingApp(captured: string[]): Promise<FastifyInstance> {
  return buildApp(makeTestConfig({ LOG_LEVEL: "info" }), {
    loggerDestination: {
      write(chunk: string): void {
        captured.push(chunk);
      },
    },
  });
}

function modernCall(version = PROTOCOL_VERSION): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      ...AUTH_HEADERS,
      "mcp-method": "tools/call",
      "mcp-name": "web_search",
      "mcp-protocol-version": version,
    },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { query: SECRET_ARGUMENT },
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: version,
          [CAPABILITIES_META_KEY]: {},
          [CLIENT_INFO_META_KEY]: { name: SECRET_CLIENT_INFO, version: "1.0.0" },
        },
      },
    },
  };
}

function legacyList(version?: string): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  return {
    method: "POST",
    url: "/mcp",
    headers: {
      ...AUTH_HEADERS,
      ...(version === undefined ? {} : { "mcp-protocol-version": version }),
    },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  };
}

function legacyCall(version?: string): ReturnType<typeof legacyList> {
  return {
    ...legacyList(version),
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "web_search",
        arguments: { query: SECRET_ARGUMENT },
        clientInfo: { name: SECRET_CLIENT_INFO, version: "1.0.0" },
      },
    },
  };
}

describe("MCP request telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the controlled modern era and version without request secrets", async () => {
    const captured: string[] = [];
    const app = await buildLoggingApp(captured);
    const hit: ExaSearchResult = {
      title: "Result",
      url: "https://example.org/result",
      snippet: "Snippet",
    };
    vi.spyOn(app.services.exa!, "search").mockResolvedValue([hit]);
    try {
      const response = await app.inject(modernCall());
      expect(response.statusCode).toBe(200);
      const logs = telemetryLogs(captured);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        mcpMethod: "tools/call",
        msg: "mcp request classified",
        protocolEra: "modern",
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(typeof logs[0]?.requestId).toBe("string");
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(TEST_TOKEN_USER_A);
      expect(serialized).not.toContain(SECRET_ARGUMENT);
      expect(serialized).not.toContain(SECRET_CLIENT_INFO);
    } finally {
      await app.close();
    }
  });

  it("maps an untrusted modern version claim to a stable value", async () => {
    const captured: string[] = [];
    const app = await buildLoggingApp(captured);
    const untrustedVersion = "SECRET_UNTRUSTED_VERSION";
    try {
      const response = await app.inject(modernCall(untrustedVersion));
      expect(response.statusCode).toBe(400);
      const logs = telemetryLogs(captured);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        protocolEra: "modern",
        protocolVersion: "unknown",
      });
      expect(JSON.stringify(logs)).not.toContain(untrustedVersion);
    } finally {
      await app.close();
    }
  });

  it("logs the same negotiated legacy initialize version as the response", async () => {
    const captured: string[] = [];
    const app = await buildLoggingApp(captured);
    try {
      const initialized = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: AUTH_HEADERS,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            clientInfo: { name: SECRET_CLIENT_INFO, version: "1.0.0" },
          },
        },
      });
      expect(initialized.statusCode).toBe(200);
      const body = initialized.json<{ result: { protocolVersion: string } }>();
      expect(body.result.protocolVersion).toBe("2024-11-05");
      const logs = telemetryLogs(captured);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        mcpMethod: "initialize",
        protocolEra: "legacy",
        protocolVersion: body.result.protocolVersion,
      });
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(TEST_TOKEN_USER_A);
      expect(serialized).not.toContain(SECRET_CLIENT_INFO);
    } finally {
      await app.close();
    }
  });

  it.each(LEGACY_PROTOCOL_VERSIONS)(
    "logs the controlled %s header for a non-initialize legacy request",
    async (version) => {
      const captured: string[] = [];
      const app = await buildLoggingApp(captured);
      try {
        const response = await app.inject(legacyList(version));
        expect(response.statusCode).toBe(200);
        expect(telemetryLogs(captured)).toStrictEqual([
          expect.objectContaining({
            mcpMethod: "tools/list",
            protocolEra: "legacy",
            protocolVersion: version,
          }),
        ]);
      } finally {
        await app.close();
      }
    },
  );

  it("maps missing and untrusted legacy version headers to unknown without logging secrets", async () => {
    const captured: string[] = [];
    const app = await buildLoggingApp(captured);
    const untrustedVersion = "SECRET_UNTRUSTED_LEGACY_VERSION";
    vi.spyOn(app.services.exa!, "search").mockResolvedValue([]);
    try {
      const missing = await app.inject(legacyCall());
      const untrusted = await app.inject(legacyCall(untrustedVersion));
      expect(missing.statusCode).toBe(200);
      expect(untrusted.statusCode).toBe(400);
      const logs = telemetryLogs(captured);
      expect(logs).toHaveLength(2);
      expect(logs).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mcpMethod: "tools/call",
            protocolEra: "legacy",
            protocolVersion: "unknown",
          }),
          expect.objectContaining({
            mcpMethod: "tools/call",
            protocolEra: "modern",
            protocolVersion: "unknown",
          }),
        ]),
      );
      expect(logs.every((log) => log.protocolVersion === "unknown")).toBe(true);
      const serialized = JSON.stringify(logs);
      expect(serialized).not.toContain(TEST_TOKEN_USER_A);
      expect(serialized).not.toContain(SECRET_ARGUMENT);
      expect(serialized).not.toContain(SECRET_CLIENT_INFO);
      expect(serialized).not.toContain(untrustedVersion);
    } finally {
      await app.close();
    }
  });
});
