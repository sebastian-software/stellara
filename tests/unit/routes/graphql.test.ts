import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebGraphqlResult } from "../../../src/tools/web-fetch.js";

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

describe("POST /tools/graphql", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "returns 200 with data from the service",
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
        url: "/tools/graphql",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ ping }",
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebGraphqlResult>();
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
        url: "/tools/graphql",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ nonExistentField }",
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<WebGraphqlResult>();
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors).toHaveLength(1);
    }),
  );

  it(
    "rejects requests without a bearer token with 401",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql",
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
        url: "/tools/graphql",
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
        url: "/tools/graphql",
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
    "returns 504 TIMEOUT when the service throws a TIMEOUT AppError",
    withApp(async (app) => {
      vi.spyOn(httpFetch, "runHttpFetch").mockRejectedValue(
        new AppError({ code: ErrorCode.TIMEOUT, details: { service: "graphql" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: "/tools/graphql",
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

describe("POST /tools/graphql — service call verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls runHttpFetch with method POST and Content-Type application/json including query, variables, operationName", async () => {
    const app = await buildApp(makeTestConfig());
    const spy = vi.spyOn(httpFetch, "runHttpFetch").mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      format: "json",
      body: { data: { ping: "pong" } },
      url: "https://api.example.com/graphql",
      truncated: false,
      droppedRequestHeaders: [],
    });

    try {
      await app.inject({
        method: "POST",
        url: "/tools/graphql",
        headers: AUTH_HEADERS,
        payload: {
          endpoint: "https://api.example.com/graphql",
          query: "{ ping }",
          variables: { id: "123" },
          operationName: "GetPing",
        },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0];
      const fetchArgs = callArgs?.[0];
      // Must use POST with JSON body containing query + variables + operationName.
      expect(fetchArgs?.method).toBe("POST");
      expect(fetchArgs?.body?.type).toBe("json");
      const bodyValue = fetchArgs?.body?.value;
      expect(bodyValue).toStrictEqual({
        query: "{ ping }",
        variables: { id: "123" },
        operationName: "GetPing",
      });
    } finally {
      await app.close();
    }
  });
});
