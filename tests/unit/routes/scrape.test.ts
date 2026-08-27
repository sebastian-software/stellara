import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FirecrawlScrapeResult } from "../../../src/services/firecrawl.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

function stubScrape(app: FastifyInstance, impl: () => Promise<FirecrawlScrapeResult>): void {
  vi.spyOn(app.services.firecrawl, "scrape").mockImplementation(impl);
}

describe("POST /tools/scrape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with the normalized scrape result", async () => {
    const app = await buildApp(makeTestConfig());
    stubScrape(app, async () => {
      await Promise.resolve();
      return {
        url: "https://example.org/page",
        title: "Page",
        markdown: "# Page",
        metadata: { title: "Page" },
      };
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/scrape",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org/page" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<FirecrawlScrapeResult>();
      expect(body.markdown).toBe("# Page");
    } finally {
      await app.close();
    }
  });

  it("rejects requests without a bearer token with 401", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/scrape",
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
        url: "/tools/scrape",
        headers: AUTH_HEADERS,
        payload: { formats: ["markdown"] },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("returns 502 UPSTREAM_ERROR when Firecrawl rejects", async () => {
    const app = await buildApp(makeTestConfig());
    stubScrape(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.UPSTREAM_ERROR, details: { service: "firecrawl" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/scrape",
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
    stubScrape(app, async () => {
      await Promise.resolve();
      throw new AppError({ code: ErrorCode.TIMEOUT, details: { service: "firecrawl" } });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/scrape",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.org" },
      });
      expect(response.statusCode).toBe(504);
    } finally {
      await app.close();
    }
  });
});
