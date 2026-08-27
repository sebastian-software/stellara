/**
 * MCP `tools/call` dispatch table.
 *
 * Pulled out of `./tools.ts` so that file stays within the per-file line
 * budget. The adapter map and the `ToolCallResult` union travel together
 * because the union is what type-checks each adapter's return value
 * against the shared `runX` tool layer in `src/tools/`.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { z } from "zod/v4";

import type { McpInputSchema } from "../../schemas/mcp.js";

import {
  browserContentRequestSchema,
  browserCookiesRequestSchema,
  browserEvalRequestSchema,
  browserHarRequestSchema,
  browserInteractRequestSchema,
  browserNavigateRequestSchema,
  browserPdfRequestSchema,
  browserScreenshotRequestSchema,
  browserSessionStartRequestSchema,
  browserSessionStopRequestSchema,
  browserStorageRequestSchema,
  browserTabsRequestSchema,
} from "../../schemas/browser.js";
import { domainAvailabilityRequestSchema } from "../../schemas/domain.js";
import { mcpMemoryDeleteRequestSchema } from "../../schemas/mcp.js";
import {
  memoryListRequestSchema,
  memorySearchRequestSchema,
  memoryUpsertRequestSchema,
} from "../../schemas/memory.js";
import {
  crawlRequestSchema,
  crawlStartRequestSchema,
  crawlStatusRequestSchema,
  extractRequestSchema,
  fetchRequestSchema,
  getRequestSchema,
  graphqlQueryRequestSchema,
  graphqlRequestSchema,
  mapRequestSchema,
  researchRequestSchema,
  scrapeRequestSchema,
  searchRequestSchema,
} from "../../schemas/web.js";
import {
  type BrowserContentResult,
  type BrowserCookiesResult,
  type BrowserEvalResult,
  type BrowserHarResult,
  type BrowserInteractResult,
  type BrowserNavigateResult,
  type BrowserPdfResult,
  type BrowserScreenshotResult,
  type BrowserSessionStartResult,
  type BrowserSessionStopResult,
  type BrowserStorageResult,
  type BrowserTabsResult,
  runBrowserContent,
  runBrowserCookies,
  runBrowserEval,
  runBrowserHar,
  runBrowserInteract,
  runBrowserNavigate,
  runBrowserPdf,
  runBrowserScreenshot,
  runBrowserSessionStart,
  runBrowserSessionStop,
  runBrowserStorage,
  runBrowserTabs,
} from "../../tools/browser.js";
import { type DomainAvailabilityResult, runDomainAvailability } from "../../tools/domain.js";
import {
  type MemoryDeleteResult,
  type MemoryListResult,
  type MemorySearchResult,
  type MemoryUpsertResult,
  runMemoryDelete,
  runMemoryList,
  runMemorySearch,
  runMemoryUpsert,
} from "../../tools/memory.js";
import {
  runWebCrawl,
  runWebCrawlStart,
  runWebCrawlStatus,
  runWebExtract,
  runWebFetch,
  runWebGet,
  runWebGraphql,
  runWebGraphqlQuery,
  runWebMap,
  runWebResearch,
  runWebScrape,
  runWebSearch,
  type WebCrawlResult,
  type WebCrawlStartResult,
  type WebCrawlStatusResult,
  type WebExtractResult,
  type WebFetchResult,
  type WebGraphqlResult,
  type WebMapResult,
  type WebResearchResult,
  type WebScrapeResult,
  type WebSearchResult,
} from "../../tools/web.js";

/** Per-request context threaded through the `tools/call` pipeline. */
export type ToolCallContext = {
  app: FastifyInstance;
  userId: string;
  request: FastifyRequest;
};

/**
 * Discriminated union of every possible `tools/call` result shape. Drift
 * between the adapter map below and a `runX` tool function's return type
 * becomes a compile-time error here.
 */
export type ToolCallResult =
  | BrowserContentResult
  | BrowserCookiesResult
  | BrowserEvalResult
  | BrowserHarResult
  | BrowserInteractResult
  | BrowserNavigateResult
  | BrowserPdfResult
  | BrowserScreenshotResult
  | BrowserSessionStartResult
  | BrowserSessionStopResult
  | BrowserStorageResult
  | BrowserTabsResult
  | DomainAvailabilityResult
  | MemoryDeleteResult
  | MemoryListResult
  | MemorySearchResult
  | MemoryUpsertResult
  | WebCrawlResult
  | WebCrawlStartResult
  | WebCrawlStatusResult
  | WebExtractResult
  // `web_get` and `web_graphql_query` (plan 0014) reuse the fetch/graphql
  // response shapes, so `WebGetResult`/`WebGraphqlQueryResult` are structural
  // aliases of `WebFetchResult`/`WebGraphqlResult` and need no separate union
  // arm (adding them trips `no-duplicate-type-constituents`).
  | WebFetchResult
  | WebGraphqlResult
  | WebMapResult
  | WebResearchResult
  | WebScrapeResult
  | WebSearchResult;

/** Per-tool adapter signature. */
export type ToolAdapter = (ctx: ToolCallContext, args: unknown) => Promise<ToolCallResult>;

/**
 * Helper that parses `args` with `schema` and throws the underlying ZodError
 * on failure. Keeping the parse inline per tool gives the dispatcher full
 * TypeScript narrowing without unsafe casts.
 */
