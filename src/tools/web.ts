/**
 * Shared orchestration for the four web tools (`search`, `scrape`, `crawl`,
 * `research`) per concept §8.1–§8.4.
 *
 * Both the REST route handlers (`src/routes/{search,scrape,crawl,research}.ts`)
 * and the MCP `tools/call` dispatcher (`src/routes/mcp/tools.ts`) delegate to
 * these functions so a single implementation covers both surfaces and the two
 * transports cannot drift apart. Per-route timeouts from §17 wrap every
 * upstream call through {@link withTimeout}; soft budgets inside
 * {@link runWebResearch} bound the parallel Firecrawl scrapes.
 */
import type { FastifyInstance } from "fastify";

import type {
  CrawlRequest,
  CrawlStartRequest,
  CrawlStatusRequest,
  ExtractRequest,
  MapRequest,
  ResearchRequest,
  ScrapeRequest,
  SearchRequest,
} from "../schemas/web.js";
import type { ExaClient, ExaSearchResult } from "../services/exa.js";
import type {
  FirecrawlCrawlJob,
  FirecrawlCrawlResult,
  FirecrawlCrawlStatus,
  FirecrawlExtractResult,
  FirecrawlMapResult,
  FirecrawlScrapeResult,
} from "../services/firecrawl.js";

import { AppError, ErrorCode } from "../errors.js";
import { safeExternalUrl } from "../schemas/common.js";
import { PER_ROUTE_TIMEOUTS_MS, withTimeout } from "../timeouts.js";

/**
 * Narrows {@link FastifyInstance.services.exa} to a non-optional client.
 *
 * Tool routes that depend on Exa are only registered when `Config.features.exa`
 * is on (see `src/server.ts`), so this guard fires only on a bootstrap-wiring
 * bug — never on user input. Surfacing it as INTERNAL_ERROR keeps the
 * deactivated-feature signal distinct from missing credentials at boot.
 */
function requireExa(app: FastifyInstance): ExaClient {
  const exa = app.services.exa;
  if (exa === undefined) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Exa service is not configured for this deployment",
    });
  }
  return exa;
}

/** Response shape returned by {@link runWebSearch}. */
export type WebSearchResult = { results: ExaSearchResult[] };

/** Response shape returned by {@link runWebScrape}. */
export type WebScrapeResult = FirecrawlScrapeResult;

/** Response shape returned by {@link runWebCrawl}. */
export type WebCrawlResult = FirecrawlCrawlResult;

/** Response shape returned by {@link runWebMap}. */
export type WebMapResult = FirecrawlMapResult;

/** Response shape returned by {@link runWebExtract}. */
export type WebExtractResult = FirecrawlExtractResult;

/** Response shape returned by {@link runWebCrawlStart}. */
export type WebCrawlStartResult = FirecrawlCrawlJob;

/** Response shape returned by {@link runWebCrawlStatus}. */
export type WebCrawlStatusResult = FirecrawlCrawlStatus;

/** Single source entry returned by {@link runWebResearch}. */
export type ResearchSource = {
  url: string;
  title: string;
  snippet: string;
  content?: string;
};

/** Response shape returned by {@link runWebResearch}. */
export type WebResearchResult = { query: string; sources: ResearchSource[] };

/** Executes `web_search` using the configured Exa client. */
export async function runWebSearch(
  app: FastifyInstance,
  input: SearchRequest,
): Promise<WebSearchResult> {
  const exa = requireExa(app);
  const results = await withTimeout(PER_ROUTE_TIMEOUTS_MS.search, async (signal) =>
    exa.search(input.query, { maxResults: input.maxResults, type: input.type }, signal),
  );
  return { results };
}

/** Executes `web_scrape` using the configured Firecrawl client. */
export async function runWebScrape(
  app: FastifyInstance,
  input: ScrapeRequest,
): Promise<WebScrapeResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.scrape, async (signal) =>
    app.services.firecrawl.scrape(
      input.url,
      { formats: input.formats, onlyMainContent: input.onlyMainContent },
      signal,
    ),
  );
}

