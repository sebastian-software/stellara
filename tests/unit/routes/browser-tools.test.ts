/**
 * Smoke tests for the six Playwright-backed `browser_*` routes shipped by
 * plan 0009 (concept §8.19-§8.24). One file covers them all: per route a
 * happy-path (stubs the `PlaywrightClient` service via `vi.spyOn` and
 * asserts the wire format), a 401 (no bearer) and a 422 (validation
 * failure). For `browser_session_start` we additionally pin the 429
 * behaviour when the global session cap is exhausted.
 *
 * Per-service behaviour (pool, sweeper, ownership, output cap) lives in
 * `tests/unit/services/playwright.test.ts`. This file deliberately does
 * **not** double-test the action dispatcher.
 */
import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

function withApp(fn: (app: FastifyInstance) => Promise<void>): () => Promise<void> {
  return async () => {
    const app = await buildApp(makeTestConfig());
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  };
}

function playwright(app: FastifyInstance): NonNullable<FastifyInstance["services"]["playwright"]> {
  const client = app.services.playwright;
  if (client === undefined) {
    throw new Error("Playwright service unexpectedly absent in test fixture");
  }
  return client;
}

describe("POST /tools/browser/session/start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the freshly issued sessionId",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "startSession").mockResolvedValue({
        sessionId: "01J-SESSION",
        url: "https://example.test/",
        title: "Example",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/start",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.test/" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ sessionId: string }>().sessionId).toBe("01J-SESSION");
    }),
  );

  it(
    "maps the global-session-cap error to 429",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "startSession").mockRejectedValue(
        new AppError({
          code: ErrorCode.RATE_LIMITED,
          details: { reason: "global_session_limit" },
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/start",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.test/" },
      });
      expect(response.statusCode).toBe(429);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/start",
        payload: { url: "https://example.test/" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "rejects invalid body (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/start",
        headers: AUTH_HEADERS,
        payload: { url: "not-a-url" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

describe("POST /tools/browser/session/stop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with { stopped: true }",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "stopSession").mockResolvedValue();
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/stop",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ stopped: boolean }>().stopped).toBe(true);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/stop",
        payload: { sessionId: "01J-SESSION" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "rejects invalid body (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/session/stop",
        headers: AUTH_HEADERS,
        payload: { sessionId: "" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

describe("POST /tools/browser/navigate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the resolved URL + title",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "navigate").mockResolvedValue({
        url: "https://example.test/landing",
        title: "Landing",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/navigate",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", url: "https://example.test/landing" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ title?: string }>().title).toBe("Landing");
    }),
  );

  it(
    "rejects an SSRF-blocked URL (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/navigate",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", url: "http://localhost/admin" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/navigate",
        payload: { sessionId: "01J-SESSION", url: "https://example.test/" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/interact", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the per-action result envelope",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "interact").mockResolvedValue({
        results: [{ type: "click", status: "completed" }],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/interact",
        headers: AUTH_HEADERS,
        payload: {
          sessionId: "01J-SESSION",
          actions: [{ type: "click", selector: "button.go" }],
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ results: Array<{ status: string }> }>();
      expect(body.results[0]?.status).toBe("completed");
    }),
  );

  it(
    "rejects unknown action types (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/interact",
        headers: AUTH_HEADERS,
        payload: {
          sessionId: "01J-SESSION",
          actions: [{ type: "teleport", target: "moon" }],
        },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/interact",
        payload: {
          sessionId: "01J-SESSION",
          actions: [{ type: "click", selector: "button" }],
        },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/screenshot", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with a base64 PNG payload",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "screenshot").mockResolvedValue({
        data: "iVBORw0KGgo=",
        mimeType: "image/png",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/screenshot",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", fullPage: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: string; mimeType: string }>().mimeType).toBe("image/png");
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/screenshot",
        payload: { sessionId: "01J-SESSION" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "rejects invalid body (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/screenshot",
        headers: AUTH_HEADERS,
        payload: { sessionId: "" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

describe("POST /tools/browser/content", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the requested content format",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "content").mockResolvedValue({
        url: "https://example.test/",
        title: "Example",
        content: "<html><body>hi</body></html>",
        format: "html",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/content",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", format: "html" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ format: string; content: string }>();
      expect(body.format).toBe("html");
      expect(body.content).toContain("hi");
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/content",
        payload: { sessionId: "01J-SESSION" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "rejects invalid body (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/content",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", format: "pdf" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );
});

// ---------------------------------------------------------------------------
// Plan 0010 — comprehensive extension routes.
// ---------------------------------------------------------------------------

describe("POST /tools/browser/eval", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the evaluation result",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "eval").mockResolvedValue({ result: 42 });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/eval",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", expression: "6 * 7" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ result: unknown }>().result).toBe(42);
    }),
  );

  it(
    "rejects an empty expression (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/eval",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", expression: "" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/eval",
        payload: { sessionId: "01J-SESSION", expression: "1" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/pdf", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the base64 PDF payload",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "pdf").mockResolvedValue({
        data: "JVBERi0=",
        mimeType: "application/pdf",
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/pdf",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", landscape: true },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ mimeType: string }>().mimeType).toBe("application/pdf");
    }),
  );

  it(
    "rejects invalid format (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/pdf",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", format: "Tabloid" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/pdf",
        payload: { sessionId: "01J-SESSION" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/cookies", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 for get mode with the cookie list",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "cookies").mockResolvedValue({
        mode: "get",
        cookies: [{ name: "sid", value: "abc" }],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/cookies",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "get" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ cookies?: Array<{ name: string }> }>();
      expect(body.cookies?.[0]?.name).toBe("sid");
    }),
  );

  it(
    "rejects unknown mode (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/cookies",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "purge" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/cookies",
        payload: { sessionId: "01J-SESSION", mode: "get" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 for get mode with the entries map",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "storage").mockResolvedValue({
        mode: "get",
        target: "local",
        entries: { theme: "dark" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/storage",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "get", target: "local" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ entries?: Record<string, string> }>().entries?.theme).toBe("dark");
    }),
  );

  it(
    "rejects unknown target (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/storage",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "get", target: "indexed" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/storage",
        payload: { sessionId: "01J-SESSION", mode: "clear", target: "local" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/har", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 on stop with the HAR envelope",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "har").mockResolvedValue({
        mode: "stop",
        har: { log: { version: "1.2", entries: [] } },
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/har",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "stop" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ mode: string }>().mode).toBe("stop");
    }),
  );

  it(
    "rejects unknown mode (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/har",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "pause" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/har",
        payload: { sessionId: "01J-SESSION", mode: "start" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("POST /tools/browser/tabs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 for list mode with the tab snapshot",
    withApp(async (app) => {
      vi.spyOn(playwright(app), "tabs").mockResolvedValue({
        mode: "list",
        activeIndex: 0,
        tabs: [{ index: 0, url: "https://example.test/", title: "Example" }],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/tabs",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "list" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ tabs: unknown[] }>().tabs).toHaveLength(1);
    }),
  );

  it(
    "rejects switch without index (422)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/tabs",
        headers: AUTH_HEADERS,
        payload: { sessionId: "01J-SESSION", mode: "switch" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects without bearer (401)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/browser/tabs",
        payload: { sessionId: "01J-SESSION", mode: "list" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});