function parseArgs<T extends McpInputSchema>(schema: T, args: unknown): z.infer<T> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}

/**
 * Lookup-table from MCP tool name to its `runX`-delegating adapter. A flat
 * `Map` keeps `runToolCall` simple (linear cyclomatic complexity rather
 * than a 20-arm switch) while preserving the per-adapter narrowing the
 * compiler needs for {@link ToolCallResult}.
 */
export const TOOL_ADAPTERS: ReadonlyMap<string, ToolAdapter> = new Map<string, ToolAdapter>([
  ["web_search", async (ctx, args) => runWebSearch(ctx.app, parseArgs(searchRequestSchema, args))],
  ["web_scrape", async (ctx, args) => runWebScrape(ctx.app, parseArgs(scrapeRequestSchema, args))],
  ["web_crawl", async (ctx, args) => runWebCrawl(ctx.app, parseArgs(crawlRequestSchema, args))],
  [
    "web_research",
    async (ctx, args) => runWebResearch(ctx.app, parseArgs(researchRequestSchema, args)),
  ],
  [
    "memory_upsert",
    async (ctx, args) =>
      runMemoryUpsert(ctx.app, ctx.userId, parseArgs(memoryUpsertRequestSchema, args)),
  ],
  [
    "memory_search",
    async (ctx, args) =>
      runMemorySearch(ctx.app, ctx.userId, parseArgs(memorySearchRequestSchema, args)),
  ],
  [
    "memory_list",
    async (ctx, args) =>
      runMemoryList(ctx.app, ctx.userId, parseArgs(memoryListRequestSchema, args)),
  ],
  [
    "memory_delete",
    async (ctx, args) =>
      runMemoryDelete(ctx.app, ctx.userId, parseArgs(mcpMemoryDeleteRequestSchema, args)),
  ],
  ["web_map", async (ctx, args) => runWebMap(ctx.app, parseArgs(mapRequestSchema, args))],
  [
    "web_extract",
    async (ctx, args) => runWebExtract(ctx.app, parseArgs(extractRequestSchema, args)),
  ],
  [
    "web_crawl_start",
    async (ctx, args) => runWebCrawlStart(ctx.app, parseArgs(crawlStartRequestSchema, args)),
  ],
  [
    "web_crawl_status",
    async (ctx, args) => runWebCrawlStatus(ctx.app, parseArgs(crawlStatusRequestSchema, args)),
  ],
  ["web_fetch", async (ctx, args) => runWebFetch(ctx.app, parseArgs(fetchRequestSchema, args))],
  ["web_get", async (ctx, args) => runWebGet(ctx.app, parseArgs(getRequestSchema, args))],
  [
    "web_graphql",
    async (ctx, args) => runWebGraphql(ctx.app, parseArgs(graphqlRequestSchema, args)),
  ],
  [
    "web_graphql_query",
    async (ctx, args) => runWebGraphqlQuery(ctx.app, parseArgs(graphqlQueryRequestSchema, args)),
  ],
  [
    "browser_session_start",
    async (ctx, args) =>
      runBrowserSessionStart(
        ctx.app,
        ctx.userId,
        parseArgs(browserSessionStartRequestSchema, args),
      ),
  ],
  [
    "browser_session_stop",
    async (ctx, args) =>
      runBrowserSessionStop(ctx.app, ctx.userId, parseArgs(browserSessionStopRequestSchema, args)),
  ],
  [
    "browser_navigate",
    async (ctx, args) =>
      runBrowserNavigate(ctx.app, ctx.userId, parseArgs(browserNavigateRequestSchema, args)),
  ],
  [
    "browser_interact",
    async (ctx, args) =>
      runBrowserInteract(ctx.app, ctx.userId, parseArgs(browserInteractRequestSchema, args)),
  ],
  [
    "browser_screenshot",
    async (ctx, args) =>
      runBrowserScreenshot(ctx.app, ctx.userId, parseArgs(browserScreenshotRequestSchema, args)),
  ],
  [
    "browser_content",
    async (ctx, args) =>
      runBrowserContent(ctx.app, ctx.userId, parseArgs(browserContentRequestSchema, args)),
  ],
  [
    "browser_eval",
    async (ctx, args) =>
      runBrowserEval(ctx.app, ctx.userId, parseArgs(browserEvalRequestSchema, args)),
  ],
  [
    "browser_pdf",
    async (ctx, args) =>
      runBrowserPdf(ctx.app, ctx.userId, parseArgs(browserPdfRequestSchema, args)),
  ],
  [
    "browser_cookies",
    async (ctx, args) =>
      runBrowserCookies(ctx.app, ctx.userId, parseArgs(browserCookiesRequestSchema, args)),
  ],
  [
    "browser_storage",
    async (ctx, args) =>
      runBrowserStorage(ctx.app, ctx.userId, parseArgs(browserStorageRequestSchema, args)),
  ],
  [
    "browser_har",
    async (ctx, args) =>
      runBrowserHar(ctx.app, ctx.userId, parseArgs(browserHarRequestSchema, args)),
  ],
  [
    "browser_tabs",
    async (ctx, args) =>
      runBrowserTabs(ctx.app, ctx.userId, parseArgs(browserTabsRequestSchema, args)),
  ],
  [
    "domain_availability",
    async (ctx, args) =>
      runDomainAvailability(ctx.app, parseArgs(domainAvailabilityRequestSchema, args)),
  ],
]);
