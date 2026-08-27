/**
 * Playwright session-pool service backing the `browser_*` MCP tools
 * (plan 0009, concept §8.19+). Owns a single lazy Chromium browser and a
 * `Map<sessionId, SessionEntry>` of caller-bound `BrowserContext`s; each
 * session is anchored to a userId (§6.3). Pool capacity and idle/hard
 * TTL eviction live in `./playwright-pool`; per-tool semantics in
 * `./playwright-extensions`; this file is the thin Class-Wrapper.
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from "playwright";

import type { Config } from "../config.js";
import type {
  ContentOptions,
  CookiesOptions,
  EvalOptions,
  HarOptions,
  InteractOptions,
  NavigateOptions,
  PdfOptions,
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
  ScreenshotOptions,
  SessionEntry,
  StartSessionOptions,
  StopSessionOptions,
  StorageOptions,
  TabsOptions,
} from "./playwright-types.js";

import { AppError, ErrorCode } from "../errors.js";
import { type BrowserActionResult, dispatchAction } from "./playwright-actions.js";
import { PLAYWRIGHT_SWEEP_INTERVAL_MS } from "./playwright-config.js";
import {
  runCookies,
  runEval,
  runHar,
  runPdf,
  runStorage,
  runTabs,
} from "./playwright-extensions.js";
import {
  ensureWithinOutputLimit,
  mapPlaywrightError,
  safeTitle,
  swallow,
} from "./playwright-helpers.js";
import { buildStealthContextOptions, STEALTH_UA_FALLBACK_MAJOR } from "./playwright-identity.js";
import {
  activePage,
  deriveChromeMajor,
  enforceCapacity,
  ensureBrowser,
  evictExpiredSessions,
  getOwnedSession,
  registerSession,
} from "./playwright-pool.js";

// Re-exports keep the existing consumers in `src/tools/browser.ts` and
// `src/fastify.d.ts` unchanged after the slice-3 file split.

export * from "./playwright-types.js";

/** Initial page-load timeout shared by `startSession` and `navigate`. */
const PAGE_LOAD_TIMEOUT_MS = 30_000;

/** REST-friendly Playwright client backing Stellara's `browser_*` tools. */
export class PlaywrightClient {
  private readonly maxSessions: number;
  private readonly maxSessionsPerUser: number;
  private readonly stealthEnabled: boolean;
  private readonly launchOptions: LaunchOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private browser: Browser | undefined;
  /**
   * Cached Chromium major version derived from `browser.version()` after
   * the first successful launch (plan 0012). Reset to `undefined` whenever
   * the underlying browser is replaced so a restart after disconnect
   * re-reads the version against the freshly launched binary.
   */
  private chromeMajor: number | undefined;
  private sweeper: NodeJS.Timeout | undefined;
  private closed = false;

