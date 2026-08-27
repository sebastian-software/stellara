/**
 * Aggregator for the six Playwright-backed `browser_*` routes (plan 0009).
 *
 * Mirrors the layout of `routes/oauth/index.ts` so the top-level server
 * bootstrap registers a single `registerBrowserRoutes` call instead of
 * threading six individual imports through `registerToolRoutes`.
 */
import type { FastifyInstance } from "fastify";

import { registerBrowserContentRoute } from "./content.js";
import { registerBrowserCookiesRoute } from "./cookies.js";
import { registerBrowserEvalRoute } from "./eval.js";
import { registerBrowserHarRoute } from "./har.js";
import { registerBrowserInteractRoute } from "./interact.js";
import { registerBrowserNavigateRoute } from "./navigate.js";
import { registerBrowserPdfRoute } from "./pdf.js";
import { registerBrowserScreenshotRoute } from "./screenshot.js";
import { registerBrowserSessionStartRoute } from "./session-start.js";
import { registerBrowserSessionStopRoute } from "./session-stop.js";
import { registerBrowserStorageRoute } from "./storage.js";
import { registerBrowserTabsRoute } from "./tabs.js";

/** Registers every `browser_*` REST route on the given Fastify instance. */
export function registerBrowserRoutes(app: FastifyInstance): void {
  registerBrowserSessionStartRoute(app);
  registerBrowserSessionStopRoute(app);
  registerBrowserNavigateRoute(app);
  registerBrowserInteractRoute(app);
  registerBrowserScreenshotRoute(app);
  registerBrowserContentRoute(app);
  // Plan 0010 — comprehensive extension.
  registerBrowserEvalRoute(app);
  registerBrowserPdfRoute(app);
  registerBrowserCookiesRoute(app);
  registerBrowserStorageRoute(app);
  registerBrowserHarRoute(app);
  registerBrowserTabsRoute(app);
}
