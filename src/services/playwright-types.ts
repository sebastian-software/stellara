/**
 * Type definitions for the `PlaywrightClient` class — extracted from
 * `playwright.ts` so the class file stays inside the project-wide per-file
 * budget. Pure type declarations: no runtime code apart from one shared
 * numeric constant that both the client and the extension helpers reference.
 */

import type { BrowserContext, Page } from "playwright";

import type { BrowserAction } from "../schemas/browser.js";
import type { BrowserActionResult } from "./playwright-actions.js";
import type { HarBuffer } from "./playwright-har.js";

/**
 * Internal pool entry — one per active browser context. Stored in a
 * `Map<sessionId, SessionEntry>` on the `PlaywrightClient`. Lives
 * here (not in the client) so the per-tool helpers in
 * `playwright-extensions.ts` can reference it without creating an
 * import cycle.
 */
export type SessionEntry = {
  sessionId: string;
  userId: string;
  context: BrowserContext;
  pages: Page[];
  activePageIndex: number;
  harBuffer?: HarBuffer;
  createdAt: number;
  lastActionAt: number;
  hardDeadline: number;
};

/** Hard cap on parallel tabs per session — plan 0010 architecture. */
export const MAX_TABS_PER_SESSION = 5;

/** Common envelope every per-session call carries. */
type SessionOpsBase = {
  sessionId: string;
  userId: string;
  signal: AbortSignal;
};

/** Options accepted by `PlaywrightClient.startSession`. */
export type StartSessionOptions = {
  userId: string;
  url: string;
  /**
   * Plan 0012 — when `true` (the schema default), the new
   * `BrowserContext` spoofs the Linux Chrome stable identity (de-DE,
   * Europe/Berlin, 1366×768). When `false`, no per-context identity
   * override is applied; the stealth-plugin patches stay active because
   * they bind to the shared browser instance. The operator kill-switch
   * `STELLARA_PLAYWRIGHT_STEALTH=false` disables both layers and forces
   * this flag to be ignored.
   *
   * Optional at the service-API boundary because the Zod schema for
   * `browser_session_start` already defaults the field to `true` before
   * it reaches the tool layer — callers that bypass the schema (direct
   * service consumers, tests) keep the default behaviour without having
   * to thread the flag through every call site.
   */
  stealth?: boolean;
  signal: AbortSignal;
};

/** Options accepted by `PlaywrightClient.stopSession`. */
export type StopSessionOptions = {
  sessionId: string;
  userId: string;
};

/** Options accepted by `PlaywrightClient.navigate`. */
export type NavigateOptions = { url: string } & SessionOpsBase;

/** Options accepted by `PlaywrightClient.interact`. */
export type InteractOptions = { actions: readonly BrowserAction[] } & SessionOpsBase;

/** Options accepted by `PlaywrightClient.screenshot`. */
export type ScreenshotOptions = { selector?: string; fullPage?: boolean } & SessionOpsBase;

/** Format flavours supported by `PlaywrightClient.content`. */
export type PlaywrightContentFormat = "html" | "text";

/** Options accepted by `PlaywrightClient.content`. */
export type ContentOptions = { format: PlaywrightContentFormat } & SessionOpsBase;

/** Result returned by `PlaywrightClient.startSession`. */
export type PlaywrightSessionResult = {
  sessionId: string;
  url: string;
  title?: string;
};

/** Result returned by `PlaywrightClient.navigate`. */
export type PlaywrightNavigateResult = {
  url: string;
  title?: string;
};

/** Result returned by `PlaywrightClient.interact`. */
export type PlaywrightInteractResult = {
  results: BrowserActionResult[];
};

/** Result returned by `PlaywrightClient.screenshot`. */
export type PlaywrightScreenshotResult = {
  /** Base64-encoded PNG bytes — caller decodes for display/persistence. */
  data: string;
  mimeType: "image/png";
};

/** Result returned by `PlaywrightClient.content`. */
export type PlaywrightContentResult = {
  url: string;
  title?: string;
  content: string;
  format: PlaywrightContentFormat;
};

// --- Plan 0010 — comprehensive extension --------------------------------

/** Options accepted by `PlaywrightClient.eval`. */
export type EvalOptions = { expression: string } & SessionOpsBase;

/** Options accepted by `PlaywrightClient.pdf`. */
export type PdfOptions = {
  format: "A4" | "Legal" | "Letter";
  landscape: boolean;
  scale: number;
} & SessionOpsBase;

/** Options accepted by `PlaywrightClient.cookies` — mirrors the schema discriminator. */
export type CookiesOptions = (
  | { mode: "clear" }
  | { mode: "get"; urls?: string[] }
  | { mode: "set"; cookies: PlaywrightCookie[] }
) &
  SessionOpsBase;

/** Cookie shape passed through to Playwright (matches their `Cookie` type). */
export type PlaywrightCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "None" | "Strict";
  url?: string;
};

/** Options accepted by `PlaywrightClient.storage`. */
export type StorageOptions = (
  | { mode: "clear"; target: "local" | "session" }
  | { mode: "get"; target: "local" | "session"; keys?: string[] }
  | { mode: "set"; target: "local" | "session"; entries: Record<string, string> }
) &
  SessionOpsBase;

/** Options accepted by `PlaywrightClient.har`. */
export type HarOptions = { mode: "start" | "stop" } & SessionOpsBase;

/** Options accepted by `PlaywrightClient.tabs`. */
export type TabsOptions = (
  | { mode: "close"; index: number }
  | { mode: "list" }
  | { mode: "new"; url?: string }
  | { mode: "switch"; index: number }
) &
  SessionOpsBase;

/** Result returned by `PlaywrightClient.eval`. */
export type PlaywrightEvalResult = {
  result: unknown;
};

/** Result returned by `PlaywrightClient.pdf`. */
export type PlaywrightPdfResult = {
  data: string;
  mimeType: "application/pdf";
};

/** Result returned by `PlaywrightClient.cookies`. */
export type PlaywrightCookiesResult = {
  mode: "clear" | "get" | "set";
  cookies?: PlaywrightCookie[];
};

/** Result returned by `PlaywrightClient.storage`. */
export type PlaywrightStorageResult = {
  mode: "clear" | "get" | "set";
  target: "local" | "session";
  entries?: Record<string, string>;
};

/** Result returned by `PlaywrightClient.har`. */
export type PlaywrightHarResult = {
  mode: "start" | "stop";
  har?: unknown;
};

/** Result returned by `PlaywrightClient.tabs`. */
export type PlaywrightTabsResult = {
  mode: "close" | "list" | "new" | "switch";
  activeIndex: number;
  tabs: Array<{ index: number; url: string; title?: string }>;
};
