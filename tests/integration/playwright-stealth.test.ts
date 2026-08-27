/**
 * Integration tests for plan 0012 — Playwright stealth mode.
 *
 * These tests start real Chromium browser sessions via the Stellara REST API
 * and probe the resulting page environment with `browser_eval` to assert on
 * fingerprint properties. They require a live Stellara instance wired to
 * Chromium (STELLARA_PLAYWRIGHT_ENABLED must be true, which is the default).
 *
 * The suite is excluded from `pnpm test` / `pnpm agent:check` (see
 * `vitest.config.ts`). It runs via `pnpm test:integration`, which loads
 * `vitest.integration.config.ts`.
 *
 * Note on global kill-switch test (STELLARA_PLAYWRIGHT_STEALTH=false):
 * The stealth plugin is registered once at module load in
 * `playwright-pool.ts`, before any test infrastructure runs. Changing
 * process.env at test runtime cannot undo the `chromium.use(StealthPlugin())`
 * call that already happened. Testing the global off-switch would require
 * a separate child process started with the env var set before the module
 * loads. That is beyond the scope of an in-process integration test suite and
 * is therefore covered only by the config unit tests (see
 * `tests/unit/config.test.ts` — STELLARA_PLAYWRIGHT_STEALTH parsing) and by
 * the manual acceptance criterion in plan 0012. The global off-switch test
 * below is skipped with an explanatory reason.
 */
import type { FastifyInstance } from "fastify";

import { afterAll, beforeAll, describe, expect, it, test } from "vitest";

import { loadConfig } from "../../src/config.js";
import { buildApp } from "../../src/server.js";
import { getIntegrationHeaders } from "./helpers/auth.js";

/** Probe script evaluated in the page context; returns a serialisable snapshot. */
const FINGERPRINT_PROBE = `({
  userAgent: navigator.userAgent,
  webdriver: navigator.webdriver,
  languagesFirst: navigator.languages[0],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  chromeType: typeof window.chrome,
})`;

type SessionStartResponse = {
  sessionId: string;
  url: string;
  title?: string;
};

type IntegrationHeaders = ReturnType<typeof getIntegrationHeaders>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function startSession(
  app: FastifyInstance,
  headers: IntegrationHeaders,
  opts: { stealth?: boolean } = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/tools/browser/session/start",
    headers,
    payload: {
      url: "https://example.com/",
      ...(opts.stealth !== undefined && { stealth: opts.stealth }),
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<SessionStartResponse>();
  return body.sessionId;
}

/**
 * Evaluates the fingerprint probe and returns the result as-is. All
 * assertions happen via `expect(fp).toHaveProperty(key, value)` so
 * no type assertions are needed in callers.
 */
async function evalFingerprint(
  app: FastifyInstance,
  headers: IntegrationHeaders,
  sessionId: string,
): Promise<unknown> {
  const response = await app.inject({
    method: "POST",
    url: "/tools/browser/eval",
    headers,
    payload: { sessionId, expression: FINGERPRINT_PROBE },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ result: unknown }>().result;
}

async function stopSession(
  app: FastifyInstance,
  headers: IntegrationHeaders,
  sessionId: string,
): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/tools/browser/session/stop",
    headers,
    payload: { sessionId },
  });
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe("integration: playwright stealth — stealth on (default)", () => {
  const HEADERS = getIntegrationHeaders();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig());
  });

  afterAll(async () => {
    await app.close();
  });

  it("session started without stealth param uses stealth-on behaviour", async () => {
    const sessionId = await startSession(app, HEADERS);
    try {
      const fp = await evalFingerprint(app, HEADERS, sessionId);

      // UA must not contain "Headless" — the spoofed Linux Chrome UA is used.
      expect(fp).toHaveProperty("userAgent", expect.not.stringMatching(/Headless/i));

      // UA must contain Chrome/<digits> (spoofed Linux Chrome stable UA).
      expect(fp).toHaveProperty("userAgent", expect.stringMatching(/Chrome\/\d+/));

      // navigator.webdriver is patched by the stealth plugin to false/undefined.
      expect(fp).not.toHaveProperty("webdriver", true);

      // Locale is set to de-DE via the context options.
      expect(fp).toHaveProperty("languagesFirst", "de-DE");

      // Timezone is set to Europe/Berlin via the context options.
      expect(fp).toHaveProperty("timezone", "Europe/Berlin");

      // window.chrome is patched by the stealth plugin (typeof "object").
      expect(fp).toHaveProperty("chromeType", "object");
    } finally {
      await stopSession(app, HEADERS, sessionId);
    }
  });

  it("session started with explicit stealth: true is identical to default stealth", async () => {
    const sessionId = await startSession(app, HEADERS, { stealth: true });
    try {
      const fp = await evalFingerprint(app, HEADERS, sessionId);
      expect(fp).toHaveProperty("userAgent", expect.not.stringMatching(/Headless/i));
      expect(fp).toHaveProperty("languagesFirst", "de-DE");
      expect(fp).toHaveProperty("timezone", "Europe/Berlin");
    } finally {
      await stopSession(app, HEADERS, sessionId);
    }
  });
});

