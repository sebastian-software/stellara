import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FirecrawlCrawlResult } from "../../../src/services/firecrawl.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

function stubCrawl(app: FastifyInstance, impl: () => Promise<FirecrawlCrawlResult>): void {
  vi.spyOn(app.services.firecrawl, "crawl").mockImplementation(impl);
}

describe("POST /tools/crawl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with pages and stats", async () => {
    const app = await buildApp(makeTestConfig());
    stubCrawl(app, async () => {
      await Promise.resolve();
      return {
        status: "completed",
        jobId: "job-abc",
        pages: [
          { url: "https://example.org/a", markdown: "A" },
          { url: "https://example.org/b", markdown: "B" },
        ],
        stats: { pagesScraped: 2, durationMs: 42 },
      };
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<FirecrawlCrawlResult>();
      expect(body.pages).toHaveLength(2);
      expect(body.stats.pagesScraped).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token with 401", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        payload: { url: "https://example.org" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 422 VALIDATION_ERROR when the url is missing", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { maxPages: 5 },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("rejects maxDepth above the upper bound (11) with 422 VALIDATION_ERROR", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org", maxDepth: 11 },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("accepts maxDepth at the upper bound (10)", async () => {
    const app = await buildApp(makeTestConfig());
    stubCrawl(app, async () => {
      await Promise.resolve();
      return {
        status: "completed",
        jobId: "job-xyz",
        pages: [],
        stats: { pagesScraped: 0, durationMs: 1 },
      };
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org", maxDepth: 10 },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 502 UPSTREAM_ERROR when Firecrawl rejects", async () => {
    const app = await buildApp(makeTestConfig());
    stubCrawl(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.UPSTREAM_ERROR, details: { service: "firecrawl" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org" },
      });
      expect(response.statusCode).toBe(502);
    } finally {
      await app.close();
    }
  });

  it("returns 504 TIMEOUT when Firecrawl rejects with a TIMEOUT AppError", async () => {
    const app = await buildApp(makeTestConfig());
    stubCrawl(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.TIMEOUT, details: { service: "firecrawl" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/crawl",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org" },
      });
      expect(response.statusCode).toBe(504);
    } finally {
      await app.close();
    }
  });
});
