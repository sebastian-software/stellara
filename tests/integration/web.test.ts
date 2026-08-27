/**
 * Integration smoke tests for the four web tools (concept §8.1–§8.4, §26).
 *
 * Each test fires a single, deliberately tiny request against the live Exa /
 * Firecrawl backend through Fastify's in-memory `app.inject` transport and
 * asserts on response **shape** — not on the actual data. Shape assertions
 * catch upstream schema drift: when Exa or Firecrawl reshape their JSON the
 * Zod response schemas reject the payload and the route surfaces a 502, which
 * fails these tests loudly during an explicit maintainer run.
 *
 * The suite is excluded from `pnpm test` / `pnpm agent:check` (see
 * `vitest.config.ts`). It runs via `pnpm test:integration`, which loads
 * `vitest.integration.config.ts` and locally supplied environment variables.
 */
import type { FastifyInstance } from "fastify";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/server.js";
import { getIntegrationHeaders } from "./helpers/auth.js";

// Resolved in `beforeAll` so a missing `STELLARA_TOKEN_INTEGRATION` surfaces as
// a clean Vitest failure rather than a module-load crash that gets reported
// as "Failed to collect test file".
let HEADERS: ReturnType<typeof getIntegrationHeaders>;

type SearchResponse = {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    score?: number;
    publishedAt?: string;
  }>;
};

type ScrapeResponse = {
  url: string;
  title?: string;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
};

type CrawlResponse = {
  pages: Array<{
    url: string;
    title?: string;
    markdown?: string;
    html?: string;
    metadata?: Record<string, unknown>;
  }>;
  stats: {
    pagesScraped: number;
    durationMs: number;
  };
};

type ResearchResponse = {
  query: string;
  sources: Array<{
    url: string;
    title: string;
    snippet: string;
    content?: string;
  }>;
};

describe("integration: web tools", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    HEADERS = getIntegrationHeaders();
    app = await buildApp(loadConfig());
  });

  afterAll(async () => {
    await app.close();
  });

  it("web_search returns a `results[]` shape matching the §8.1 schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/search",
      headers: HEADERS,
      payload: { query: "hello", maxResults: 3 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<SearchResponse>();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
    const [first] = body.results;
    expect(typeof first?.title).toBe("string");
    expect(typeof first?.url).toBe("string");
    expect(typeof first?.snippet).toBe("string");
  });

  it("web_scrape returns a single page envelope matching the §8.2 schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/scrape",
      headers: HEADERS,
      payload: {
        url: "https://example.com/",
        formats: ["markdown"],
        onlyMainContent: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ScrapeResponse>();
    expect(typeof body.url).toBe("string");
    // Request explicitly asked for `markdown` only, so the response must carry
    // that format. (Asserting `markdown OR html` would trigger
    // `vitest/no-conditional-in-test` and lose specificity in return.)
    expect(typeof body.markdown).toBe("string");
  });

  it("web_crawl returns a `pages[]` + `stats` envelope matching the §8.3 schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/crawl",
      headers: HEADERS,
      payload: {
        // `example.com` is a deterministic single-page seed: with maxDepth 1
        // and maxPages 1 at least one entry in `pages[]` is guaranteed, which
        // lets the shape check below dig one level deeper than just the
        // top-level envelope.
        url: "https://example.com/",
        maxDepth: 1,
        maxPages: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<CrawlResponse>();
    expect(Array.isArray(body.pages)).toBe(true);
    expect(body.pages.length).toBeGreaterThan(0);
    expect(typeof body.stats.pagesScraped).toBe("number");
    expect(typeof body.stats.durationMs).toBe("number");
    expect(body.stats.pagesScraped).toBeGreaterThanOrEqual(0);
    // Drill into the first page to catch per-page schema drift (e.g. Firecrawl
    // renaming `url` → `sourceUrl`). The `.slice(0, 1).forEach` form keeps
    // `vitest/no-conditional-in-test` happy while still asserting only on
    // present rows.
    body.pages.slice(0, 1).forEach((page) => {
      expect(typeof page.url).toBe("string");
    });
  });

  it("web_research returns `query` + `sources[]` matching the §8.4 schema", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tools/research",
      headers: HEADERS,
      payload: {
        query: "hello",
        maxSources: 2,
        // Keep the soft cap well under the route's 60 s hard cap so the
        // integration test reliably exits within `testTimeout`.
        timeBudgetMs: 20_000,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ResearchResponse>();
    expect(body.query).toBe("hello");
    // Defensive shape check only: a soft `timeBudgetMs` exhaustion can lead
    // the route to return an empty `sources[]` even on a healthy Exa run, so
    // asserting `length > 0` would flake. Schema drift is still caught — the
    // route's Zod response validation surfaces shape regressions as 502.
    expect(Array.isArray(body.sources)).toBe(true);
    body.sources.slice(0, 1).forEach((first) => {
      expect(typeof first.url).toBe("string");
      expect(typeof first.title).toBe("string");
      expect(typeof first.snippet).toBe("string");
    });
  });
});
