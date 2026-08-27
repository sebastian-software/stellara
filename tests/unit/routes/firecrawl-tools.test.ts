/**
 * Smoke tests for the Firecrawl-backed tool routes added in plan 0005
 * (§8.10–§8.16). One file covers them all: per route a happy-path (stubs the
 * Firecrawl service and asserts the wire format), a 401 (no bearer) and a
 * 422 (validation failure). Per-Firecrawl-method behaviour is validated in
 * `tests/unit/services/firecrawl.test.ts`.
 *
 * Plan 0008 removed the live-browser session/interact tools; the
 * corresponding test block has been deleted along with the routes. The
 * Playwright-backed replacements ship via plan 0009/0010.
 */
import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

function withApp(fn: (app: FastifyInstance) => Promise<void>): () => Promise<void> {
  return async () => {
    const app = await buildApp(makeTestConfig());
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  };
}

describe("POST /tools/map", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the URL list",
    withApp(async (app) => {
      vi.spyOn(app.services.firecrawl, "map").mockResolvedValue({
        urls: ["https://example.com/a", "https://example.com/b"],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/map",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com", maxUrls: 50 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ urls: string[] }>().urls).toHaveLength(2);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/map",
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "rejects invalid body (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/map",
        headers: AUTH_HEADERS,
        payload: { url: "not-a-url" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

describe("POST /tools/extract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the data + status envelope",
    withApp(async (app) => {
      vi.spyOn(app.services.firecrawl, "extract").mockResolvedValue({
        data: { price: 9.99 },
        status: "completed",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/extract",
        headers: AUTH_HEADERS,
        payload: { urls: ["https://example.com/p"], prompt: "Get price" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ status: string }>().status).toBe("completed");
    }),
  );

  it(
    "rejects when neither prompt nor schema is supplied (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/extract",
        headers: AUTH_HEADERS,
        payload: { urls: ["https://example.com/p"] },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

describe("POST /tools/crawl/start + /tools/crawl/status", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "crawl/start returns the Firecrawl job id",
    withApp(async (app) => {
      vi.spyOn(app.services.firecrawl, "startCrawl").mockResolvedValue({ jobId: "job-xyz" });
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl/start",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ jobId: string }>().jobId).toBe("job-xyz");
    }),
  );

  it(
    "crawl/status returns the per-job snapshot",
    withApp(async (app) => {
      vi.spyOn(app.services.firecrawl, "getCrawlStatus").mockResolvedValue({
        status: "scraping",
        completed: 1,
        total: 4,
        pages: [{ url: "https://example.com/a", markdown: "A" }],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl/status",
        headers: AUTH_HEADERS,
        payload: { jobId: "job-xyz" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; completed: number }>();
      expect(body.status).toBe("scraping");
      expect(body.completed).toBe(1);
    }),
  );

  it(
    "crawl/status rejects when jobId is empty (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl/status",
        headers: AUTH_HEADERS,
        payload: { jobId: "" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});
