/**
 * Pool-management helpers for `PlaywrightClient`. Extracted so the
 * client file stays inside the per-file line budget — every helper here
 * is a pure function over the pool state, so they can be unit-tested in
 * isolation without spinning up the whole client.
 *
 * Plan 0012: the `chromium` value import is routed through `playwright-extra`
 * so the stealth plugin can patch every freshly launched browser. The
 * plugin registration runs once at module load, gated by the operator
 * kill-switch `STELLARA_PLAYWRIGHT_STEALTH`. Types stay on the canonical
 * `playwright` package — `playwright-extra` re-augments the same shape
 * but routing the type imports through it would entangle the rest of the
 * codebase with the wrapper for no benefit.
 */
import type { Browser, BrowserContext, LaunchOptions, Page } from "playwright";

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { ulid } from "ulid";

import type { SessionEntry } from "./playwright-types.js";

import { isEnvFlagTrue } from "../config.js";
import { AppError, ErrorCode } from "../errors.js";
import { PLAYWRIGHT_HARD_LIFETIME_MS, PLAYWRIGHT_IDLE_TIMEOUT_MS } from "./playwright-config.js";
import { errorMessage, swallow } from "./playwright-helpers.js";
import { parseChromeMajor } from "./playwright-identity.js";

/**
 * Registers the stealth plugin once per module load. Reads the operator
 * kill-switch directly from `process.env` rather than from the resolved
 * `Config` object: the pool is imported before any Fastify bootstrap runs
 * — including `loadConfig` itself — and the env variable is the only
 * truth-source available at module-init time. Registration failure is
 * non-fatal: we surface a console warning and fall back to vanilla
 * `playwright-extra` behaviour so a broken plugin cannot crash the entire
 * gateway.
 */
function registerStealthPluginOnce(): void {
  if (!isEnvFlagTrue(process.env.STELLARA_PLAYWRIGHT_STEALTH, true)) return;
  try {
    chromium.use(StealthPlugin());
  } catch (error) {
    // Module-init runs before the Fastify logger exists, so console is the
    // only available channel here.
    console.warn(
      "stellara: failed to register puppeteer-extra-plugin-stealth — continuing without plugin patches",
      error instanceof Error ? error.message : error,
    );
  }
}

registerStealthPluginOnce();

/** Active pool size — public for capacity checks and test assertions. */
export function poolSize(sessions: Map<string, SessionEntry>): number {
  return sessions.size;
}

/**
 * Lazily launches the shared Chromium browser. Idempotent on a connected
 * instance so repeated `startSession` calls do not spawn a new process.
 */
export async function ensureBrowser(
  current: Browser | undefined,
  launchOptions: LaunchOptions,
): Promise<Browser> {
  if (current?.isConnected() === true) return current;
  try {
    // `playwright-extra`'s `chromium.launch` returns `playwright-core`'s
    // `Browser`, which is the same nominal type re-exported by `playwright`.
    return await chromium.launch(launchOptions);
  } catch (error) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Failed to launch Chromium",
      details: { reason: "browser_launch_failed", cause: errorMessage(error) },
    });
  }
}

/**
 * Reads `browser.version()` and extracts the Chromium major version used
 * to assemble the spoofed user-agent (plan 0012). Returns
 * `STEALTH_UA_FALLBACK_MAJOR` when the version payload cannot be
 * parsed — the caller compares against the sentinel to decide whether to
 * emit a warn-level log entry.
 *
 * Exposed as a small free function (not a method on `PlaywrightClient`)
 * so the caching layer in the client can own the "read once, reuse for
 * the browser lifetime" policy without the pool helpers having to know
 * about session state.
 */
export function deriveChromeMajor(browser: Browser): number {
  return parseChromeMajor(browser.version());
}

/**
 * Enforces both the global and per-user concurrency caps. Throws
 * `RATE_LIMITED` with a specific `details.reason` so the caller can tell
 * which cap fired.
 */
export function enforceCapacity(
  sessions: Map<string, SessionEntry>,
  userId: string,
  caps: { maxSessions: number; maxSessionsPerUser: number },
): void {
  if (sessions.size >= caps.maxSessions) {
    throw new AppError({
      code: ErrorCode.RATE_LIMITED,
      details: { reason: "global_session_limit" },
    });
  }
  let userCount = 0;
  for (const entry of sessions.values()) {
    if (entry.userId === userId) userCount += 1;
  }
  if (userCount >= caps.maxSessionsPerUser) {
    throw new AppError({
      code: ErrorCode.RATE_LIMITED,
      details: { reason: "user_session_limit" },
    });
  }
}

/** Arguments accepted by {@link registerSession}. */
export type RegisterSessionInput = {
  sessions: Map<string, SessionEntry>;
  userId: string;
  context: BrowserContext;
  page: Page;
};

/**
 * Inserts a fresh {@link SessionEntry} into the pool. Returns the entry
 * so the caller can immediately surface its sessionId.
 */
export function registerSession(input: RegisterSessionInput): SessionEntry {
  const sessionId = ulid();
  const now = Date.now();
  const entry: SessionEntry = {
    sessionId,
    userId: input.userId,
    context: input.context,
    pages: [input.page],
    activePageIndex: 0,
    createdAt: now,
    lastActionAt: now,
    hardDeadline: now + PLAYWRIGHT_HARD_LIFETIME_MS,
  };
  input.sessions.set(sessionId, entry);
  return entry;
}

/**
 * Returns the entry owned by `userId`. Unknown sessions and foreign
 * sessions surface identically (`NOT_FOUND`) so a caller cannot tell
 * whether a sessionId exists for a different user.
 */
export function getOwnedSession(
  sessions: Map<string, SessionEntry>,
  sessionId: string,
  userId: string,
): SessionEntry {
  const entry = sessions.get(sessionId);
  if (entry?.userId !== userId) {
    throw new AppError({
      code: ErrorCode.NOT_FOUND,
      details: { resource: "browser_session" },
    });
  }
  return entry;
}

/**
 * Removes every session whose idle TTL or hard lifetime has elapsed.
 * Fire-and-forget on the context close so overlapping sweeper ticks
 * cannot pile up.
 */
export function evictExpiredSessions(sessions: Map<string, SessionEntry>): void {
  const now = Date.now();
  const expired: SessionEntry[] = [];
  for (const entry of sessions.values()) {
    const idleFor = now - entry.lastActionAt;
    if (idleFor >= PLAYWRIGHT_IDLE_TIMEOUT_MS || now >= entry.hardDeadline) {
      expired.push(entry);
    }
  }
  for (const entry of expired) {
    sessions.delete(entry.sessionId);
    void entry.context.close().catch(swallow);
  }
}

/** Returns the currently active page for the given session entry. */
export function activePage(entry: SessionEntry): Page {
  const page = entry.pages[entry.activePageIndex];
  if (page === undefined) {
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: "Active tab pointer is out of bounds",
    });
  }
  return page;
}
