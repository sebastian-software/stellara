/**
 * Canonical MCP tool registry (plan 0011, concept §9).
 *
 * Each entry carries a detailed description and MCP annotations. Structured
 * outputs are joined from the name-keyed map at the bottom of this module.
 *
 * Array order defines `tools/list`; names match REST `operationId` values.
 */
import type { ToolRegistryEntry } from "./mcp.js";

import {
  browserContentRequestSchema,
  browserEvalRequestSchema,
  browserInteractRequestSchema,
  browserNavigateRequestSchema,
  browserPdfRequestSchema,
  browserScreenshotRequestSchema,
  browserSessionStartRequestSchema,
  browserSessionStopRequestSchema,
} from "./browser.js";
import { domainAvailabilityRequestSchema } from "./domain.js";
import { MCP_TOOL_OUTPUT_SCHEMAS } from "./mcp-tool-outputs.js";
import {
  mcpBrowserCookiesRequestSchema,
  mcpBrowserHarRequestSchema,
  mcpBrowserStorageRequestSchema,
  mcpBrowserTabsRequestSchema,
  mcpMemoryDeleteRequestSchema,
} from "./mcp-wrappers.js";
import {
  memoryListRequestSchema,
  memorySearchRequestSchema,
  memoryUpsertRequestSchema,
} from "./memory.js";
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
} from "./web.js";

function defineToolEntries<const T extends ReadonlyArray<Omit<ToolRegistryEntry, "outputSchema">>>(
  entries: T,
): T {
  return entries;
}

