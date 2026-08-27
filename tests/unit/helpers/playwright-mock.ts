/**
 * Playwright mock bag shared by `services/playwright.test.ts` and the
 * route-level smoke tests for the `browser_*` tools.
 *
 * Each test that needs to drive the `PlaywrightClient` without
 * spawning a real Chromium installs this mock via `vi.mock("playwright")`
 * before importing the service. The factory pattern keeps the per-test
 * page/context/browser instances independent — there is one shared
 * `chromiumLaunchMock` spy that returns a fresh mock browser each call,
 * which is exactly the calling pattern the service uses (a single
 * `chromium.launch()` at lazy init, multiple `browser.newContext()` /
 * `context.newPage()` per session).
 */
import { vi } from "vitest";

/** Minimal `Page` surface used by the service + action dispatcher. */
export type MockPage = {
  goto: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  type: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  hover: ReturnType<typeof vi.fn>;
  press: ReturnType<typeof vi.fn>;
  selectOption: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  pdf: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  innerText: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

/** Minimal `BrowserContext` surface. */
export type MockContext = {
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

/** Minimal `Browser` surface. */
export type MockBrowser = {
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  /**
   * `browser.version()` — used by `deriveChromeMajor` in `playwright-pool.ts`
   * (plan 0012) to extract the Chromium major for the spoofed UA. Default
   * returns a realistic version string so `buildContextOptions` can compute a
   * concrete Chrome-major without hitting the sentinel fallback.
   */
  version: ReturnType<typeof vi.fn>;
};

/** Builds a fresh mock `Page` with sensible default return values. */
export function makeMockPage(overrides: Partial<MockPage> = {}): MockPage {
  const locator = {
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
  };
  const base: MockPage = {
    goto: vi.fn().mockResolvedValue(null),
    title: vi.fn().mockResolvedValue("Example"),
    url: vi.fn().mockReturnValue("https://example.test/"),
    click: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(["chosen"]),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("png-bytes")),
    pdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4\n")),
    content: vi.fn().mockResolvedValue("<html><body>hi</body></html>"),
    innerText: vi.fn().mockResolvedValue("hi"),
    evaluate: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locator),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

/** Builds a fresh mock `BrowserContext` whose `newPage` returns `page`. */
export function makeMockContext(page: MockPage): MockContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a fresh mock `Browser` whose `newContext` returns `context`. */
export function makeMockBrowser(context: MockContext): MockBrowser {
  return {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    version: vi.fn().mockReturnValue("HeadlessChrome/148.0.7778.96"),
  };
}

/**
 * Convenience: one mock page + context + browser triple wired together.
 * Each call returns independent fakes so tests do not accidentally share
 * state across sessions.
 */
export function makeMockTrio(): {
  page: MockPage;
  context: MockContext;
  browser: MockBrowser;
} {
  const page = makeMockPage();
  const context = makeMockContext(page);
  const browser = makeMockBrowser(context);
  return { page, context, browser };
}
