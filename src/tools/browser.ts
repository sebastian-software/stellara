/**
 * Tool-layer for the six Playwright-backed `browser_*` MCP tools shipped by
 * plan 0009 (concept §8.19-§8.24). Each export wraps the matching
 * {@link PlaywrightClient} method in `withTimeout` so the per-route hard cap
 * from §17 is enforced uniformly across the REST and MCP transports.
 *
 * Unlike the Firecrawl-backed tools, every browser function takes the
 * resolved `userId` (from the Stellara auth hook, §6.3) so the service can
 * enforce per-user session ownership and the per-user concurrency cap
 * without having to thread Fastify request objects through the call.
 */
import type { FastifyInstance } from "fastify";

import type {
  BrowserContentRequest,
  BrowserCookiesRequest,
  BrowserEvalRequest,
  BrowserHarRequest,
  BrowserInteractRequest,
  BrowserNavigateRequest,
  BrowserPdfRequest,
  BrowserScreenshotRequest,
  BrowserSessionStartRequest,
  BrowserSessionStopRequest,
  BrowserStorageRequest,
  BrowserTabsRequest,
} from "../schemas/browser.js";
import type {
  PlaywrightClient,
  PlaywrightContentResult,
  PlaywrightCookiesResult,
  PlaywrightEvalResult,
  PlaywrightHarResult,
  PlaywrightInteractResult,
  PlaywrightNavigateResult,
  PlaywrightPdfResult,
  PlaywrightScreenshotResult,
  PlaywrightSessionResult,
  PlaywrightStorageResult,
  PlaywrightTabsResult,
} from "../services/playwright.js";

import { AppError, ErrorCode } from "../errors.js";
import { PER_ROUTE_TIMEOUTS_MS, withTimeout } from "../timeouts.js";

/** Response shape returned by {@link runBrowserSessionStart}. */
export type BrowserSessionStartResult = PlaywrightSessionResult;

/** Response shape returned by {@link runBrowserSessionStop}. */
export type BrowserSessionStopResult = { stopped: true };

/** Response shape returned by {@link runBrowserNavigate}. */
export type BrowserNavigateResult = PlaywrightNavigateResult;

/** Response shape returned by {@link runBrowserInteract}. */
export type BrowserInteractResult = PlaywrightInteractResult;

/** Response shape returned by {@link runBrowserScreenshot}. */
export type BrowserScreenshotResult = PlaywrightScreenshotResult;

/** Response shape returned by {@link runBrowserContent}. */
export type BrowserContentResult = PlaywrightContentResult;

/** Response shape returned by {@link runBrowserEval}. */
export type BrowserEvalResult = PlaywrightEvalResult;

/** Response shape returned by {@link runBrowserPdf}. */
export type BrowserPdfResult = PlaywrightPdfResult;

/** Response shape returned by {@link runBrowserCookies}. */
export type BrowserCookiesResult = PlaywrightCookiesResult;

/** Response shape returned by {@link runBrowserStorage}. */
export type BrowserStorageResult = PlaywrightStorageResult;

/** Response shape returned by {@link runBrowserHar}. */
export type BrowserHarResult = PlaywrightHarResult;

/** Response shape returned by {@link runBrowserTabs}. */
export type BrowserTabsResult = PlaywrightTabsResult;

/**
 * Narrows `app.services.playwright` to a non-optional client.
 *
 * Routes are only registered when `Config.features.playwright` is on (see
 * `src/server.ts`), so this guard fires only on a bootstrap-wiring bug —
 * never on user input. Surfacing it as INTERNAL_ERROR keeps the
 * deactivated-feature signal distinct from missing credentials at boot.
 */
function requirePlaywright(app: FastifyInstance): PlaywrightClient {
  const client = app.services.playwright;
  if (client === undefined) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Playwright service is not configured for this deployment",
    });
  }
  return client;
}

/** Executes `browser_session_start` via the resolved Playwright client. */
export async function runBrowserSessionStart(
  app: FastifyInstance,
  userId: string,
  input: BrowserSessionStartRequest,
): Promise<BrowserSessionStartResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserSessionStart, async (signal) =>
    client.startSession({ userId, url: input.url, stealth: input.stealth, signal }),
  );
}

