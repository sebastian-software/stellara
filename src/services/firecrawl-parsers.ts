import { setTimeout as delay } from "node:timers/promises";

/**
 * Response parsers, type guards and small request-side helpers shared across
 * `FirecrawlClient`'s many endpoint methods. Extracted from
 * `firecrawl.ts` so the class file stays inside the project-wide per-file
 * budget. Each helper is intentionally defensive: Firecrawl's field names
 * drift occasionally (e.g. `id` vs `jobId`, `links` vs `urls`), so we
 * tolerate both shapes when we can without silently masking a genuine
 * missing-field bug.
 */
import type {
  FirecrawlCrawlStatus,
  FirecrawlExtractResult,
  FirecrawlScrapeResult,
} from "./firecrawl-types.js";

import { mapUpstreamError } from "../errors.js";
import { CRAWL_SYNC_SOFT_CAP_MS } from "../timeouts.js";
import { ensureOk } from "./http.js";

/** Starting interval for the async-crawl polling loop. */
const INITIAL_POLL_INTERVAL_MS = 2000;

/** Upper bound for the exponential backoff in the polling loop. */
const MAX_POLL_INTERVAL_MS = 10_000;

/**
 * Polls a Firecrawl crawl job until it reaches a terminal state, the soft
 * cap fires, or the caller's signal aborts. Geometric backoff from 2 s up to
 * 10 s per poll keeps the request cheap on slow crawls without delaying the
 * happy path. The status fetch itself is delegated via `fetchStatus` so the
 * helper stays decoupled from `FirecrawlClient`.
 */
export async function pollCrawlStatus(
  fetchStatus: (signal?: AbortSignal) => Promise<FirecrawlCrawlStatus>,
  startedAtMs: number,
  signal?: AbortSignal,
): Promise<FirecrawlCrawlStatus> {
  let intervalMs = INITIAL_POLL_INTERVAL_MS;
  for (;;) {
    const elapsed = Date.now() - startedAtMs;
    const remainingBudget = CRAWL_SYNC_SOFT_CAP_MS - elapsed;
    if (remainingBudget <= 0) {
      return fetchStatus(signal);
    }
    const sleepMs = Math.min(intervalMs, Math.max(remainingBudget, 100));
    await delay(sleepMs, undefined, { signal });
    const status = await fetchStatus(signal);
    if (status.status !== "scraping") {
      return status;
    }
    intervalMs = Math.min(intervalMs * 2, MAX_POLL_INTERVAL_MS);
  }
}

/**
 * Inputs accepted by {@link firecrawlRequest}. Bundles the bearer header
 * with the request method/body so each `FirecrawlClient` method becomes a
 * one-line invocation plus a parser call.
 */
export type FirecrawlRequestArgs = {
  baseUrl: string;
  apiKey: string;
  path: string;
  method: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
};

/**
 * Single transport helper for every Firecrawl REST call: builds the
 * authenticated request, throws via `mapUpstreamError` on transport
 * failures, runs `ensureOk` for non-2xx and returns the parsed JSON body.
 */
export async function firecrawlRequest(args: FirecrawlRequestArgs): Promise<unknown> {
  try {
    const response = await fetch(`${args.baseUrl}${args.path}`, {
      method: args.method,
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
      },
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: args.signal,
    });
    await ensureOk(response, "firecrawl");
    const data: unknown = await response.json();
    return data;
  } catch (error) {
    throw mapUpstreamError(error, { service: "firecrawl", signal: args.signal });
  }
}

/** Strict-object type guard — also rejects arrays. */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Internal: page-shape sub-record returned by Firecrawl. */
type FirecrawlPage = {
  url?: null | string;
  markdown?: null | string;
  html?: null | string;
  metadata?: null | Record<string, unknown>;
};

type FirecrawlScrapeRoot = {
  data?: FirecrawlPage | null;
};

function isFirecrawlPage(value: unknown): value is FirecrawlPage {
  return isObjectLike(value);
}

/** Type guard for the `{ data: page }` envelope returned by `/v1/scrape`. */
export function isScrapeRoot(value: unknown): value is FirecrawlScrapeRoot {
  return isObjectLike(value);
}

/**
 * Pulls the `jobId` out of a `/v1/crawl` response. Firecrawl's modern shape is
 * `{ success: true, id: "...", url: "..." }`; we tolerate the legacy
 * `{ jobId: "..." }` field too so future API drift does not silently break.
 */
export function extractJobId(data: unknown): string | undefined {
  if (!isObjectLike(data)) return undefined;
  const candidate = data.id ?? data.jobId;
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}

/**
 * Reads the list of URLs out of a `/v1/map` response. Firecrawl typically
 * returns `{ links: [...] }`; we fall back to `{ urls: [...] }` so the
 * wrapper survives minor field-name drift.
 */
export function extractUrlList(data: unknown): string[] {
  if (!isObjectLike(data)) return [];
  const candidate = data.links ?? data.urls;
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** Coerces a `/v1/crawl/:id` response into {@link FirecrawlCrawlStatus}. */
export function parseCrawlStatus(data: unknown): FirecrawlCrawlStatus {
  if (!isObjectLike(data)) {
    return { status: "failed", completed: 0, total: 0, pages: [] };
  }
  const rawStatus = typeof data.status === "string" ? data.status : "scraping";
  const status = isCrawlStatusValue(rawStatus) ? rawStatus : "scraping";
  const completed = typeof data.completed === "number" ? data.completed : 0;
  const total = typeof data.total === "number" ? data.total : 0;
  const rawPages = Array.isArray(data.data) ? data.data : [];
  const pages = rawPages.map((entry) => normalizePage(entry));
  return { status, completed, total, pages };
}

function isCrawlStatusValue(value: string): value is FirecrawlCrawlStatus["status"] {
  return (
    value === "scraping" || value === "completed" || value === "failed" || value === "cancelled"
  );
}

/** Coerces a `/v1/extract` response into {@link FirecrawlExtractResult}. */
export function parseExtractResult(data: unknown): FirecrawlExtractResult {
  if (!isObjectLike(data)) {
    return { data: undefined, status: "failed" };
  }
  const rawStatus = typeof data.status === "string" ? data.status : "completed";
  const status = isExtractStatus(rawStatus) ? rawStatus : "completed";
  return { data: data.data, status };
}

function isExtractStatus(value: string): value is FirecrawlExtractResult["status"] {
  return value === "completed" || value === "failed" || value === "in_progress";
}

/** Normalizes a raw page object from Firecrawl into the wrapper return shape. */
export function normalizePage(raw: unknown, fallbackUrl?: string): FirecrawlScrapeResult {
  const safePage: FirecrawlPage = isFirecrawlPage(raw) ? raw : {};
  const url = safePage.url ?? fallbackUrl ?? "";
  const page: FirecrawlScrapeResult = { url };
  const metadata = safePage.metadata;
  if (metadata !== null && metadata !== undefined) {
    page.metadata = metadata;
    const title = metadata.title;
    if (typeof title === "string" && title !== "") {
      page.title = title;
    }
  }
  if (typeof safePage.markdown === "string") page.markdown = safePage.markdown;
  if (typeof safePage.html === "string") page.html = safePage.html;
  return page;
}
