import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExaSearchResult } from "../../../src/services/exa.js";
import type { FirecrawlScrapeResult } from "../../../src/services/firecrawl.js";

import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

type ResearchResponse = {
  query: string;
  sources: Array<{
    url: string;
    title: string;
    snippet: string;
    content?: string;
  }>;
};

function stubExaSearch(app: FastifyInstance, impl: () => Promise<ExaSearchResult[]>): void {
  vi.spyOn(app.services.exa!, "search").mockImplementation(impl);
}

function stubScrape(
  app: FastifyInstance,
  impl: (url: string) => Promise<FirecrawlScrapeResult>,
): void {
  vi.spyOn(app.services.firecrawl, "scrape").mockImplementation(async (url) => impl(url));
}

const SAMPLE_HITS: ExaSearchResult[] = [
  { title: "A", url: "https://example.org/a", snippet: "a" },
  { title: "B", url: "https://example.org/b", snippet: "b" },
  { title: "C", url: "https://example.org/c", snippet: "c" },
];

/**
 * Per-URL scrape outcomes used by the partial-failure test. The map drives the
 * stub without conditionals inside the test body (vitest/no-conditional-in-test).
 */
const SCRAPE_OUTCOMES = new Map<string, { error: string } | FirecrawlScrapeResult>([
  ["https://example.org/a", { url: "https://example.org/a", markdown: "# https://example.org/a" }],
  ["https://example.org/b", { url: "https://example.org/b", markdown: "# https://example.org/b" }],
  ["https://example.org/c", { error: "scrape failed" }],
]);

function isErrorOutcome(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

async function scrapeFromMap(url: string): Promise<FirecrawlScrapeResult> {
  await Promise.resolve();
  const outcome = SCRAPE_OUTCOMES.get(url);
  if (outcome === undefined) throw new Error(`unmapped url ${url}`);
  if (isErrorOutcome(outcome)) throw new Error(outcome.error);
  return outcome;
}

/**
 * Per-URL scrape behaviors used by the soft-cap test. The "slow" URL hangs
 * until its `AbortSignal` aborts (so the soft-cap branch fires); the "fast"
 * URL resolves synchronously with markdown. Kept at module scope so the test
 * body stays free of conditionals (vitest/no-conditional-in-test).
 */
const SOFT_CAP_BEHAVIORS = new Map<
  string,
  (signal: AbortSignal | undefined) => Promise<FirecrawlScrapeResult>
>([
  [
    "https://example.org/slow",
    async (signal) =>
      new Promise<FirecrawlScrapeResult>((_resolve, reject) => {
        // Reject when the soft-cap aborts the signal. Without a listener the
        // promise would hang forever and the route's hard cap (§17) would
        // resolve instead, which is not what this test exercises.
        signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
  ],
  [
    "https://example.org/fast",
    async () => {
      await Promise.resolve();
      return { url: "https://example.org/fast", markdown: "# fast" };
    },
  ],
]);

async function softCapScrape(
  url: string,
  signal: AbortSignal | undefined,
): Promise<FirecrawlScrapeResult> {
  const handler = SOFT_CAP_BEHAVIORS.get(url);
  // The Map covers every URL emitted by the stubbed Exa search; an unknown
  // URL is a test-setup bug, not a runtime case.
  if (handler === undefined) throw new Error(`unmapped url ${url}`);
  return handler(signal);
}

describe("POST /tools/research", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with sources where failed scrapes omit `content`", async () => {
    const app = await buildApp(makeTestConfig());
    stubExaSearch(app, async () => {
      await Promise.resolve();
      return SAMPLE_HITS;
    });
    stubScrape(app, scrapeFromMap);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/research",
        headers: AUTH_HEADERS,
        payload: { query: "research me" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<ResearchResponse>();
      expect(body.query).toBe("research me");
      expect(body.sources).toHaveLength(3);

      const [first, second, third] = body.sources;
      expect(first?.content).toBe("# https://example.org/a");
      expect(second?.content).toBe("# https://example.org/b");
      // The failed third source keeps the snippet but omits `content` entirely
      // (§8.4 only provides the scraped markdown when the scrape succeeds).
      expect(third).toBeDefined();
      expect(third?.snippet).toBe("c");
      expect(third).not.toHaveProperty("content");
    } finally {
      await app.close();
    }
  });

  it("returns 422 VALIDATION_ERROR when the query is missing", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/research",
        headers: AUTH_HEADERS,
        payload: { maxSources: 3 },
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("returns 200 with no `content` when the Exa search yields no hits", async () => {
    const app = await buildApp(makeTestConfig());
    stubExaSearch(app, async () => {
      await Promise.resolve();
      return [];
    });
    const scrapeSpy = vi.spyOn(app.services.firecrawl, "scrape");

    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/research",
        headers: AUTH_HEADERS,
        payload: { query: "empty" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<ResearchResponse>();
      expect(body.sources).toStrictEqual([]);
      // No scraper invocation when there are no hits.
      expect(scrapeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("soft-cap branch: pending scrapes time out, completed scrapes carry content", async () => {
    vi.useFakeTimers();
    const app = await buildApp(makeTestConfig());
    stubExaSearch(app, async () => {
      await Promise.resolve();
      return [
        { title: "Slow", url: "https://example.org/slow", snippet: "slow" },
        { title: "Fast", url: "https://example.org/fast", snippet: "fast" },
      ];
    });

    // Per-URL scrape behavior lives in `SOFT_CAP_BEHAVIORS` at module scope
    // (see comment there) — the "slow" hit hangs until the soft-cap abort
    // fires, the "fast" hit resolves synchronously.
    vi.spyOn(app.services.firecrawl, "scrape").mockImplementation(async (url, _opts, signal) =>
      softCapScrape(url, signal),
    );

    try {
      const injectPromise = app.inject({
        method: "POST",
        url: "/tools/research",
        headers: AUTH_HEADERS,
        payload: { query: "soft cap", timeBudgetMs: 1000 },
      });
      // Advance past the soft-cap budget so the abort fires; we stay well
      // below the 60 s hard cap so the route still returns 200.
      await vi.advanceTimersByTimeAsync(1500);
      const response = await injectPromise;
      expect(response.statusCode).toBe(200);
      const body = response.json<ResearchResponse>();
      expect(body.sources).toHaveLength(2);
      const [slow, fast] = body.sources;
      // The hanging scrape is reported without `content` (§8.4 soft-cap).
      expect(slow?.url).toBe("https://example.org/slow");
      expect(slow).not.toHaveProperty("content");
      // The completed scrape's markdown is surfaced unchanged.
      expect(fast?.url).toBe("https://example.org/fast");
      expect(fast?.content).toBe("# fast");
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });
});
