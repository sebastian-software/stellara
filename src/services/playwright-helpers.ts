/**
 * Pure helper functions extracted from `PlaywrightClient` so the
 * service class stays inside the per-file budget. Each helper is
 * side-effect free apart from Playwright's own browser-side calls and
 * does not touch the session pool — they operate on a `Page`, a value,
 * or an error and return what the calling method needs.
 */
import type { Page } from "playwright";

import { AppError, ErrorCode, mapUpstreamError } from "../errors.js";
import { PLAYWRIGHT_OUTPUT_LIMIT_BYTES } from "./playwright-config.js";

/** Reads the page title with a short-circuit fallback. */
export async function safeTitle(page: Page): Promise<string | undefined> {
  try {
    const title = await page.title();
    return title === "" ? undefined : title;
  } catch {
    return undefined;
  }
}

/**
 * Throws `UPSTREAM_ERROR` with `details.reason: "output_too_large"` when
 * an output buffer/string exceeds the global 10 MB cap (plan 0010 reuses
 * this for PDF, HAR, and `browser_content`).
 */
export function ensureWithinOutputLimit(size: number): void {
  if (size > PLAYWRIGHT_OUTPUT_LIMIT_BYTES) {
    throw new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "playwright", reason: "output_too_large" },
    });
  }
}

/**
 * Maps a Playwright exception onto Stellara's {@link AppError} envelope.
 *
 * `TargetClosedError` (the sweeper closed the context mid-action) becomes a
 * dedicated 502 with `details.reason: "session_terminated"` so the caller
 * can distinguish "restart your session" from generic upstream noise.
 */
export function mapPlaywrightError(error: unknown, signal: AbortSignal): AppError {
  if (AppError.is(error)) return error;
  const message = errorMessage(error);
  if (message.includes("TargetClosedError") || message.includes("Target closed")) {
    return new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "playwright", reason: "session_terminated" },
    });
  }
  return mapUpstreamError(error, { service: "playwright", signal });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * No-op used as a `.catch` handler — keeps eslint's
 * `no-useless-undefined` rule quiet while explicitly swallowing close-time
 * failures that the caller cannot act on anyway.
 */
export function swallow(): void {
  // Intentionally empty.
}
