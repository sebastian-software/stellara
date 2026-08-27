/**
 * Static configuration constants for the Playwright session pool (plan 0009).
 *
 * Held in a dedicated module so the `PlaywrightClient` stays focused on
 * lifecycle logic and the values are referenced by both the service and the
 * Vitest suite without circular imports. The TTL values are intentionally not
 * configurable via environment — operators that bump them risk leaking
 * forgotten browser contexts long enough to exhaust the container's memory
 * budget, which would defeat the §6.3 / §22 isolation goals.
 */

/**
 * Maximum time a session may sit idle without any caller action before the
 * background sweeper closes its browser context. The 5-minute window covers
 * typical LLM "think + click" cadence while still reclaiming memory promptly
 * when an agent forgets to call `browser_session_stop`.
 */
export const PLAYWRIGHT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Absolute lifetime of a single session regardless of activity. Even an
 * always-busy session is forcefully closed after 30 minutes so a runaway
 * automation cannot pin a context indefinitely.
 */
export const PLAYWRIGHT_HARD_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Interval at which the background sweeper inspects every active session
 * and evicts those that breached either TTL above. 30 seconds keeps the
 * worst-case overshoot small (idle + 30 s) without burning CPU on otherwise
 * idle deployments.
 */
export const PLAYWRIGHT_SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * Hard byte cap on serialized browser-tool outputs (PNG screenshot in slice
 * 2, plus future PDF/eval/HAR payloads in slice 3). Mirrors the 10 MB body
 * cap of `web_fetch` so the gateway never streams unbounded blobs back to
 * MCP clients.
 */
export const PLAYWRIGHT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;
