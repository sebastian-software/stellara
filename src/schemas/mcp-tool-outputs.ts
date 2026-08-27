/** Canonical structured-output schemas keyed by the public MCP tool name. */
import * as browser from "./browser.js";
import * as domain from "./domain.js";
import * as memory from "./memory.js";
import * as web from "./web.js";

export const MCP_TOOL_OUTPUT_SCHEMAS = {
  web_search: web.searchResponseSchema,
  web_scrape: web.scrapeResponseSchema,
  web_crawl: web.crawlResponseSchema,
  web_research: web.researchResponseSchema,
  memory_upsert: memory.memoryUpsertResponseSchema,
  memory_search: memory.memorySearchResponseSchema,
  memory_list: memory.memoryListResponseSchema,
  memory_delete: memory.memoryDeleteResponseSchema,
  web_map: web.mapResponseSchema,
  web_extract: web.extractResponseSchema,
  web_crawl_start: web.crawlStartResponseSchema,
  web_crawl_status: web.crawlStatusResponseSchema,
  web_fetch: web.fetchResponseSchema,
  web_get: web.fetchResponseSchema,
  web_graphql: web.graphqlResponseSchema,
  web_graphql_query: web.graphqlResponseSchema,
  browser_session_start: browser.browserSessionStartResponseSchema,
  browser_session_stop: browser.browserSessionStopResponseSchema,
  browser_navigate: browser.browserNavigateResponseSchema,
  browser_interact: browser.browserInteractResponseSchema,
  browser_screenshot: browser.browserScreenshotResponseSchema,
  browser_content: browser.browserContentResponseSchema,
  browser_eval: browser.browserEvalResponseSchema,
  browser_pdf: browser.browserPdfResponseSchema,
  browser_cookies: browser.browserCookiesResponseSchema,
  browser_storage: browser.browserStorageResponseSchema,
  browser_har: browser.browserHarResponseSchema,
  browser_tabs: browser.browserTabsResponseSchema,
  domain_availability: domain.domainAvailabilityResponseSchema,
} as const;