describe("integration: playwright stealth — stealth: false (per-session opt-out)", () => {
  const HEADERS = getIntegrationHeaders();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadConfig());
  });

  afterAll(async () => {
    await app.close();
  });

  it("session started with stealth: false keeps HeadlessChrome in userAgent", async () => {
    const sessionId = await startSession(app, HEADERS, { stealth: false });
    try {
      const fp = await evalFingerprint(app, HEADERS, sessionId);

      // With stealth: false the context gets no UA override → Chromium headless UA is used.
      expect(fp).toHaveProperty("userAgent", expect.stringMatching(/Headless/i));

      // Default Chromium locale when no per-context override is applied.
      // Asserting positively guards against a future stealth-plugin version
      // that starts patching navigator.languages — the previous negative
      // assertion would have tolerated that silently.
      expect(fp).toHaveProperty("languagesFirst", "en-US");
    } finally {
      await stopSession(app, HEADERS, sessionId);
    }
  });

  it("stealth: false keeps navigator.webdriver falsy (plugin still active)", async () => {
    // Per-session stealth: false only disables context identity (UA/locale/timezone/viewport).
    // The stealth plugin is bound to the shared browser process and stays active,
    // so navigator.webdriver remains patched to false even in stealth-off sessions.
    // This is the documented asymmetry from plan 0012.
    const sessionId = await startSession(app, HEADERS, { stealth: false });
    try {
      const fp = await evalFingerprint(app, HEADERS, sessionId);
      // webdriver is patched to false/undefined by the plugin even in stealth-off mode.
      expect(fp).not.toHaveProperty("webdriver", true);
    } finally {
      await stopSession(app, HEADERS, sessionId);
    }
  });

  it("stealth: false keeps window.chrome as object (plugin still active)", async () => {
    const sessionId = await startSession(app, HEADERS, { stealth: false });
    try {
      const fp = await evalFingerprint(app, HEADERS, sessionId);
      expect(fp).toHaveProperty("chromeType", "object");
    } finally {
      await stopSession(app, HEADERS, sessionId);
    }
  });
});

describe("integration: playwright stealth — global kill-switch (STELLARA_PLAYWRIGHT_STEALTH=false)", () => {
  // The stealth plugin is registered once at module load in playwright-pool.ts.
  // Changing process.env.STELLARA_PLAYWRIGHT_STEALTH at test runtime cannot
  // undo the `chromium.use(StealthPlugin())` call that already executed during
  // module initialisation. In-process integration tests therefore cannot
  // reliably test the "plugin never registered" path without a separate child
  // process. This scenario is covered by:
  //   - Unit tests for config parsing (tests/unit/config.test.ts)
  //   - Manual acceptance criterion in plan 0012
  test.skip("global stealth off: both UA spoof and plugin patches are disabled", () => {
    // Would require process restart with STELLARA_PLAYWRIGHT_STEALTH=false set
    // before playwright-pool.ts is imported. Not testable in-process.
  });
});
