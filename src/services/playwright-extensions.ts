/**
 * Plan 0010 — comprehensive extension methods for
 * `PlaywrightClient`. Each function is implemented as a free helper
 * that takes the already-resolved {@link SessionEntry} so the client class
 * stays within the per-file budget and the tab/HAR/eval/storage logic can
 * be unit-tested against the mocked Playwright surface without spinning
 * up the whole pool.
 *
 * The functions assume the caller has already authenticated the session
 * (via `PlaywrightClient.requireOwnedSession`) and will update
 * `entry.lastActionAt` afterwards if needed — these helpers focus purely
 * on the per-operation semantics.
 */
import type { BrowserContext, Page } from "playwright";

import type {
  CookiesOptions,
  EvalOptions,
  HarOptions,
  PdfOptions,
  PlaywrightCookie,
  PlaywrightCookiesResult,
  PlaywrightEvalResult,
  PlaywrightHarResult,
  PlaywrightPdfResult,
  PlaywrightStorageResult,
  PlaywrightTabsResult,
  SessionEntry,
  StorageOptions,
  TabsOptions,
} from "./playwright-types.js";

import { AppError, ErrorCode } from "../errors.js";
import { PLAYWRIGHT_HARD_LIFETIME_MS } from "./playwright-config.js";
import { HarBuffer } from "./playwright-har.js";
import { ensureWithinOutputLimit, safeTitle } from "./playwright-helpers.js";
import { MAX_TABS_PER_SESSION } from "./playwright-types.js";

/** Initial page-load timeout shared with `startSession` / `navigate`. */
const PAGE_LOAD_TIMEOUT_MS = 30_000;

/** Hard cap on `browser_eval` output size — 1 MB JSON. */
const EVAL_OUTPUT_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * Runs a JavaScript expression in the page's V8 context. The expression
 * is passed verbatim to Playwright; the returned value is collapsed
 * through `JSON.stringify` (with a non-serialisable replacer) before
 * being handed back to the caller so DOM handles cannot leak out and the
 * output cap is enforced uniformly.
 */
export async function runEval(page: Page, opts: EvalOptions): Promise<PlaywrightEvalResult> {
  const raw: unknown = await page.evaluate(opts.expression);
  // `JSON.stringify(undefined)` returns the literal `undefined` value at
  // runtime (TS still types it as `string`), so handle that case before the
  // replacer would ever see it.
  if (raw === undefined || typeof raw === "function") {
    return { result: null };
  }
  const serialised = JSON.stringify(raw, jsonReplacer);
  ensureWithinEvalOutputLimit(Buffer.byteLength(serialised, "utf8"));
  return { result: JSON.parse(serialised) as unknown };
}

/** Captures a PDF rendering of the active page. */
export async function runPdf(page: Page, opts: PdfOptions): Promise<PlaywrightPdfResult> {
  const buffer = await page.pdf({
    format: opts.format,
    landscape: opts.landscape,
    scale: opts.scale,
    printBackground: true,
  });
  ensureWithinOutputLimit(buffer.byteLength);
  return { data: buffer.toString("base64"), mimeType: "application/pdf" };
}

/** Implements the `get/set/clear` semantics of `browser_cookies`. */
export async function runCookies(
  context: BrowserContext,
  opts: CookiesOptions,
): Promise<PlaywrightCookiesResult> {
  if (opts.mode === "get") {
    const cookies = (await context.cookies(opts.urls)) as PlaywrightCookie[];
    return { mode: "get", cookies };
  }
  if (opts.mode === "set") {
    await context.addCookies(opts.cookies);
    return { mode: "set" };
  }
  await context.clearCookies();
  return { mode: "clear" };
}

/**
 * Implements `get/set/clear` for `localStorage` / `sessionStorage`. The
 * inner closures run inside the page's V8 context — Playwright serialises
 * them across the CDP wire — so they touch the browser's Web Storage API
 * directly. Per-mode helpers keep this dispatcher under the per-function
 * line cap.
 */
export async function runStorage(
  page: Page,
  opts: StorageOptions,
): Promise<PlaywrightStorageResult> {
  if (opts.mode === "get") {
    const entries = await storageGet(page, opts.target, opts.keys ?? null);
    return { mode: "get", target: opts.target, entries };
  }
  if (opts.mode === "set") {
    await storageSet(page, opts.target, opts.entries);
    return { mode: "set", target: opts.target };
  }
  await storageClear(page, opts.target);
  return { mode: "clear", target: opts.target };
}

async function storageGet(
  page: Page,
  target: "local" | "session",
  keys: null | string[],
): Promise<Record<string, string>> {
  return page.evaluate(
    (args: { target: "local" | "session"; keys: null | string[] }) => {
      // Node's lib has no DOM types — the cast lives only inside the
      // page-side closure where the globals genuinely exist.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const w = globalThis as unknown as {
        localStorage: WebStorage;
        sessionStorage: WebStorage;
      };
      const store = args.target === "local" ? w.localStorage : w.sessionStorage;
      const out: Record<string, string> = {};
      if (args.keys === null) {
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          if (key !== null) out[key] = store.getItem(key) ?? "";
        }
      } else {
        for (const key of args.keys) out[key] = store.getItem(key) ?? "";
      }
      return out;
    },
    { target, keys },
  );
}

