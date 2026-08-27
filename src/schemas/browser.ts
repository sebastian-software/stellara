/**
 * Zod schemas for the six Playwright-backed `browser_*` tools shipped by
 * plan 0009 (concept §8.19-§8.24). Centralised here so REST routes, the MCP
 * registry and the tool-layer all consume one source of truth.
 *
 * Action vocabulary is encoded as a `discriminatedUnion` rather than a free
 * `Record<string, unknown>` because Stellara owns the contract — Playwright
 * is an internal implementation detail and we want callers to fail at the
 * schema boundary with a 422 ("unknown action type") instead of blowing up
 * inside the action dispatcher with a 5xx.
 */
import { z } from "zod/v4";

import { safeExternalUrl } from "./common.js";

/**
 * Selectors are passed through to Playwright's locator engine. The schema
 * only ensures non-empty strings; Playwright is the authority on valid
 * selector syntax (CSS, XPath, role-based) and surfaces its own errors per
 * action via the `BrowserActionResult` returned by the dispatcher.
 */
const selectorSchema = z.string().min(1).max(2048);

/**
 * Per-action timeout, capped at 30 s so a runaway selector can never
 * exhaust the 60 s `browser_interact` route budget on the very first step.
 */
const actionTimeoutSchema = z.number().int().min(100).max(30_000).optional();

/**
 * Discriminated union of every supported `browser_interact` action.
 *
 * Adding a variant requires three coordinated changes:
 *
 * 1. Add the variant here.
 * 2. Add the matching dispatch arm in
 *    {@link `../services/playwright-actions.ts`:dispatchAction}.
 * 3. Add a happy-path test in `tests/unit/services/playwright.test.ts`.
 *
 * The dispatcher's `default` arm throws if (1) is done without (2) so the
 * drift surfaces at the first test run rather than as a silent no-op in
 * production.
 */
export const browserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    selector: selectorSchema,
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("type"),
    selector: selectorSchema,
    text: z.string().max(4096),
    /** Per-keystroke delay in ms — useful for forms that debounce input. */
    delay: z.number().int().min(0).max(500).optional(),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("fill"),
    selector: selectorSchema,
    text: z.string().max(4096),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("wait"),
    /** Absolute idle delay before continuing the chain. */
    durationMs: z.number().int().min(0).max(30_000),
  }),
  z.object({
    type: z.literal("wait_for_selector"),
    selector: selectorSchema,
    /**
     * Visibility state to wait for. Matches Playwright's `WaitForSelectorOptions`.
     * `attached` is the lightest check (DOM presence); `visible` waits for
     * non-zero box; `hidden` waits for removal/`display:none`; `detached`
     * waits for the node to leave the DOM entirely.
     */
    state: z.enum(["attached", "visible", "hidden", "detached"]).default("visible"),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("scroll"),
    /**
     * Anchor selector — scrolls the matched element into view. Slice 2
     * supports only selector-anchored scrolling; absolute window scrolls
     * (`x`/`y`) are deferred to slice 3 once the additional output tools
     * make them genuinely useful.
     */
    selector: selectorSchema,
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("hover"),
    selector: selectorSchema,
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("press"),
    selector: selectorSchema,
    /** Keyboard key as defined by Playwright (e.g. `Enter`, `Tab`, `ArrowDown`). */
    key: z.string().min(1).max(64),
    timeout: actionTimeoutSchema,
  }),
  z.object({
    type: z.literal("select"),
    selector: selectorSchema,
    /** One or many option values — Playwright's `selectOption` accepts both. */
    values: z.union([z.string().max(1024), z.array(z.string().max(1024)).min(1).max(50)]),
    timeout: actionTimeoutSchema,
  }),
]);

/** TypeScript projection of the action union used by service consumers. */
export type BrowserAction = z.infer<typeof browserActionSchema>;

/** Request body for `POST /tools/browser/session/start` (§8.19). */
export const browserSessionStartRequestSchema = z.object({
  url: safeExternalUrl,
  stealth: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), the new context spoofs a realistic Linux Chrome stable identity (de-DE, Europe/Berlin, 1366×768 viewport). Set to false for debug sessions that should keep the headless default fingerprint. Operator can disable globally via STELLARA_PLAYWRIGHT_STEALTH=false; in that case this field is ignored.",
    ),
});

/**
 * Reusable per-action `sessionId` description — every browser tool
 * downstream of `browser_session_start` references the ULID it returned,
 * so the explanation is shared via a single `.describe()` call below.
 */
const sessionIdDescription =
  "ULID returned by `browser_session_start`. Sessions auto-expire after 5 min of idle or 30 min total.";

