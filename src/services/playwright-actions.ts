/**
 * Action dispatcher for `browser_interact` (plan 0009 §Browser-Action-Vokabular).
 *
 * The interact tool ships a curated action vocabulary (`click`, `type`,
 * `fill`, `wait`, `wait_for_selector`, `scroll`, `hover`, `press`, `select`)
 * that the caller hands over as a discriminated union of objects. This
 * module is the single place that maps each variant onto Playwright's
 * locator API so the `PlaywrightClient` keeps action-vocabulary churn out
 * of its lifecycle code and the schema layer (`src/schemas/browser.ts`)
 * stays the authoritative validator.
 *
 * Each variant is delegated to a tiny per-variant helper so the central
 * `runAction` switch stays under the project's cyclomatic-complexity cap
 * while still letting TypeScript narrow the action payload per case.
 */
import type { Page } from "playwright";

import type { BrowserAction } from "../schemas/browser.js";

/**
 * Default per-action timeout used when the caller does not supply one. The
 * outer route timeout (`PER_ROUTE_TIMEOUTS_MS.browserInteract`, currently
 * 60 s) bounds the entire action chain; this value caps a single step so a
 * stuck selector cannot consume the entire budget on the very first action.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

/** Per-action result entry returned by {@link dispatchAction}. */
export type BrowserActionResult = {
  type: BrowserAction["type"];
  status: "completed" | "failed";
  error?: string;
};

/** Convenience union of every action that carries an optional `timeout`. */
type ActionWithTimeout = Extract<BrowserAction, { timeout?: number }>;

/** Resolves the effective per-action timeout. */
function actionTimeout(action: ActionWithTimeout): number {
  return action.timeout ?? DEFAULT_ACTION_TIMEOUT_MS;
}

/**
 * Executes a single {@link BrowserAction} against `page`. Returns a
 * structured result rather than throwing on per-action failures (selector
 * not found, click intercepted, …) so the caller can see exactly which
 * step of the chain failed without losing the prior steps' progress.
 *
 * Genuine infrastructure errors (page crashed, context closed) still
 * bubble up as exceptions so the outer service layer can map them to the
 * `§16.1` error envelope.
 */
export async function dispatchAction(
  page: Page,
  action: BrowserAction,
  _signal: AbortSignal,
): Promise<BrowserActionResult> {
  try {
    await runAction(page, action);
    return { type: action.type, status: "completed" };
  } catch (error) {
    return {
      type: action.type,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAction(page: Page, action: BrowserAction): Promise<void> {
  switch (action.type) {
    case "click":
      return clickAction(page, action);
    case "type":
      return typeAction(page, action);
    case "fill":
      return fillAction(page, action);
    case "wait":
      return waitAction(page, action);
    case "wait_for_selector":
      return waitForSelectorAction(page, action);
    case "scroll":
      return scrollAction(page, action);
    case "hover":
      return hoverAction(page, action);
    case "press":
      return pressAction(page, action);
    case "select":
      return selectAction(page, action);
  }
}

async function clickAction(
  page: Page,
  action: Extract<BrowserAction, { type: "click" }>,
): Promise<void> {
  await page.click(action.selector, { timeout: actionTimeout(action) });
}

async function typeAction(
  page: Page,
  action: Extract<BrowserAction, { type: "type" }>,
): Promise<void> {
  // `page.type` is deprecated in Playwright; the locator-based
  // `pressSequentially` is the supported replacement and accepts the
  // same per-key delay.
  await page
    .locator(action.selector)
    .pressSequentially(action.text, { delay: action.delay, timeout: actionTimeout(action) });
}

async function fillAction(
  page: Page,
  action: Extract<BrowserAction, { type: "fill" }>,
): Promise<void> {
  await page.fill(action.selector, action.text, { timeout: actionTimeout(action) });
}

async function waitAction(
  page: Page,
  action: Extract<BrowserAction, { type: "wait" }>,
): Promise<void> {
  await page.waitForTimeout(action.durationMs);
}

async function waitForSelectorAction(
  page: Page,
  action: Extract<BrowserAction, { type: "wait_for_selector" }>,
): Promise<void> {
  await page.waitForSelector(action.selector, {
    state: action.state,
    timeout: actionTimeout(action),
  });
}

async function scrollAction(
  page: Page,
  action: Extract<BrowserAction, { type: "scroll" }>,
): Promise<void> {
  await page.locator(action.selector).scrollIntoViewIfNeeded({ timeout: actionTimeout(action) });
}

async function hoverAction(
  page: Page,
  action: Extract<BrowserAction, { type: "hover" }>,
): Promise<void> {
  await page.hover(action.selector, { timeout: actionTimeout(action) });
}

async function pressAction(
  page: Page,
  action: Extract<BrowserAction, { type: "press" }>,
): Promise<void> {
  // `page.press` is deprecated; locator-scoped press is the supported
  // replacement and accepts the same key syntax (`Enter`, `Tab`, etc.).
  await page.locator(action.selector).press(action.key, { timeout: actionTimeout(action) });
}

async function selectAction(
  page: Page,
  action: Extract<BrowserAction, { type: "select" }>,
): Promise<void> {
  // `selectOption` returns the chosen values; the dispatcher only cares
  // about completion, so the return value is intentionally discarded.
  await page.selectOption(action.selector, action.values, { timeout: actionTimeout(action) });
}
