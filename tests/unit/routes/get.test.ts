import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebGetResult } from "../../../src/tools/web-fetch.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import * as httpFetch from "../../../src/services/http-fetch.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

/** Minimal happy-path result for the fetch service (shared shape with `web_fetch`). */
function makeGetResult(overrides: Partial<WebGetResult> = {}): WebGetResult {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    format: "json",
    body: { success: true },
    url: "https://example.com/api",
    truncated: false,
    droppedRequestHeaders: [],
    ...overrides,
  };
}

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

describe("POST /tools/get", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with format=json result",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue(
        makeGetResult({ format: "json", body: { hello: "world" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", responseFormat: "json" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebGetResult>();
      expect(body.format).toBe("json");
    }),
  );

  it(
    "defaults to method GET and calls runHttpFetch without a body",
    withApp(async (app) => {
      const spy = vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue(makeGetResult());
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const fetchArgs = spy.mock.calls[0]?.[0];
      expect(fetchArgs?.method).toBe("GET");
      expect(fetchArgs?.body).toBeUndefined();
    }),
  );

  it(
    "accepts HEAD as a safe method",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue(makeGetResult());
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", method: "HEAD" },
      });
      expect(response.statusCode).toBe(200);
    }),
  );

  it(
    "rejects requests without a bearer token with 401",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "returns 422 for an unsafe method (POST)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", method: "POST" },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "returns 422 for an unsafe method (DELETE)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", method: "DELETE" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 422 for SSRF target http://localhost/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "http://localhost/" },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "returns 422 for SSRF target http://127.0.0.1/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "http://127.0.0.1/" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 502 UPSTREAM_ERROR when the service throws a redirect_blocked AppError",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockRejectedValue(
        new AppError({
          code: ErrorCode.UPSTREAM_ERROR,
          details: { service: "get", reason: "redirect_blocked" },
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(502);
      const body = response.json<{ error: { code: string; details: { reason: string } } }>();
      expect(body.error.code).toBe("UPSTREAM_ERROR");
      expect(body.error.details.reason).toBe("redirect_blocked");
    }),
  );

  it(
    "returns 504 TIMEOUT when the service throws a TIMEOUT AppError",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockRejectedValue(
        new AppError({ code: ErrorCode.TIMEOUT, details: { service: "get" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/get",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(504);
    }),
  );
});
