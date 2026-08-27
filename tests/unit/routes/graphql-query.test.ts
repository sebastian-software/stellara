import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebGraphqlQueryResult } from "../../../src/tools/web-fetch.js";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { buildApp } from "../../../src/server.js";
import * as httpFetch from "../../../src/services/http-fetch.js";
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

describe("POST /tools/graphql-query", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with the same response shape as web_graphql for a read-only query",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        format: "json",
        body: { data: { ping: "pong" } },
        url: "https://api.example.com/graphql",
        truncated: false,
        droppedRequestHeaders: [],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ ping }",
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebGraphqlQueryResult>();
      expect(body.status).toBe(200);
      expect(body.data).toStrictEqual({ ping: "pong" });
    }),
  );

  it(
    "returns 200 with an errors array in the body (GraphQL convention — no throw)",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
        format: "json",
        body: {
          errors: [{ message: "field not found", locations: [{ line: 1, column: 3 }] }],
        },
        url: "https://api.example.com/graphql",
        truncated: false,
        droppedRequestHeaders: [],
      });
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ nonExistentField }",
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebGraphqlQueryResult>();
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors).toHaveLength(1);
    }),
  );

  it(
    "rejects requests without a bearer token with 401",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ ping }",
        },
      });
      expect(response.statusCode).toBe(401);
    }),
  );

  it(
    "returns 422 VALIDATION_ERROR when query is missing",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
        },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "returns 422 VALIDATION_ERROR for a SSRF endpoint",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "http://localhost/graphql",
          query: "{ ping }",
        },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    }),
  );

  it(
    "rejects a mutation query with 400 BAD_REQUEST before calling the upstream",
    withApp(async (app) => {
      const spy = vi.spyOn(httpFetch, "runHttpFetch");
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "mutation { doThing }",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(spy).not.toHaveBeenCalled();
    }),
  );

  it(
    "rejects a subscription query with 400 BAD_REQUEST before calling the upstream",
    withApp(async (app) => {
      const spy = vi.spyOn(httpFetch, "runHttpFetch");
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "subscription OnThing { thingChanged }",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(spy).not.toHaveBeenCalled();
    }),
  );

  it(
    "returns 504 TIMEOUT when the service throws a TIMEOUT AppError",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockRejectedValue(
        new AppError({ code: ErrorCode.TIMEOUT, details: { service: "graphql-query" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql-query",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ ping }",
        },
      });
      expect(response.statusCode).toBe(504);
    }),
  );
});
