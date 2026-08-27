import { afterEach, describe, expect, it, vi } from "vitest";

import type { FetchSpy } from "../helpers/fetch-mock.js";

import { ErrorCode } from "../../../src/errors.js";
import { FirecrawlClient } from "../../../src/services/firecrawl.js";
import {
  firstFetchCall,
  jsonResponse,
  mockFetchOnce,
  mockFetchReject,
} from "../helpers/fetch-mock.js";
import { makeTestConfig } from "../helpers/test-config.js";

function firstFetchUrl(spy: FetchSpy): string {
  return firstFetchCall(spy).url;
}

describe("FirecrawlClient.scrape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to /v1/scrape and normalizes the response", async () => {
    const fetchSpy = mockFetchOnce(
      jsonResponse({
        data: {
          url: "https://example.org/page",
          markdown: "# Hello",
          metadata: { title: "Hello" },
        },
      }),
    );
    const client = new FirecrawlClient(makeTestConfig());
    const result = await client.scrape("https://example.org/page", { formats: ["markdown"] });

    expect(result).toStrictEqual({
      url: "https://example.org/page",
      title: "Hello",
      markdown: "# Hello",
      metadata: { title: "Hello" },
    });
    expect(firstFetchUrl(fetchSpy)).toBe("https://firecrawl.example.test/v1/scrape");
  });

  it("maps HTTP 5xx to UPSTREAM_ERROR", async () => {
    mockFetchOnce(new Response("boom", { status: 502 }));
    const client = new FirecrawlClient(makeTestConfig());
    await expect(client.scrape("https://example.org/page", {})).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });

  it("maps an aborted signal to TIMEOUT", async () => {
    mockFetchReject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();
    const client = new FirecrawlClient(makeTestConfig());
    await expect(client.scrape("https://example.org", {}, controller.signal)).rejects.toMatchObject(
      { code: ErrorCode.TIMEOUT },
    );
  });
});

describe("FirecrawlClient.crawl (sync convenience with internal polling)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts an async job and polls until the status flips to completed", async () => {
    // Chain two distinct fetch responses: POST /v1/crawl → job id, then
    // GET /v1/crawl/:id → completed pages. `mockFetchOnce` returns the same
    // payload for every call, so we drop down to `mockResolvedValueOnce`.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ success: true, id: "job-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "completed",
          completed: 2,
          total: 2,
          data: [
            { url: "https://example.org/a", markdown: "A", metadata: {} },
            { url: "https://example.org/b", markdown: "B", metadata: { title: "B" } },
          ],
        }),
      );
    const client = new FirecrawlClient(makeTestConfig());
    const result = await client.crawl("https://example.org", { maxPages: 5 });
    expect(result.status).toBe("completed");
    expect(result.jobId).toBe("job-1");
    expect(result.pages).toHaveLength(2);
    expect(result.pages[1]).toStrictEqual({
      url: "https://example.org/b",
      title: "B",
      markdown: "B",
      metadata: { title: "B" },
    });
    expect(result.stats.pagesScraped).toBe(2);
    expect(typeof result.stats.durationMs).toBe("number");
  });
});

describe("FirecrawlClient.startCrawl + getCrawlStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startCrawl returns the Firecrawl-issued job id", async () => {
    mockFetchOnce(jsonResponse({ success: true, id: "job-xyz" }));
    const client = new FirecrawlClient(makeTestConfig());
    const job = await client.startCrawl("https://example.org", { maxPages: 10 });
    expect(job.jobId).toBe("job-xyz");
  });

  it("getCrawlStatus normalizes the per-job response", async () => {
    mockFetchOnce(
      jsonResponse({
        status: "scraping",
        completed: 1,
        total: 4,
        data: [{ url: "https://example.org/a", markdown: "A" }],
      }),
    );
    const client = new FirecrawlClient(makeTestConfig());
    const status = await client.getCrawlStatus("job-xyz");
    expect(status).toStrictEqual({
      status: "scraping",
      completed: 1,
      total: 4,
      pages: [{ url: "https://example.org/a", markdown: "A" }],
    });
  });
});

describe("FirecrawlClient.map", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the discovered URL list (links field)", async () => {
    mockFetchOnce(jsonResponse({ links: ["https://example.org/", "https://example.org/about"] }));
    const client = new FirecrawlClient(makeTestConfig());
    const result = await client.map("https://example.org", { maxUrls: 100 });
    expect(result.urls).toStrictEqual(["https://example.org/", "https://example.org/about"]);
  });
});

describe("FirecrawlClient.extract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns Firecrawl's data + status verbatim", async () => {
    mockFetchOnce(jsonResponse({ status: "completed", data: { price: 9.99 } }));
    const client = new FirecrawlClient(makeTestConfig());
    const result = await client.extract(["https://example.org/p"], { prompt: "Get the price" });
    expect(result.status).toBe("completed");
    expect(result.data).toStrictEqual({ price: 9.99 });
  });
});

describe("FirecrawlClient.probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves on a 200 response from the service root", async () => {
    const fetchSpy = mockFetchOnce(
      jsonResponse({
        message: "Firecrawl API",
        documentation_url: "https://docs.firecrawl.dev",
      }),
    );
    const client = new FirecrawlClient(makeTestConfig());
    await expect(client.probe(new AbortController().signal)).resolves.toBeUndefined();
    expect(firstFetchUrl(fetchSpy)).toBe("https://firecrawl.example.test/");
  });

  it("throws UPSTREAM_ERROR on non-2xx", async () => {
    mockFetchOnce(new Response("nope", { status: 503 }));
    const client = new FirecrawlClient(makeTestConfig());
    await expect(client.probe(new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });

  it("maps an aborted signal to TIMEOUT", async () => {
    mockFetchReject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();
    const client = new FirecrawlClient(makeTestConfig());
    await expect(client.probe(controller.signal)).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
    });
  });
});