/** Executes `web_crawl` using the configured Firecrawl client. */
export async function runWebCrawl(
  app: FastifyInstance,
  input: CrawlRequest,
): Promise<WebCrawlResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.crawl, async (signal) =>
    app.services.firecrawl.crawl(
      input.url,
      {
        maxDepth: input.maxDepth,
        maxPages: input.maxPages,
        includePatterns: input.includePatterns,
        excludePatterns: input.excludePatterns,
      },
      signal,
    ),
  );
}

/** Builds the §8.4 source projection from an Exa hit and the optional scrape. */
function toResearchSource(hit: ExaSearchResult, content: string | undefined): ResearchSource {
  const source: ResearchSource = {
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
  };
  if (content !== undefined && content !== "") {
    source.content = content;
  }
  return source;
}

/** Options accepted by {@link scrapeResearchSources}. */
type ScrapeBudgetOptions = {
  hits: ExaSearchResult[];
  budgetMs: number;
  outerSignal: AbortSignal;
};

/** Returns `true` if Exa's URL passes the SSRF guard from `safeExternalUrl`. */
function isExternallySafeUrl(url: string): boolean {
  return safeExternalUrl.safeParse(url).success;
}

/** Splits Exa hits into the SSRF-safe subset plus a back-pointer map. */
function partitionSafeHits(hits: readonly ExaSearchResult[]): {
  safeHits: ExaSearchResult[];
  safeIndexByOriginal: Map<number, number>;
} {
  const safeHits: ExaSearchResult[] = [];
  const safeIndexByOriginal = new Map<number, number>();
  for (const [index, hit] of hits.entries()) {
    if (isExternallySafeUrl(hit.url)) {
      safeIndexByOriginal.set(index, safeHits.length);
      safeHits.push(hit);
    }
  }
  return { safeHits, safeIndexByOriginal };
}

/**
 * Scrapes `safeHits` in parallel under a shared `softController` and returns
 * the matching `PromiseSettledResult[]`. Caller owns the abort/timer lifetime.
 */
async function settleScrapes(
  app: FastifyInstance,
  safeHits: readonly ExaSearchResult[],
  signal: AbortSignal,
): Promise<Array<PromiseSettledResult<FirecrawlScrapeResult>>> {
  return Promise.allSettled(
    safeHits.map(async (hit) =>
      app.services.firecrawl.scrape(
        hit.url,
        { formats: ["markdown"], onlyMainContent: true },
        signal,
      ),
    ),
  );
}

/**
 * Scrapes every Exa hit in parallel and honors the soft `budgetMs`.
 *
 * Pending scrapes are aborted via the shared signal once the timer fires.
 * Each `Promise.allSettled` entry maps onto a source: fulfilled scrapes carry
 * `markdown`, rejected ones (network, abort or upstream error) keep the snippet
 * but omit `content` so the response still describes the source.
 *
 * Exa-supplied URLs are also passed through {@link safeExternalUrl} before
 * Firecrawl is dialed. A poisoned search index (or an attacker-controlled
 * upstream) cannot use this branch to make Firecrawl probe localhost,
 * `qdrant:6333`, RFC1918, link-local, etc. Filtered URLs still appear in the
 * response (so the caller sees the title/snippet) but carry no `content`.
 */