/** Response body for `POST /tools/browser/session/start` (§8.19). */
export const browserSessionStartResponseSchema = z.object({
  sessionId: z.string().min(1),
  url: z.url(),
  title: z.string().optional(),
});

/** Request body for `POST /tools/browser/session/stop` (§8.20). */
export const browserSessionStopRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
});

/** Response body for `POST /tools/browser/session/stop` (§8.20). */
export const browserSessionStopResponseSchema = z.object({
  stopped: z.literal(true),
});

/** Request body for `POST /tools/browser/navigate` (§8.21). */
export const browserNavigateRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  url: safeExternalUrl,
});

/** Response body for `POST /tools/browser/navigate` (§8.21). */
export const browserNavigateResponseSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
});

/** Request body for `POST /tools/browser/interact` (§8.22). */
export const browserInteractRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  actions: z
    .array(browserActionSchema)
    .min(1)
    .max(50)
    .describe(
      "Ordered list of browser actions. Stops at the first failed step; per-action results come back structured. Supported types: click, type, fill, wait, wait_for_selector, scroll, hover, press, select.",
    ),
});

/** Response body for `POST /tools/browser/interact` (§8.22). */
export const browserInteractResponseSchema = z.object({
  results: z.array(
    z.object({
      type: z.string(),
      status: z.enum(["completed", "failed"]),
      error: z.string().optional(),
    }),
  ),
});

/** Request body for `POST /tools/browser/screenshot` (§8.23). */
export const browserScreenshotRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  /**
   * Optional selector — when present, captures just the matched element.
   * Without it the whole page (viewport or full-page, see `fullPage`) is
   * captured.
   */
  selector: selectorSchema.optional(),
  fullPage: z.boolean().default(false),
});

/** Response body for `POST /tools/browser/screenshot` (§8.23). */
export const browserScreenshotResponseSchema = z.object({
  data: z.string().min(1),
  mimeType: z.literal("image/png"),
});

/** Request body for `POST /tools/browser/content` (§8.24). */
export const browserContentRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  format: z.enum(["html", "text"]).default("html"),
});

/** Response body for `POST /tools/browser/content` (§8.24). */
export const browserContentResponseSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  content: z.string(),
  format: z.enum(["html", "text"]),
});

