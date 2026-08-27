/**
 * Per-route timeout configuration and abort-controlled helper used by the
 * eight tool routes per concept §17.
 *
 * Route handlers wrap their upstream calls in {@link withTimeout} so the
 * `AbortSignal` propagates uniformly into Exa, Firecrawl, Qdrant and the
 * embedding provider. When the timer fires the abort cancels in-flight work
 * and the call's `mapUpstreamError` step renders the failure as `TIMEOUT`.
 */
import { AppError, ErrorCode, mapUpstreamError } from "./errors.js";

/**
 * Route-level hard caps per concept §17. The keys mirror the eight MCP tool
 * names so handlers can index by the operation they implement.
 */
export const PER_ROUTE_TIMEOUTS_MS = {
  search: 10_000,
  scrape: 30_000,
  crawl: 60_000,
  research: 60_000,
  memoryUpsert: 15_000,
  memorySearch: 10_000,
  memoryList: 10_000,
  memoryDelete: 10_000,
  // Plan 0005 — additional Firecrawl tools. Plan 0008 removed the three
  // interactive entries (`sessionStart`, `interact`, `interactStop`) along
  // with the underlying Firecrawl session/interact tools; the replacement
  // browser tool family ships via plan 0009/0010 with its own timeout keys.
  map: 60_000,
  extract: 90_000,
  crawlStart: 10_000,
  crawlStatus: 15_000,
  // Plan 0006 — lightweight HTTP-fetch tools (§8.17/§8.18). Same cap for
  // both because the GraphQL tool only adds JSON-body assembly on top of
  // the generic fetch path.
  fetch: 15_000,
  graphql: 15_000,
  // Plan 0014 — read-only siblings `web_get` / `web_graphql_query`. Same cap
  // as their write-capable counterparts; they share the `runHttpFetch` path.
  get: 15_000,
  graphqlQuery: 15_000,
  // Plan 0009 — Playwright-backed browser tools (§8.19+). Limit-Check +
  // browser-context spawn + initial navigation can take a moment; the
  // action-chain cap matches Firecrawl's old per-route Interact budget.
  browserSessionStart: 60_000,
  browserSessionStop: 5000,
  browserNavigate: 30_000,
  browserInteract: 60_000,
  browserScreenshot: 30_000,
  browserContent: 15_000,
  // Plan 0010 — comprehensive `browser_*` extension.
  browserEval: 30_000,
  browserPdf: 60_000,
  browserCookies: 5000,
  browserStorage: 5000,
  browserHar: 30_000,
  browserTabs: 10_000,
  // Plan 0013 — domain availability tool. RDAP and WHOIS responses are
  // typically sub-300 ms; the 10-second cap absorbs the rare slow-network
  // case plus a discovery roundtrip to `whois.iana.org`.
  domainAvailability: 10_000,
} as const;

/**
 * Soft cap the synchronous `web_crawl` uses to bail out of its polling loop
 * before the hard cap from {@link PER_ROUTE_TIMEOUTS_MS.crawl} converts the
 * request into a 504 TIMEOUT. When the soft cap fires the route returns an
 * `in_progress` snapshot with the current `jobId` so the caller can resume
 * via `web_crawl_status` (plan 0005 §Polling-Cadence).
 */
export const CRAWL_SYNC_SOFT_CAP_MS = 55_000;

/** Name of any operation supported by {@link PER_ROUTE_TIMEOUTS_MS}. */
export type RouteTimeoutKey = keyof typeof PER_ROUTE_TIMEOUTS_MS;

/**
 * Runs `fn` with an `AbortSignal` that auto-aborts after `timeoutMs`.
 *
 * When the timer fires, the caller's upstream call rejects (either via its
 * own `mapUpstreamError` step or by way of the raw abort). This helper rethrows
 * the resulting error so domain {@link AppError}s pass through unchanged and
 * unknown errors funnel through {@link mapUpstreamError} — guaranteeing the
 * §16.1 envelope reaches the client regardless of how the upstream surfaces
 * the abort.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (AppError.is(error)) throw error;
    throw mapUpstreamError(error, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forces the §16.2 `TIMEOUT` code when the helper's signal has already fired,
 * even if the upstream resolved with a non-timeout error. Used by the research
 * route's soft-cap branch which decides per-source whether a failure counts as
 * a timeout or a genuine upstream issue.
 */
export function timeoutError(service: string): AppError {
  return new AppError({
    code: ErrorCode.TIMEOUT,
    details: { service },
  });
}