/** Executes `browser_session_stop`. */
export async function runBrowserSessionStop(
  app: FastifyInstance,
  userId: string,
  input: BrowserSessionStopRequest,
): Promise<BrowserSessionStopResult> {
  const client = requirePlaywright(app);
  await withTimeout(PER_ROUTE_TIMEOUTS_MS.browserSessionStop, async () =>
    client.stopSession({ sessionId: input.sessionId, userId }),
  );
  return { stopped: true };
}

/** Executes `browser_navigate`. */
export async function runBrowserNavigate(
  app: FastifyInstance,
  userId: string,
  input: BrowserNavigateRequest,
): Promise<BrowserNavigateResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserNavigate, async (signal) =>
    client.navigate({ sessionId: input.sessionId, userId, url: input.url, signal }),
  );
}

/** Executes `browser_interact` (action chain). */
export async function runBrowserInteract(
  app: FastifyInstance,
  userId: string,
  input: BrowserInteractRequest,
): Promise<BrowserInteractResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserInteract, async (signal) =>
    client.interact({ sessionId: input.sessionId, userId, actions: input.actions, signal }),
  );
}

/** Executes `browser_screenshot`. */
export async function runBrowserScreenshot(
  app: FastifyInstance,
  userId: string,
  input: BrowserScreenshotRequest,
): Promise<BrowserScreenshotResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserScreenshot, async (signal) =>
    client.screenshot({
      sessionId: input.sessionId,
      userId,
      selector: input.selector,
      fullPage: input.fullPage,
      signal,
    }),
  );
}

/** Executes `browser_content`. */
export async function runBrowserContent(
  app: FastifyInstance,
  userId: string,
  input: BrowserContentRequest,
): Promise<BrowserContentResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserContent, async (signal) =>
    client.content({ sessionId: input.sessionId, userId, format: input.format, signal }),
  );
}

/** Executes `browser_eval` (JS expression in the page's V8 context). */
export async function runBrowserEval(
  app: FastifyInstance,
  userId: string,
  input: BrowserEvalRequest,
): Promise<BrowserEvalResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserEval, async (signal) =>
    client.eval({
      sessionId: input.sessionId,
      userId,
      expression: input.expression,
      signal,
    }),
  );
}

/** Executes `browser_pdf` (PDF render of the active page). */
export async function runBrowserPdf(
  app: FastifyInstance,
  userId: string,
  input: BrowserPdfRequest,
): Promise<BrowserPdfResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserPdf, async (signal) =>
    client.pdf({
      sessionId: input.sessionId,
      userId,
      format: input.format,
      landscape: input.landscape,
      scale: input.scale,
      signal,
    }),
  );
}

/** Executes `browser_cookies` (get/set/clear on the session context). */
export async function runBrowserCookies(
  app: FastifyInstance,
  userId: string,
  input: BrowserCookiesRequest,
): Promise<BrowserCookiesResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserCookies, async (signal) =>
    client.cookies({ ...input, userId, signal }),
  );
}

/** Executes `browser_storage` (get/set/clear on local/sessionStorage). */
export async function runBrowserStorage(
  app: FastifyInstance,
  userId: string,
  input: BrowserStorageRequest,
): Promise<BrowserStorageResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserStorage, async (signal) =>
    client.storage({ ...input, userId, signal }),
  );
}

/** Executes `browser_har` (start/stop the HAR recorder). */
export async function runBrowserHar(
  app: FastifyInstance,
  userId: string,
  input: BrowserHarRequest,
): Promise<BrowserHarResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserHar, async (signal) =>
    client.har({ sessionId: input.sessionId, mode: input.mode, userId, signal }),
  );
}

/** Executes `browser_tabs` (list/switch/close/new on the tab array). */
export async function runBrowserTabs(
  app: FastifyInstance,
  userId: string,
  input: BrowserTabsRequest,
): Promise<BrowserTabsResult> {
  const client = requirePlaywright(app);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.browserTabs, async (signal) =>
    client.tabs({ ...input, userId, signal }),
  );
}
