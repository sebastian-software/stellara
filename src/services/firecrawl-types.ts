/**
 * Type definitions for the `FirecrawlClient` class — extracted from
 * `firecrawl.ts` so the class file stays inside the project-wide per-file
 * budget. Pure type declarations: no runtime, no imports beyond
 * structural primitives.
 */

/** Options accepted by `FirecrawlClient.scrape`. */
export type FirecrawlScrapeOptions = {
  /** Formats to request — typically `["markdown"]` or `["markdown","html"]`. */
  formats?: string[];
  /** When true Firecrawl strips chrome, nav, ads. */
  onlyMainContent?: boolean;
};

/** Single scraped page returned by Firecrawl. */
export type FirecrawlScrapeResult = {
  url: string;
  title?: string;
  markdown?: string;
  html?: string;
  metadata?: Record<string, unknown>;
};

/** Options accepted by `FirecrawlClient.crawl`. */
export type FirecrawlCrawlOptions = {
  maxDepth?: number;
  maxPages?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
};

/** Combined result of a Firecrawl crawl operation. */
export type FirecrawlCrawlResult = {
  /**
   * Per-job status. `completed` means Firecrawl finished while the sync
   * wrapper was polling. `in_progress` means the soft cap fired first; the
   * caller can resume polling via `FirecrawlClient.getCrawlStatus`.
   */
  status: "completed" | "in_progress";
  /** Firecrawl-issued job id, populated for both terminal states. */
  jobId: string;
  pages: FirecrawlScrapeResult[];
  stats: {
    pagesScraped: number;
    durationMs: number;
  };
};

/** Options accepted by `FirecrawlClient.map`. */
export type FirecrawlMapOptions = {
  /** Optional filter query passed to Firecrawl's discovery heuristic. */
  search?: string;
  /** Caller-imposed cap on the returned URL set. */
  maxUrls?: number;
};

/** Result returned by `FirecrawlClient.map`. */
export type FirecrawlMapResult = {
  urls: string[];
};

/** Options accepted by `FirecrawlClient.extract`. */
export type FirecrawlExtractOptions = {
  prompt?: string;
  schema?: Record<string, unknown>;
  systemPrompt?: string;
};

/** Result returned by `FirecrawlClient.extract`. */
export type FirecrawlExtractResult = {
  data: unknown;
  status: "completed" | "failed" | "in_progress";
};

/** Result returned by `FirecrawlClient.startCrawl`. */
export type FirecrawlCrawlJob = {
  jobId: string;
};

/** Result returned by `FirecrawlClient.getCrawlStatus`. */
export type FirecrawlCrawlStatus = {
  status: "cancelled" | "completed" | "failed" | "scraping";
  completed: number;
  total: number;
  pages: FirecrawlScrapeResult[];
};
