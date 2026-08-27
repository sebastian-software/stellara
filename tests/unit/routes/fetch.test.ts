import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebFetchResult } from "../../../src/tools/web-fetch.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import * as httpFetch from "../../../src/services/http-fetch.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };

/** Minimal happy-path result for the fetch service. */
function makeFetchResult(overrides: Partial<WebFetchResult> = {}): WebFetchResult {
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

describe("POST /tools/fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with format=json result",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue(
        makeFetchResult({ format: "json", body: { hello: "world" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", responseFormat: "json" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebFetchResult>();
      expect(body.format).toBe("json");
    }),
  );

  it(
    "returns 200 with format=text result",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue(
        makeFetchResult({ format: "text", body: "plain text content" }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api", responseFormat: "text" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebFetchResult>();
      expect(body.format).toBe("text");
    }),
  );

  it(
    "rejects requests without a bearer token with 401",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "returns 422 for SSRF target http://localhost/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
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
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "http://127.0.0.1/" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 422 for SSRF target http://10.0.0.1/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "http://10.0.0.1/" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 422 for SSRF target http://qdrant:6333/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "http://qdrant:6333/" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 422 for SSRF target http://example.internal/",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "http://example.internal/" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "returns 422 for a URL carrying userinfo (http://user:pw@example.com/)",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "http://user:pw@example.com/" },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "returns 422 when body is set with method GET",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: {
          url: "https://example.com/api",
          method: "GET",
          body: { type: "json", value: { key: "value" } },
        },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "returns 502 UPSTREAM_ERROR when the service throws a redirect_blocked AppError",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockRejectedValue(
        new AppError({
          code: ErrorCode.UPSTREAM_ERROR,
          details: { service: "fetch", reason: "redirect_blocked" },
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
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
        new AppError({ code: ErrorCode.TIMEOUT, details: { service: "fetch" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/fetch",
        headers: AUTH_HEADERS,
        payload: { url: "https://example.com/api" },
      });
      expect(response.statusCode).toBe(504);
    }),
  );
});
