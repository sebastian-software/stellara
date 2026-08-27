/**
 * Firecrawl API client backing every `web_*` tool that talks to Firecrawl
 * (scrape, crawl, research, map, extract). Each public method wraps a single
 * Firecrawl endpoint, propagates the caller's `AbortSignal`, and funnels
 * failures through {@link mapUpstreamError} so the §16.1 error envelope
 * reaches the client unchanged.
 *
 * Plan 0005 extended the surface with the Map, Extract, Session/Interact and
 * Async-Crawl methods; `crawl` itself was refactored to a sync convenience
 * that internally polls Firecrawl's async `/v1/crawl/:id` endpoint until the
 * job completes or the configured soft cap fires. Plan 0008 removed the
 * Session/Interact methods in favor of the Playwright-backed browser tools
 * shipping in plan 0009/0010.
 */
import type { Config } from "../config.js";
import type {
  FirecrawlCrawlJob,
  FirecrawlCrawlOptions,
  FirecrawlCrawlResult,
  FirecrawlCrawlStatus,
  FirecrawlExtractOptions,
  FirecrawlExtractResult,
  FirecrawlMapOptions,
  FirecrawlMapResult,
  FirecrawlScrapeOptions,
  FirecrawlScrapeResult,
} from "./firecrawl-types.js";

import { mapUpstreamError } from "../errors.js";
import {
  extractJobId,
  extractUrlList,
  firecrawlRequest,
  isScrapeRoot,
  normalizePage,
  parseCrawlStatus,
  parseExtractResult,
  pollCrawlStatus,
} from "./firecrawl-parsers.js";
import { ensureOk } from "./http.js";

export type {
  FirecrawlCrawlJob,
  FirecrawlCrawlOptions,
  FirecrawlCrawlResult,
  FirecrawlCrawlStatus,
  FirecrawlExtractOptions,
  FirecrawlExtractResult,
  FirecrawlMapOptions,
  FirecrawlMapResult,
  FirecrawlScrapeOptions,
  FirecrawlScrapeResult,
} from "./firecrawl-types.js";

/** REST wrapper around Firecrawl with abort-signal propagation and error mapping. */
export class FirecrawlClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  public constructor(config: Config) {
    // Strip a single trailing slash so `${baseUrl}/v1/...` produces a stable
    // URL. Using a single-character anchor avoids regex super-linear moves.
    this.baseUrl = config.firecrawlBaseUrl.endsWith("/")
      ? config.firecrawlBaseUrl.slice(0, -1)
      : config.firecrawlBaseUrl;
    this.apiKey = config.firecrawlApiKey;
  }

  /**
   * Scrapes a single URL via Firecrawl.
   *
   * TODO(Schritt 4): align the request body with the `/tools/scrape` Zod
   * schema once it exists.
   */
  public async scrape(
    url: string,
    opts: FirecrawlScrapeOptions,
    signal?: AbortSignal,
  ): Promise<FirecrawlScrapeResult> {
    const data = await firecrawlRequest({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/v1/scrape",
      method: "POST",
      body: { url, formats: opts.formats, onlyMainContent: opts.onlyMainContent },
      signal,
    });
    const root = isScrapeRoot(data) ? data : undefined;
    return normalizePage(root?.data, url);
  }

  /**
   * Synchronous-looking crawl convenience: starts an async Firecrawl crawl
   * job, polls its status until completion or the soft cap fires, and
   * returns the accumulated page list. The soft cap (`CRAWL_SYNC_SOFT_CAP_MS`
   * in `src/timeouts.ts`) ensures the response always lands before the hard
   * route-timeout — at which point a snapshot with `status: "in_progress"`
   * plus the `jobId` is returned so the caller can resume polling via
   * `getCrawlStatus`.
   */
  public async crawl(
    url: string,
    opts: FirecrawlCrawlOptions,
    signal?: AbortSignal,
  ): Promise<FirecrawlCrawlResult> {
    const startedAt = Date.now();
    const job = await this.startCrawl(url, opts, signal);
    const status = await pollCrawlStatus(
      async (sig) => this.getCrawlStatus(job.jobId, sig),
      startedAt,
      signal,
    );
    return {
      status: status.status === "completed" ? "completed" : "in_progress",
      jobId: job.jobId,
      pages: status.pages,
      stats: {
        pagesScraped: status.pages.length,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Starts an async Firecrawl crawl job and returns the `jobId` so the caller
   * can poll status later. Backs both `web_crawl_start` and the internal
   * polling loop in {@link FirecrawlClient.crawl}.
   */
  public async startCrawl(
    url: string,
    opts: FirecrawlCrawlOptions,
    signal?: AbortSignal,
  ): Promise<FirecrawlCrawlJob> {
    const data = await firecrawlRequest({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/v1/crawl",
      method: "POST",
      body: {
        url,
        maxDepth: opts.maxDepth,
        limit: opts.maxPages,
        includePaths: opts.includePatterns,
        excludePaths: opts.excludePatterns,
      },
      signal,
    });
    const jobId = extractJobId(data);
    if (jobId === undefined) {
      throw mapUpstreamError(new Error("Firecrawl crawl response missing job id"), {
        service: "firecrawl",
        signal,
      });
    }
    return { jobId };
  }

  /**
   * Reads a crawl job's current status. Returns the running status plus the
   * pages accumulated so far; the caller decides whether to keep polling.
   */
  public async getCrawlStatus(jobId: string, signal?: AbortSignal): Promise<FirecrawlCrawlStatus> {
    const data = await firecrawlRequest({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: `/v1/crawl/${encodeURIComponent(jobId)}`,
      method: "GET",
      signal,
    });
    return parseCrawlStatus(data);
  }

  // Map / Extract / Session / Interact -------------------------------------

  /** Discovers indexed URLs reachable from `url` (Firecrawl `/v1/map`). */
  public async map(
    url: string,
    opts: FirecrawlMapOptions,
    signal?: AbortSignal,
  ): Promise<FirecrawlMapResult> {
    const data = await firecrawlRequest({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/v1/map",
      method: "POST",
      body: { url, search: opts.search, limit: opts.maxUrls },
      signal,
    });
    return { urls: extractUrlList(data) };
  }

  /**
   * Schema-/Prompt-driven structured extraction (Firecrawl `/v1/extract`).
   * The supplied `schema` (if any) is passed through 1:1; Firecrawl owns its
   * shape.
   */
  public async extract(
    urls: readonly string[],
    opts: FirecrawlExtractOptions,
    signal?: AbortSignal,
  ): Promise<FirecrawlExtractResult> {
    const data = await firecrawlRequest({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/v1/extract",
      method: "POST",
      body: {
        urls,
        prompt: opts.prompt,
        schema: opts.schema,
        systemPrompt: opts.systemPrompt,
      },
      signal,
    });
    return parseExtractResult(data);
  }

  /**
   * Lightweight readiness probe — hits the Firecrawl service root (`GET /`)
   * because Firecrawl has no dedicated `/health` endpoint (the legacy `/v1/`
   * 404s and would falsely fail a healthy scrape API). The bearer token is
   * included so a broken key still produces a clear upstream error on
   * Firecrawl Cloud; the root handler ignores the header otherwise.
   */
  public async probe(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal,
      });
      await ensureOk(response, "firecrawl");
    } catch (error) {
      throw mapUpstreamError(error, { service: "firecrawl", signal });
    }
  }
}