  /**
   * Builds a client wired to the resolved {@link Config.playwright} limits.
   * Chromium itself is **not** launched here — the first `startSession`
   * call lazily spawns the browser so deployments with the feature flag on
   * but no actual interactive traffic pay no cold-start cost.
   */
  public constructor(config: Config) {
    this.maxSessions = config.playwright.maxSessions;
    this.maxSessionsPerUser = config.playwright.maxSessionsPerUser;
    this.stealthEnabled = config.playwright.stealth;
    // `--disable-dev-shm-usage` keeps Chromium from blowing past its 64 MB
    // /dev/shm allocation in Docker, which is the dominant cause of "tab
    // crashed" failures inside container deployments.
    //
    // `--disable-blink-features=AutomationControlled` (plan 0012) prevents
    // Blink from advertising the `AutomationControlled` feature, which
    // Cloudflare-light fingerprinting reads as a `navigator.webdriver`
    // signal independent of the stealth plugin's runtime patch.
    this.launchOptions = {
      headless: true,
      args: ["--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
    };
    this.startSweeper();
  }

  /**
   * Opens a new `BrowserContext`, navigates to `opts.url`, registers the
   * session in the pool and returns the resolved URL and page title.
   *
   * When `opts.stealth` is `true` (the schema default) **and** the operator
   * kill-switch `STELLARA_PLAYWRIGHT_STEALTH` is on, the context is
   * initialized with the Linux Chrome stable identity from
   * {@link buildStealthContextOptions}. When `opts.stealth` is `false`, the
   * context starts with Chromium's default headless fingerprint — but two
   * things stay active regardless of the flag because they are bound to
   * the shared browser process, not to individual contexts:
   *
   * - the stealth-plugin patches (registered at module load in
   *   `playwright-pool.ts`), and
   * - the `--disable-blink-features=AutomationControlled` launch arg.
   *
   * Only the operator kill-switch `STELLARA_PLAYWRIGHT_STEALTH=false`
   * disables both layers in addition to the context identity.
   *
   * On a fresh browser process (or after a browser restart) the Chrome-major
   * cache is invalidated and re-read from `browser.version()` before the
   * first context is created so the spoofed UA stays consistent with the
   * running binary.
   */
  public async startSession(opts: StartSessionOptions): Promise<PlaywrightSessionResult> {
    this.ensureNotClosed();
    enforceCapacity(this.sessions, opts.userId, {
      maxSessions: this.maxSessions,
      maxSessionsPerUser: this.maxSessionsPerUser,
    });
    const browser = await ensureBrowser(this.browser, this.launchOptions);
    if (browser !== this.browser) {
      // Fresh browser process: invalidate the cached Chrome-major value so
      // the next stealth context is built against the actual binary.
      this.chromeMajor = undefined;
    }
    this.browser = browser;
    // `stealth` is optional at the service API boundary so internal
    // callers (tests, future programmatic uses) inherit the same default
    // the Zod schema applies for tool-layer traffic.
    const stealth = opts.stealth ?? true;
    const contextOptions = this.buildContextOptions(browser, stealth);
    return this.openContext(browser, contextOptions, opts);
  }

  /**
   * Opens a `BrowserContext`, navigates to the initial URL and registers the
   * session in the pool. Extracted from `startSession` to keep that method
   * within the ESLint `max-statements` budget (plan 0012).
   */
  private async openContext(
    browser: Browser,
    contextOptions: BrowserContextOptions,
    opts: StartSessionOptions,
  ): Promise<PlaywrightSessionResult> {
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      await page.goto(opts.url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
      const entry = registerSession({
        sessions: this.sessions,
        userId: opts.userId,
        context,
        page,
      });
      return { sessionId: entry.sessionId, url: page.url(), title: await safeTitle(page) };
    } catch (error) {
      if (context !== undefined) {
        await context.close().catch(swallow);
      }
      throw mapPlaywrightError(error, opts.signal);
    }
  }

  /**
   * Assembles the `BrowserContextOptions` slice for `browser.newContext`.
   *
   * Returns the spoofed Linux Chrome stable identity (plan 0012) when the
   * caller asked for stealth AND the operator kill-switch is on; returns
   * an empty options object otherwise so Chromium keeps its default
   * headless fingerprint. The Chrome-major value is cached on the client
   * so subsequent sessions do not re-read `browser.version()`.
   */
  private buildContextOptions(browser: Browser, stealth: boolean): BrowserContextOptions {
    if (!stealth || !this.stealthEnabled) return {};
    if (this.chromeMajor === undefined) {
      const rawVersion = browser.version();
      const major = deriveChromeMajor(browser);
      if (major === STEALTH_UA_FALLBACK_MAJOR) {
        // No Pino logger is wired into the service constructor; console
        // keeps the warning visible in container logs without
        // restructuring the bootstrap. The resolved major is cached until
        // the next browser restart, so this would not fire again for this
        // browser process — we log the raw version so the operator can
        // diagnose the parse failure without re-instrumenting.
        console.warn(
          `stellara: could not parse browser.version() (${rawVersion}) for stealth UA — falling back to sentinel major ${STEALTH_UA_FALLBACK_MAJOR}; cached until next browser restart.`,
        );
      }
      this.chromeMajor = major;
    }
    return buildStealthContextOptions(this.chromeMajor);
  }

  /** Closes a session owned by `opts.userId`. */
  public async stopSession(opts: StopSessionOptions): Promise<void> {
    this.ensureNotClosed();
    const entry = getOwnedSession(this.sessions, opts.sessionId, opts.userId);
    this.sessions.delete(opts.sessionId);
    await entry.context.close().catch(swallow);
  }

  /** Navigates the active page of `opts.sessionId` to a new URL. */
  public async navigate(opts: NavigateOptions): Promise<PlaywrightNavigateResult> {
    return this.runOnPage(opts, async (page) => {
      await page.goto(opts.url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
      return { url: page.url(), title: await safeTitle(page) };
    });
  }

  /** Executes an action chain against the active page of `opts.sessionId`. */
  public async interact(opts: InteractOptions): Promise<PlaywrightInteractResult> {
    return this.runOnPage(opts, async (page) => {
      const results: BrowserActionResult[] = [];
      for (const action of opts.actions) {
        const result = await dispatchAction(page, action, opts.signal);
        results.push(result);
        if (result.status === "failed") break;
      }
      return { results };
    });
  }

  /** Captures a PNG screenshot of the page or a specific selector. */
  public async screenshot(opts: ScreenshotOptions): Promise<PlaywrightScreenshotResult> {
    return this.runOnPage(opts, async (page) => {
      const buffer =
        opts.selector !== undefined
          ? await page.locator(opts.selector).screenshot({ type: "png" })
          : await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
      ensureWithinOutputLimit(buffer.byteLength);
      return { data: buffer.toString("base64"), mimeType: "image/png" };
    });
  }

  /** Evaluates a JS expression inside the page's V8 context. */
  public async eval(opts: EvalOptions): Promise<PlaywrightEvalResult> {
    return this.runOnPage(opts, async (page) => runEval(page, opts));
  }

  /** Renders the active page as a PDF (Base64). */
  public async pdf(opts: PdfOptions): Promise<PlaywrightPdfResult> {
    return this.runOnPage(opts, async (page) => runPdf(page, opts));
  }

  /** `browser_cookies` — context-scoped (affects every tab in the session). */
  public async cookies(opts: CookiesOptions): Promise<PlaywrightCookiesResult> {
    return this.runOnContext(opts, async (entry) => runCookies(entry.context, opts));
  }

  /** `browser_storage` — operates on the active page's Web Storage. */
  public async storage(opts: StorageOptions): Promise<PlaywrightStorageResult> {
    return this.runOnPage(opts, async (page) => runStorage(page, opts));
  }

  /** `browser_har` — toggles the in-memory HAR recorder. */
  public async har(opts: HarOptions): Promise<PlaywrightHarResult> {
    this.ensureNotClosed();
    const entry = getOwnedSession(this.sessions, opts.sessionId, opts.userId);
    try {
      const result = runHar(entry, opts);
      entry.lastActionAt = Date.now();
      return await Promise.resolve(result);
    } catch (error) {
      throw mapPlaywrightError(error, opts.signal);
    }
  }

  /** `browser_tabs` — list/switch/close/new on the session's tab array. */
  public async tabs(opts: TabsOptions): Promise<PlaywrightTabsResult> {
    return this.runOnContext(opts, async (entry) => runTabs(entry, opts));
  }

  /** Returns the active page's DOM as HTML or extracted plain text. */
  public async content(opts: ContentOptions): Promise<PlaywrightContentResult> {
    return this.runOnPage(opts, async (page) => {
      const content = opts.format === "html" ? await page.content() : await page.innerText("body");
      ensureWithinOutputLimit(content.length);
      return { url: page.url(), title: await safeTitle(page), content, format: opts.format };
    });
  }

  /** Cheap `/ready` probe — does not spawn Chromium on its own. */
  public probe(): void {
    this.ensureNotClosed();
    if (this.browser?.isConnected() === false) {
      throw new AppError({
        code: ErrorCode.UPSTREAM_ERROR,
        details: { service: "playwright", reason: "browser_disconnected" },
      });
    }
  }

  /** Graceful shutdown — invoked from Fastify's `onClose` hook. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    const pending = [...this.sessions.values()].map(async (entry) =>
      entry.context.close().catch(swallow),
    );
    this.sessions.clear();
    await Promise.all(pending);
    if (this.browser !== undefined) {
      await this.browser.close().catch(swallow);
      this.browser = undefined;
    }
  }

  /** Test hook: surface the current pool size for assertions. */
  public getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /** Test hook: pump the sweeper logic without waiting for the interval. */
  public runSweepNow(): void {
    if (this.closed) return;
    evictExpiredSessions(this.sessions);
  }

  // ----- internals --------------------------------------------------------

  private async runOnPage<T>(
    opts: { sessionId: string; userId: string; signal: AbortSignal },
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    return this.runOnContext(opts, async (entry) => fn(activePage(entry)));
  }

  private async runOnContext<T>(
    opts: { sessionId: string; userId: string; signal: AbortSignal },
    fn: (entry: SessionEntry) => Promise<T>,
  ): Promise<T> {
    this.ensureNotClosed();
    const entry = getOwnedSession(this.sessions, opts.sessionId, opts.userId);
    try {
      const result = await fn(entry);
      entry.lastActionAt = Date.now();
      return result;
    } catch (error) {
      throw mapPlaywrightError(error, opts.signal);
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new AppError({
        code: ErrorCode.INTERNAL_ERROR,
        message: "PlaywrightClient has been closed",
      });
    }
  }

  private startSweeper(): void {
    this.sweeper = setInterval(() => {
      evictExpiredSessions(this.sessions);
    }, PLAYWRIGHT_SWEEP_INTERVAL_MS);
    // Must not keep the event loop alive on its own.
    this.sweeper.unref();
  }
}
