import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

function stubExaSearch(app: FastifyInstance, impl: () => Promise<ExaSearchResult[]>): void {
  vi.spyOn(app.services.exa!, "search").mockImplementation(impl);
}

describe("POST /tools/search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with the normalized Exa results", async () => {
    const app = await buildApp(makeTestConfig());
    stubExaSearch(app, async () => {
      await Promise.resolve();
      return [
        {
          title: "Hello",
          url: "https://example.org/hello",
          snippet: "snippet",
          score: 0.9,
          publishedAt: "2025-01-02T00:00:00Z",
        },
      ];
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: AUTH_HEADERS,
        payload: { query: "model context protocol" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ results: ExaSearchResult[] }>();
      expect(body.results).toHaveLength(1);
      expect(body.results[0]?.url).toBe("https://example.org/hello");
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token with 401", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        payload: { query: "anything" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 422 VALIDATION_ERROR when the query is missing", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: AUTH_HEADERS,
        payload: { maxResults: 5 },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("returns 502 UPSTREAM_ERROR when Exa rejects with an AppError", async () => {
    const app = await buildApp(makeTestConfig());
    stubExaSearch(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.UPSTREAM_ERROR, details: { service: "exa" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: AUTH_HEADERS,
        payload: { query: "anything" },
      });
      expect(response.statusCode).toBe(502);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UPSTREAM_ERROR");
    } finally {
      await app.close();
    }
  });

  it("returns 504 TIMEOUT when Exa rejects via an aborted signal", async () => {
    const app = await buildApp(makeTestConfig());
    // Simulate an upstream that observes the timeout abort: it raises an
    // AppError(TIMEOUT) just like the real ExaClient does via mapUpstreamError.
    stubExaSearch(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.TIMEOUT, details: { service: "exa" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: AUTH_HEADERS,
        payload: { query: "anything" },
      });
      expect(response.statusCode).toBe(504);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("TIMEOUT");
    } finally {
      await app.close();
    }
  });
});