async function scrapeResearchSources(
  app: FastifyInstance,
  opts: ScrapeBudgetOptions,
): Promise<ResearchSource[]> {
  const { safeHits, safeIndexByOriginal } = partitionSafeHits(opts.hits);
  // No Firecrawl work to do — short-circuit before allocating timers.
  if (safeHits.length === 0) {
    return opts.hits.map((hit) => toResearchSource(hit, undefined));
  }
  const softController = new AbortController();
  // The outer (route-level) abort still wins — bubble its cancellation through
  // to the per-source scrape so we never outrun the §17 hard cap.
  const onOuterAbort = (): void => {
    softController.abort();
  };
  opts.outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  const softTimer = setTimeout(() => {
    softController.abort();
  }, opts.budgetMs);
  try {
    const settled = await settleScrapes(app, safeHits, softController.signal);
    return opts.hits.map((hit, index) => {
      const safeIndex = safeIndexByOriginal.get(index);
      // SSRF-filtered URLs surface without `content` (snippet/title remain).
      if (safeIndex === undefined) return toResearchSource(hit, undefined);
      const outcome = settled[safeIndex];
      const content = outcome?.status === "fulfilled" ? outcome.value.markdown : undefined;
      return toResearchSource(hit, content);
    });
  } finally {
    clearTimeout(softTimer);
    opts.outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

/** Executes `web_research` (Exa search + Firecrawl scrapes within a soft budget). */
export async function runWebResearch(
  app: FastifyInstance,
  input: ResearchRequest,
): Promise<WebResearchResult> {
  const exa = requireExa(app);
  const start = Date.now();
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.research, async (signal) => {
    const hits = await exa.search(input.query, { maxResults: input.maxSources }, signal);
    const elapsed = Date.now() - start;
    const remainingBudget = Math.max(0, input.timeBudgetMs - elapsed);
    const sources =
      hits.length === 0 || remainingBudget === 0
        ? hits.map((hit) => toResearchSource(hit, undefined))
        : await scrapeResearchSources(app, {
            hits,
            budgetMs: remainingBudget,
            outerSignal: signal,
          });
    // The hard route timeout aborts via `signal` rather than rejecting
    // `scrapeResearchSources`, because that helper uses Promise.allSettled.
    // Convert the abort into a clean 504 TIMEOUT so the response semantics
    // match §17 (the soft-cap branch above still returns 200 with partial
    // content as long as the hard cap has not fired).
    if (signal.aborted) {
      throw new AppError({ code: ErrorCode.TIMEOUT, details: { service: "research" } });
    }
    return { query: input.query, sources };
  });
}

// ---------------------------------------------------------------------------
// Plan 0005 — additional Firecrawl-backed tool functions (§8.10–§8.16).
// ---------------------------------------------------------------------------

/** Executes `web_map` (sitemap discovery via Firecrawl). */
export async function runWebMap(app: FastifyInstance, input: MapRequest): Promise<WebMapResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.map, async (signal) =>
    app.services.firecrawl.map(input.url, { search: input.search, maxUrls: input.maxUrls }, signal),
  );
}

/** Executes `web_extract` (structured extraction via Firecrawl). */
export async function runWebExtract(
  app: FastifyInstance,
  input: ExtractRequest,
): Promise<WebExtractResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.extract, async (signal) =>
    app.services.firecrawl.extract(
      input.urls,
      {
        prompt: input.prompt,
        schema: input.schema,
        systemPrompt: input.systemPrompt,
      },
      signal,
    ),
  );
}

/** Executes `web_crawl_start` (async crawl, returns the Firecrawl job id). */
export async function runWebCrawlStart(
  app: FastifyInstance,
  input: CrawlStartRequest,
): Promise<WebCrawlStartResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.crawlStart, async (signal) =>
    app.services.firecrawl.startCrawl(
      input.url,
      {
        maxDepth: input.maxDepth,
        maxPages: input.maxPages,
        includePatterns: input.includePatterns,
        excludePatterns: input.excludePatterns,
      },
      signal,
    ),
  );
}

/** Executes `web_crawl_status` (polls a previously started crawl job). */
export async function runWebCrawlStatus(
  app: FastifyInstance,
  input: CrawlStatusRequest,
): Promise<WebCrawlStatusResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.crawlStatus, async (signal) =>
    app.services.firecrawl.getCrawlStatus(input.jobId, signal),
  );
}

// Plan 0006 — `runWebFetch` / `runWebGraphql` live in `./web-fetch.ts` so
// this file stays inside the per-file line budget. They are re-exported
// through `src/tools/index.ts` to keep one consumption surface for the
// REST routes and the MCP adapter table.
export {
  runWebFetch,
  runWebGet,
  runWebGraphql,
  runWebGraphqlQuery,
  type WebFetchResult,
  type WebGetResult,
  type WebGraphqlQueryResult,
  type WebGraphqlResult,
} from "./web-fetch.js";