// ---------------------------------------------------------------------------
// Plan 0010 — Comprehensive browser-tool extension (§8.25-§8.30).
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /tools/browser/eval` (§8.25). The caller supplies
 * a JavaScript expression that runs inside the page's V8 context. Slice 3
 * does not pass extra arguments — callers wrap any constants inline; a
 * future iteration may extend the schema with an optional `args` array.
 */
export const browserEvalRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  expression: z
    .string()
    .min(1)
    .max(16_384)
    .describe(
      "JavaScript expression evaluated in the page's V8 context. Result is JSON-serialised; non-serialisable returns (functions, DOM handles) become `null`. Output capped at 1 MB.",
    ),
});

/** Response body for `POST /tools/browser/eval` (§8.25). */
export const browserEvalResponseSchema = z.object({
  /**
   * JSON-serialisable evaluation result. Non-serialisable returns
   * (functions, DOM handles) collapse to `null` via the service's JSON
   * replacer.
   */
  result: z.unknown(),
});

/** Request body for `POST /tools/browser/pdf` (§8.26). */
export const browserPdfRequestSchema = z.object({
  sessionId: z.string().min(1).describe(sessionIdDescription),
  format: z.enum(["A4", "Letter", "Legal"]).default("A4"),
  landscape: z.boolean().default(false),
  /**
   * Page scale factor (Chromium accepts 0.1-2). Default matches Playwright.
   */
  scale: z.number().min(0.1).max(2).default(1),
});

/** Response body for `POST /tools/browser/pdf` (§8.26). */
export const browserPdfResponseSchema = z.object({
  /** Base64-encoded PDF bytes. */
  data: z.string().min(1),
  mimeType: z.literal("application/pdf"),
});

/**
 * Cookie payload accepted by `browser_cookies` set. Matches Playwright's
 * `Cookie` shape so the service can pass through values verbatim.
 */
const browserCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  url: z.string().optional(),
});

/** Request body for `POST /tools/browser/cookies` (§8.27). */
export const browserCookiesRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z
      .literal("get")
      .describe("`get` returns the cookies Chromium would send for the optional `urls`."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    /**
     * Optional URL filter — when set, returns only the cookies that
     * Chromium would attach to a request to that URL.
     */
    urls: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    mode: z.literal("set").describe("`set` adds the supplied Playwright-shaped cookies."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    cookies: z
      .array(browserCookieSchema)
      .min(1)
      .max(64)
      .describe("Playwright `Cookie` objects; passed through verbatim to `context.addCookies`."),
  }),
  z.object({
    mode: z.literal("clear").describe("`clear` removes every cookie from the session context."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
  }),
]);

/** Response body for `POST /tools/browser/cookies` (§8.27). */
export const browserCookiesResponseSchema = z.object({
  mode: z.enum(["get", "set", "clear"]),
  cookies: z.array(browserCookieSchema).optional(),
});

/** Request body for `POST /tools/browser/storage` (§8.28). */
export const browserStorageRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("get").describe("`get` returns the requested keys (or all keys)."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    target: z
      .enum(["local", "session"])
      .default("local")
      .describe("`local` → localStorage, `session` → sessionStorage."),
    /** When omitted, returns every key in the target storage. */
    keys: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    mode: z.literal("set").describe("`set` writes the supplied key/value entries."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    target: z
      .enum(["local", "session"])
      .default("local")
      .describe("`local` → localStorage, `session` → sessionStorage."),
    entries: z.record(z.string().min(1), z.string()),
  }),
  z.object({
    mode: z.literal("clear").describe("`clear` removes every key from the target storage."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    target: z
      .enum(["local", "session"])
      .default("local")
      .describe("`local` → localStorage, `session` → sessionStorage."),
  }),
]);

/** Response body for `POST /tools/browser/storage` (§8.28). */
export const browserStorageResponseSchema = z.object({
  mode: z.enum(["get", "set", "clear"]),
  target: z.enum(["local", "session"]),
  entries: z.record(z.string(), z.string()).optional(),
});

/** Request body for `POST /tools/browser/har` (§8.29). */
export const browserHarRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("start").describe("`start` begins recording on every tab currently open."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
  }),
  z.object({
    mode: z
      .literal("stop")
      .describe(
        "`stop` returns the HAR 1.2 envelope and detaches listeners. **Privacy:** captured headers include `Authorization` and `Cookie` verbatim.",
      ),
    sessionId: z.string().min(1).describe(sessionIdDescription),
  }),
]);

/**
 * Response body for `POST /tools/browser/har` (§8.29). The `har` envelope
 * is only populated on `stop`; it follows the HAR 1.2 specification but
 * Stellara emits a deliberately minimal subset (status, headers, body
 * preview) rather than fabricating timing data.
 */
export const browserHarResponseSchema = z.object({
  mode: z.enum(["start", "stop"]),
  har: z.unknown().optional(),
});

/** Request body for `POST /tools/browser/tabs` (§8.30). */
export const browserTabsRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("list").describe("`list` returns every tab with its URL, title and index."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
  }),
  z.object({
    mode: z
      .literal("switch")
      .describe("`switch` sets `activePageIndex` to `index`; out-of-range yields 400."),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    index: z.number().int().min(0).max(63),
  }),
  z.object({
    mode: z
      .literal("close")
      .describe(
        "`close` removes the tab at `index`. Closing the last tab is rejected — use `browser_session_stop` instead.",
      ),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    index: z.number().int().min(0).max(63),
  }),
  z.object({
    mode: z
      .literal("new")
      .describe(
        "`new` opens a fresh tab (optionally navigating to `url`). Capped at five tabs per session.",
      ),
    sessionId: z.string().min(1).describe(sessionIdDescription),
    url: safeExternalUrl.optional(),
  }),
]);

/** Response body for `POST /tools/browser/tabs` (§8.30). */
export const browserTabsResponseSchema = z.object({
  mode: z.enum(["list", "switch", "close", "new"]),
  activeIndex: z.number().int().min(0),
  tabs: z.array(
    z.object({
      index: z.number().int().min(0),
      url: z.string(),
      title: z.string().optional(),
    }),
  ),
});

/** Inferred TypeScript types for the new request bodies. */
export type BrowserSessionStartRequest = z.infer<typeof browserSessionStartRequestSchema>;
export type BrowserSessionStopRequest = z.infer<typeof browserSessionStopRequestSchema>;
export type BrowserNavigateRequest = z.infer<typeof browserNavigateRequestSchema>;
export type BrowserInteractRequest = z.infer<typeof browserInteractRequestSchema>;
export type BrowserScreenshotRequest = z.infer<typeof browserScreenshotRequestSchema>;
export type BrowserContentRequest = z.infer<typeof browserContentRequestSchema>;
export type BrowserEvalRequest = z.infer<typeof browserEvalRequestSchema>;
export type BrowserPdfRequest = z.infer<typeof browserPdfRequestSchema>;
export type BrowserCookiesRequest = z.infer<typeof browserCookiesRequestSchema>;
export type BrowserStorageRequest = z.infer<typeof browserStorageRequestSchema>;
export type BrowserHarRequest = z.infer<typeof browserHarRequestSchema>;
export type BrowserTabsRequest = z.infer<typeof browserTabsRequestSchema>;
