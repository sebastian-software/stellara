/**
 * Unit tests for {@link PlaywrightClient} — pool lifecycle, concurrency
 * limits, idle/hard sweeper, ownership check, output cap. Uses the shared
 * mock bag from `tests/unit/helpers/playwright-mock.ts` and `vi.mock` to
 * replace the real `chromium` import so no actual Chromium process is
 * spawned during the suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode } from "../../../src/errors.js";
import {
  PLAYWRIGHT_HARD_LIFETIME_MS,
  PLAYWRIGHT_IDLE_TIMEOUT_MS,
} from "../../../src/services/playwright-config.js";
import { makeMockTrio, type MockBrowser } from "../helpers/playwright-mock.js";
import { makeTestConfig } from "../helpers/test-config.js";

const launchMock = vi.fn<() => Promise<MockBrowser>>();

// `playwright-pool.ts` imports `chromium` from `playwright-extra` (plan 0012);
// the mock must target the same module so `ensureBrowser` and `deriveChromeMajor`
// receive our controlled fake without spawning Chromium.
vi.mock("playwright-extra", () => ({
  chromium: {
    launch: launchMock,
    // `use()` is called during module init for the stealth plugin; it must
    // exist as a no-op to avoid a TypeError at import time.
    use: vi.fn(),
  },
}));

// Dynamic import keeps `vi.mock` in scope before the service is loaded.
const { PlaywrightClient } = await import("../../../src/services/playwright.js");

describe("PlaywrightClient lifecycle", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazily launches Chromium on the first startSession and reuses it", async () => {
    const trio1 = makeMockTrio();
    const trio2 = makeMockTrio();
    launchMock.mockResolvedValue(trio1.browser);
    trio1.browser.newContext
      .mockResolvedValueOnce(trio1.context)
      .mockResolvedValueOnce(trio2.context);
    trio1.page.url.mockReturnValue("https://a.test/");
    trio2.page.url.mockReturnValue("https://b.test/");

    const client = new PlaywrightClient(
      makeTestConfig({ STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER: "2" }),
    );
    const a = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    const b = await client.startSession({
      userId: "alice",
      url: "https://b.test/",
      signal: abortSignal(),
    });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(client.getActiveSessionCount()).toBe(2);
    await client.close();
  });

  it("enforces the global session cap", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    // Pre-stage three independent contexts so the global cap is exhausted
    // by the second `startSession` (with `maxSessions=2`, the third
    // attempt below must hit the limit gate).
    trio.browser.newContext
      .mockResolvedValueOnce(makeMockTrio().context)
      .mockResolvedValueOnce(makeMockTrio().context)
      .mockResolvedValueOnce(makeMockTrio().context);

    const client = new PlaywrightClient(
      makeTestConfig({
        STELLARA_PLAYWRIGHT_MAX_SESSIONS: "2",
        STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER: "1",
      }),
    );
    await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await client.startSession({
      userId: "bob",
      url: "https://b.test/",
      signal: abortSignal(),
    });
    await expect(
      client.startSession({
        userId: "carol",
        url: "https://c.test/",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
      details: { reason: "global_session_limit" },
    });
    await client.close();
  });

  it("enforces the per-user session cap independently of the global one", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    trio.browser.newContext
      .mockResolvedValueOnce(makeMockTrio().context)
      .mockResolvedValueOnce(makeMockTrio().context);

    const client = new PlaywrightClient(
      makeTestConfig({
        STELLARA_PLAYWRIGHT_MAX_SESSIONS: "5",
        STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER: "1",
      }),
    );
    await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.startSession({
        userId: "alice",
        url: "https://b.test/",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.RATE_LIMITED,
      details: { reason: "user_session_limit" },
    });
    await client.close();
  });

  it("returns NOT_FOUND when a session is accessed by a different user", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.stopSession({ sessionId: session.sessionId, userId: "bob" }),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    // Same NOT_FOUND surface for unknown sessionIds.
    await expect(
      client.stopSession({ sessionId: "01JFAKE", userId: "alice" }),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    await client.close();
  });

  it("evicts an idle session after the idle TTL elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    expect(client.getActiveSessionCount()).toBe(1);

    // Jump past the idle TTL without ticking the sweeper interval — the
    // production sweeper would have evicted the entry on its next tick, and
    // `runSweepNow` is the test hook that lets us assert that without
    // depending on the interval cadence.
    vi.setSystemTime(new Date(Date.now() + PLAYWRIGHT_IDLE_TIMEOUT_MS + 1000));
    client.runSweepNow();
    expect(client.getActiveSessionCount()).toBe(0);

    await expect(
      client.stopSession({ sessionId: session.sessionId, userId: "alice" }),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    await client.close();
  });

  it("evicts a session that exceeds the hard lifetime even when active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    await client.startSession({ userId: "alice", url: "https://a.test/", signal: abortSignal() });

    // Jump past the hard deadline using `setSystemTime` rather than
    // `advanceTimersByTime` so the sweeper interval does not fire
    // automatically while we're still setting up — `runSweepNow` is the
    // explicit trigger.
    vi.setSystemTime(new Date(Date.now() + PLAYWRIGHT_HARD_LIFETIME_MS + 1000));
    client.runSweepNow();
    expect(client.getActiveSessionCount()).toBe(0);
    await client.close();
  });
});

describe("PlaywrightClient stealth context options (plan 0012)", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it("passes the spoofed Linux Chrome identity to newContext when stealth defaults apply", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });

    expect(trio.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        userAgent: expect.stringMatching(
          /^Mozilla\/5\.0 \(X11; Linux x86_64\).+Chrome\/\d+\.0\.0\.0/,
        ),
        locale: "de-DE",
        timezoneId: "Europe/Berlin",
        viewport: { width: 1366, height: 768 },
        deviceScaleFactor: 1,
        colorScheme: "light",
      }),
    );
    await client.close();
  });

  it("passes empty context options to newContext when the per-session stealth flag is false", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
      stealth: false,
    });

    expect(trio.browser.newContext).toHaveBeenCalledWith({});
    await client.close();
  });

  it("passes empty context options to newContext when the operator kill-switch is off, even if stealth is requested", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig({ STELLARA_PLAYWRIGHT_STEALTH: "false" }));
    await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
      stealth: true,
    });

    expect(trio.browser.newContext).toHaveBeenCalledWith({});
    await client.close();
  });
});

describe("PlaywrightClient action dispatch", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it("runs a click + fill + wait chain and reports per-action results", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    const result = await client.interact({
      sessionId: session.sessionId,
      userId: "alice",
      actions: [
        { type: "click", selector: "button.go" },
        { type: "fill", selector: "input[name=q]", text: "stellara" },
        { type: "wait", durationMs: 50 },
      ],
      signal: abortSignal(),
    });
    expect(result.results.map((entry) => entry.status)).toStrictEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(trio.page.click).toHaveBeenCalledWith("button.go", expect.objectContaining({}));
    expect(trio.page.fill).toHaveBeenCalledWith(
      "input[name=q]",
      "stellara",
      expect.objectContaining({}),
    );
    expect(trio.page.waitForTimeout).toHaveBeenCalledWith(50);
    await client.close();
  });

  it("aborts the chain after the first failed action", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    trio.page.click.mockRejectedValueOnce(new Error("selector not found"));

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    const result = await client.interact({
      sessionId: session.sessionId,
      userId: "alice",
      actions: [
        { type: "click", selector: "button.missing" },
        { type: "fill", selector: "input", text: "should not run" },
      ],
      signal: abortSignal(),
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("failed");
    expect(trio.page.fill).not.toHaveBeenCalled();
    await client.close();
  });
});

describe("PlaywrightClient output cap", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it("rejects a screenshot exceeding the 10 MB cap", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    // 11 MB buffer — comfortably above the 10 MB limit.
    trio.page.screenshot.mockResolvedValueOnce(Buffer.alloc(11 * 1024 * 1024));

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.screenshot({
        sessionId: session.sessionId,
        userId: "alice",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "playwright", reason: "output_too_large" },
    });
    await client.close();
  });

  it("rejects an eval result that exceeds the 1 MB output cap", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    // Build a deliberately oversized serialised string (~1.5 MB).
    trio.page.evaluate.mockResolvedValueOnce("x".repeat(1_500_000));

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.eval({
        sessionId: session.sessionId,
        userId: "alice",
        expression: "'huge'",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "playwright", reason: "output_too_large" },
    });
    await client.close();
  });
});

describe("PlaywrightClient HAR lifecycle", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it("rejects stop without a prior start", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.har({
        sessionId: session.sessionId,
        userId: "alice",
        mode: "stop",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: { reason: "no_har_recording" },
    });
    await client.close();
  });

  it("rejects a second start while recording is active", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await client.har({
      sessionId: session.sessionId,
      userId: "alice",
      mode: "start",
      signal: abortSignal(),
    });
    await expect(
      client.har({
        sessionId: session.sessionId,
        userId: "alice",
        mode: "start",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: { reason: "har_already_recording" },
    });
    await client.close();
  });
});

describe("PlaywrightClient tabs", () => {
  beforeEach(() => {
    launchMock.mockReset();
  });

  it("rejects closing the last tab", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    await expect(
      client.tabs({
        sessionId: session.sessionId,
        userId: "alice",
        mode: "close",
        index: 0,
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: { reason: "cannot_close_last_tab" },
    });
    await client.close();
  });

  it("rejects opening a sixth tab", async () => {
    const trio = makeMockTrio();
    launchMock.mockResolvedValue(trio.browser);
    // First call: initial tab from session_start.
    // Then four more `new` operations use the same mocked context.
    trio.context.newPage
      .mockResolvedValueOnce(trio.page)
      .mockResolvedValueOnce(makeMockTrio().page)
      .mockResolvedValueOnce(makeMockTrio().page)
      .mockResolvedValueOnce(makeMockTrio().page)
      .mockResolvedValueOnce(makeMockTrio().page);

    const client = new PlaywrightClient(makeTestConfig());
    const session = await client.startSession({
      userId: "alice",
      url: "https://a.test/",
      signal: abortSignal(),
    });
    for (let i = 0; i < 4; i += 1) {
      await client.tabs({
        sessionId: session.sessionId,
        userId: "alice",
        mode: "new",
        signal: abortSignal(),
      });
    }
    await expect(
      client.tabs({
        sessionId: session.sessionId,
        userId: "alice",
        mode: "new",
        signal: abortSignal(),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: { reason: "tab_limit_reached" },
    });
    await client.close();
  });
});

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}