async function storageSet(
  page: Page,
  target: "local" | "session",
  entries: Record<string, string>,
): Promise<void> {
  await page.evaluate(
    (args: { target: "local" | "session"; entries: Record<string, string> }) => {
      // Node's lib has no DOM types — the cast lives only inside the
      // page-side closure where the globals genuinely exist.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const w = globalThis as unknown as {
        localStorage: WebStorage;
        sessionStorage: WebStorage;
      };
      const store = args.target === "local" ? w.localStorage : w.sessionStorage;
      for (const [key, value] of Object.entries(args.entries)) store.setItem(key, value);
    },
    { target, entries },
  );
}

async function storageClear(page: Page, target: "local" | "session"): Promise<void> {
  await page.evaluate((t: "local" | "session") => {
    // Node's lib has no DOM types — the cast lives only inside the
    // page-side closure where the globals genuinely exist.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const w = globalThis as unknown as {
      localStorage: WebStorage;
      sessionStorage: WebStorage;
    };
    const store = t === "local" ? w.localStorage : w.sessionStorage;
    store.clear();
  }, target);
}

/**
 * Minimal subset of the Web Storage API actually touched by the inline
 * `page.evaluate` closures above. Declared at the module level so each
 * closure can reference the same shape without re-typing it.
 */
type WebStorage = {
  readonly length: number;
  key: (index: number) => null | string;
  getItem: (key: string) => null | string;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

/** Starts/stops the HAR recorder on a session. */
export function runHar(entry: SessionEntry, opts: HarOptions): PlaywrightHarResult {
  if (opts.mode === "start") {
    if (entry.harBuffer !== undefined) {
      throw new AppError({
        code: ErrorCode.BAD_REQUEST,
        message: "HAR recording already active",
        details: { reason: "har_already_recording" },
      });
    }
    const buffer = new HarBuffer();
    buffer.start(entry.pages);
    entry.harBuffer = buffer;
    return { mode: "start" };
  }
  if (entry.harBuffer === undefined) {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      message: "No HAR recording in progress",
      details: { reason: "no_har_recording" },
    });
  }
  const envelope = entry.harBuffer.serialize();
  const serialised = JSON.stringify(envelope);
  ensureWithinOutputLimit(Buffer.byteLength(serialised, "utf8"));
  entry.harBuffer = undefined;
  return { mode: "stop", har: envelope };
}

/** Implements `list/switch/close/new` for `browser_tabs`. */
export async function runTabs(
  entry: SessionEntry,
  opts: TabsOptions,
): Promise<PlaywrightTabsResult> {
  if (opts.mode === "list") {
    return { mode: "list", activeIndex: entry.activePageIndex, tabs: await snapshotTabs(entry) };
  }
  if (opts.mode === "switch") {
    ensureTabIndex(entry, opts.index);
    entry.activePageIndex = opts.index;
    return { mode: "switch", activeIndex: entry.activePageIndex, tabs: await snapshotTabs(entry) };
  }
  if (opts.mode === "close") {
    await closeTab(entry, opts.index);
    return { mode: "close", activeIndex: entry.activePageIndex, tabs: await snapshotTabs(entry) };
  }
  await openTab(entry, opts.url);
  return { mode: "new", activeIndex: entry.activePageIndex, tabs: await snapshotTabs(entry) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ensureWithinEvalOutputLimit(size: number): void {
  if (size > EVAL_OUTPUT_LIMIT_BYTES) {
    throw new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "playwright", reason: "output_too_large" },
    });
  }
}

/**
 * Replacer that drops anything `JSON.stringify` cannot turn into a string
 * by default — functions, undefined values, DOM handles surfaced as
 * structured-clone errors, etc. The replacement keeps the slot present
 * so the caller can tell which fields were stripped.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function" || value === undefined) {
    return "[non-serializable]";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

async function snapshotTabs(
  entry: SessionEntry,
): Promise<Array<{ index: number; url: string; title?: string }>> {
  return Promise.all(
    entry.pages.map(async (page, index) => ({
      index,
      url: page.url(),
      title: await safeTitle(page),
    })),
  );
}

function ensureTabIndex(entry: SessionEntry, index: number): void {
  if (index < 0 || index >= entry.pages.length) {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      message: "Tab index out of range",
      details: { reason: "tab_index_out_of_range" },
    });
  }
}

async function closeTab(entry: SessionEntry, index: number): Promise<void> {
  ensureTabIndex(entry, index);
  if (entry.pages.length === 1) {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      message: "Cannot close the last tab — use browser_session_stop instead",
      details: { reason: "cannot_close_last_tab" },
    });
  }
  const target = entry.pages[index];
  if (target === undefined) return;
  entry.pages.splice(index, 1);
  if (entry.activePageIndex === index) {
    entry.activePageIndex = Math.max(0, index - 1);
  } else if (entry.activePageIndex > index) {
    entry.activePageIndex -= 1;
  }
  await target.close();
}

async function openTab(entry: SessionEntry, url: string | undefined): Promise<void> {
  if (entry.pages.length >= MAX_TABS_PER_SESSION) {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      message: "Tab limit reached",
      details: { reason: "tab_limit_reached", limit: MAX_TABS_PER_SESSION },
    });
  }
  const page = await entry.context.newPage();
  if (url !== undefined) {
    await page.goto(url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
  }
  entry.pages.push(page);
  entry.activePageIndex = entry.pages.length - 1;
  // Reset the hard deadline window slightly so a brand-new tab does not
  // come into the world already half-expired. The idle TTL is unaffected.
  if (entry.hardDeadline - Date.now() < PAGE_LOAD_TIMEOUT_MS) {
    entry.hardDeadline = Date.now() + PLAYWRIGHT_HARD_LIFETIME_MS;
  }
}