const MCP_TOOL_DEFINITIONS = defineToolEntries([
  {
    name: "web_search",
    description:
      "Semantic web search via Exa. Returns ranked URLs with title and snippet but no full body — pair it with `web_scrape` or `web_fetch` to retrieve content. Best entry point when you have a question and need to discover relevant sources.",
    feature: "exa",
    inputSchema: searchRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Web search (Exa)" },
  },
  {
    name: "web_scrape",
    description:
      "Scrape a single URL via Firecrawl and return clean Markdown (or HTML). Handles JavaScript rendering automatically; prefer this over `web_fetch` for human-facing HTML pages and over `browser_session_start` whenever the page is static enough to read in one shot.",
    feature: "firecrawl",
    inputSchema: scrapeRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Scrape URL" },
  },
  {
    name: "web_crawl",
    description:
      "Crawl multiple pages from a starting URL via Firecrawl and return their Markdown. Synchronous convenience wrapper that internally polls Firecrawl's async crawl job and bails out at a ~55-second soft cap (just below the 60-second route hard timeout), returning an `in_progress` snapshot with the current `jobId`. For crawls that need more time, use `web_crawl_start` + `web_crawl_status` instead.",
    feature: "firecrawl",
    inputSchema: crawlRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Crawl site" },
  },
  {
    name: "web_research",
    description:
      'Combined Exa search + Firecrawl scrape pipeline. Issues the query, retrieves the top sources (default 5, max 10) and scrapes each in parallel within a configurable `timeBudgetMs` soft cap (default 45 s, capped at 55 s under the 60-second route hard timeout). Returns `sources[]` with `url`, `title`, `snippet`, and — for sources that finished scraping in time — `content` as Markdown. Use it as a single-call "research this topic" tool when you would otherwise chain `web_search` and `web_scrape` yourself.',
    feature: "exa",
    inputSchema: researchRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Research topic" },
  },
  {
    name: "memory_upsert",
    description:
      "Insert or replace a memory point for the calling user. Embeds the supplied text and writes it to the user-scoped vector store; supplying an existing `id` performs a full replace (not a merge). Use it for facts or notes that should outlive the current conversation.",
    feature: "memory",
    inputSchema: memoryUpsertRequestSchema,
    annotations: { destructiveHint: true, idempotentHint: true, title: "Save to memory" },
  },
  {
    name: "memory_search",
    description:
      "Vector-search the calling user's memory points. Returns the top matches with similarity scores; strictly scoped to the bearer-token user so cross-user leaks are impossible.",
    feature: "memory",
    inputSchema: memorySearchRequestSchema,
    annotations: { readOnlyHint: true, title: "Search memory" },
  },
  {
    name: "memory_list",
    description:
      "List the calling user's memory points with cursor pagination, sorted newest-first by `updatedAt`. Use it for browsing or exporting; for relevance-based recall use `memory_search` instead.",
    feature: "memory",
    inputSchema: memoryListRequestSchema,
    annotations: { readOnlyHint: true, title: "List memory" },
  },
  {
    name: "memory_delete",
    description:
      "Delete memory points by id or filter (exclusive — exactly one of the two). Permanent and per-user scoped. Returns the count of deleted points; use `memory_list` first when in doubt about what a filter would match.",
    feature: "memory",
    inputSchema: mcpMemoryDeleteRequestSchema,
    annotations: { destructiveHint: true, title: "Delete memory" },
  },
  {
    name: "web_map",
    description:
      "Discover URLs reachable from a start URL via Firecrawl. Returns the URL list only — no content. Use it as a discovery step before deciding which pages to scrape or crawl.",
    feature: "firecrawl",
    inputSchema: mapRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Discover URLs" },
  },
  {
    name: "web_extract",
    description:
      "Extract structured data from one or more URLs via Firecrawl's LLM extractor. Pass a free-form `prompt`, a JSON-Schema `schema`, or both. Slower and pricier than `web_scrape` because of the upstream LLM call, and the scraped page content reaches that LLM verbatim — treat user-controlled URLs as a prompt-injection surface. Use it when you need parsed fields (price, author, schedule) rather than raw Markdown.",
    feature: "firecrawl",
    inputSchema: extractRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Extract structured data" },
  },
  {
    name: "web_crawl_start",
    description:
      "Start an asynchronous Firecrawl crawl job and return the job id. Use it for crawls likely to exceed the synchronous `web_crawl` soft cap; poll the returned id with `web_crawl_status`. Server-side resource cost can be significant for large crawls.",
    feature: "firecrawl",
    inputSchema: crawlStartRequestSchema,
    annotations: { openWorldHint: true, title: "Start async crawl" },
  },
  {
    name: "web_crawl_status",
    description:
      "Poll a previously started Firecrawl crawl job. Safe to call repeatedly; returns the cumulative page list plus a status discriminator. Pair with `web_crawl_start`.",
    feature: "firecrawl",
    inputSchema: crawlStatusRequestSchema,
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      title: "Poll crawl status",
    },
  },
  {
    name: "web_fetch",
    description:
      "Issue a generic HTTP request against a public endpoint. Use this for REST/JSON APIs, plain-text resources or anything where Firecrawl's HTML rendering would be wrong — prefer `web_scrape` for human-facing HTML pages. `Authorization` is passed through unchanged so authenticated APIs work. For purely read-only calls prefer the `web_get` sibling, which is restricted to safe methods and carries `readOnlyHint`.",
    feature: "fetch",
    inputSchema: fetchRequestSchema,
    annotations: { openWorldHint: true, title: "HTTP request" },
  },
  {
    name: "web_get",
    description:
      "Issue a read-only HTTP request against a public endpoint, restricted to the HTTP safe methods `GET`, `HEAD` and `OPTIONS` (no request body). The read-only sibling of `web_fetch` — reach for `web_fetch` when you need `POST`/`PUT`/`PATCH`/`DELETE` or a body. Shares the same SSRF guard, header sanitization and 10 MB body cap; `Authorization` passes through unchanged.",
    feature: "fetch",
    inputSchema: getRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "HTTP read (GET/HEAD/OPTIONS)" },
  },
  {
    name: "web_graphql",
    description:
      "Issue a GraphQL operation against a public endpoint. Builds the canonical `{ query, variables, operationName }` body, forwards `Authorization` and reuses the SSRF/header policies of `web_fetch`. GraphQL `errors` in a 200 body pass through unchanged — no synthetic throw. For pure `query` operations prefer the `web_graphql_query` sibling, which rejects mutations/subscriptions and carries `readOnlyHint`.",
    feature: "fetch",
    inputSchema: graphqlRequestSchema,
    annotations: { openWorldHint: true, title: "GraphQL request" },
  },
  {
    name: "web_graphql_query",
    description:
      "Issue a read-only GraphQL query against a public endpoint. The `query` string is parsed server-side and rejected with `BAD_REQUEST` if it contains any `mutation` or `subscription` operation — so this tool is guaranteed read-only. The read-only sibling of `web_graphql`; use `web_graphql` when you actually need a mutation. Note: unparseable queries are rejected locally with `BAD_REQUEST` (stricter than `web_graphql`, which forwards the raw query to the endpoint).",
    feature: "fetch",
    inputSchema: graphqlQueryRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "GraphQL query (read-only)" },
  },
  {
    name: "browser_session_start",
    description:
      "Open a Playwright session anchored on a URL and return a `sessionId`. Use it only for flows that need JS rendering, interaction, login state or multiple tabs — for static content `web_scrape` is faster and cheaper. Sessions auto-expire after 5 min of inactivity and 30 min total. By default the new context spoofs a realistic Linux Chrome desktop identity (de-DE, Europe/Berlin); pass `stealth: false` to keep the raw headless fingerprint.",
    feature: "playwright",
    inputSchema: browserSessionStartRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Open browser session" },
  },
  {
    name: "browser_session_stop",
    description:
      "Close a Playwright session and release its Chromium context. Always call this when you are done; the idle/hard sweeper will eventually evict forgotten sessions, but explicit close frees the slot for other users immediately.",
    feature: "playwright",
    inputSchema: browserSessionStopRequestSchema,
    annotations: { destructiveHint: true, title: "Close browser session" },
  },
  {
    name: "browser_navigate",
    description:
      "Navigate the active page of a Playwright session to a new URL. Waits for the `load` event before returning. Use it for multi-step flows within the same session; for single-URL fetches a fresh `web_scrape` or `web_fetch` is cheaper.",
    feature: "playwright",
    inputSchema: browserNavigateRequestSchema,
    annotations: { openWorldHint: true, title: "Navigate page" },
  },
  {
    name: "browser_interact",
    description:
      "Run a chain of browser actions (click, type, fill, wait, scroll, hover, press, select) against the active page. The chain aborts on the first failed step and the per-step results come back structured. Use it for form submission, login flows and any UI-driven workflow.",
    feature: "playwright",
    inputSchema: browserInteractRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Interact with page" },
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the active page or a single selector. Returns the bytes Base64-encoded; capped at 10 MB. Read-only — useful as a sanity check during automation or to surface visual evidence.",
    feature: "playwright",
    inputSchema: browserScreenshotRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Screenshot page" },
  },
  {
    name: "browser_content",
    description:
      "Read the active Playwright page's DOM as raw HTML or extracted plain text. Use it when you need the current rendered state of an interactive session; for one-shot static content `web_scrape` is the right tool.",
    feature: "playwright",
    inputSchema: browserContentRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Read page DOM" },
  },
  {
    name: "browser_eval",
    description:
      "Evaluate a JavaScript expression inside the page's V8 context. Returns the JSON-serialised result (1 MB cap); non-serialisable returns become `null`. Powerful but caller-controlled — treat it as an escape hatch when no other browser tool fits.",
    feature: "playwright",
    inputSchema: browserEvalRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Evaluate JavaScript" },
  },
  {
    name: "browser_pdf",
    description:
      "Render the active Playwright page as a PDF and return it Base64-encoded (10 MB cap). Read-only on the page state; use it to capture reports, invoices or any layout-stable artefact.",
    feature: "playwright",
    inputSchema: browserPdfRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Render PDF" },
  },
  {
    name: "browser_cookies",
    description:
      "Read or write cookies on a Playwright session context (modes: `get`, `set`, `clear`). Cookies are context-scoped and shared across every tab in the session.",
    feature: "playwright",
    inputSchema: mcpBrowserCookiesRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Manage cookies" },
  },
  {
    name: "browser_storage",
    description:
      "Read or write Web Storage (`localStorage` or `sessionStorage`) on the active Playwright page (modes: `get`, `set`, `clear`). Useful for seeding session state or inspecting what an app persisted.",
    feature: "playwright",
    inputSchema: mcpBrowserStorageRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Manage Web Storage" },
  },
  {
    name: "browser_har",
    description:
      "Start or stop the session's in-memory HAR recorder. **Privacy warning:** captured request headers include `Authorization` and `Cookie` values verbatim — only share the resulting HAR with parties you trust.",
    feature: "playwright",
    inputSchema: mcpBrowserHarRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Toggle HAR recorder" },
  },
  {
    name: "browser_tabs",
    description:
      "List, switch, close or open tabs within a Playwright session (modes: `list`, `switch`, `close`, `new`). Capped at five tabs per session; closing the last tab is rejected — use `browser_session_stop` to end the session instead.",
    feature: "playwright",
    inputSchema: mcpBrowserTabsRequestSchema,
    annotations: { destructiveHint: true, openWorldHint: true, title: "Manage tabs" },
  },
  {
    name: "domain_availability",
    description:
      "Check whether a domain is registered or available. RDAP-first via the IANA bootstrap registry (plus a DENIC override for .de), falling back to WHOIS port 43 for ccTLDs without RDAP (.eu fast path, every other TLD via IANA WHOIS discovery). Returns one of `registered`, `available`, `unsupported_tld` or `indeterminate` — no registrant data is exposed.",
    feature: "domain",
    inputSchema: domainAvailabilityRequestSchema,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Domain availability" },
  },
]);

/** Registry enriched with the canonical structured-output contract per tool. */
export const MCP_TOOLS: readonly ToolRegistryEntry[] = MCP_TOOL_DEFINITIONS.map((entry) => ({
  ...entry,
  outputSchema: MCP_TOOL_OUTPUT_SCHEMAS[entry.name],
}));
