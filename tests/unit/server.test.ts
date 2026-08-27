import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { Writable } from "node:stream";
import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";

import { createLoggerOptions, LOG_REDACT_PATHS } from "../../src/logger.js";
import { buildApp } from "../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "./helpers/test-config.js";

describe("buildApp", () => {
  it("returns a Fastify instance ready for in-memory injection", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      expect(typeof app.inject).toBe("function");
      expect(app.config).toBeDefined();
      expect(app.config.tokens.size).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("rejects /tools/search without Authorization via the auth hook", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/tools/search" });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(typeof body.error.message).toBe("string");
    } finally {
      await app.close();
    }
  });

  it("sets an x-request-id response header (§21)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/tools/search" });
      const requestId = response.headers["x-request-id"];
      expect(typeof requestId).toBe("string");
      expect(requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    } finally {
      await app.close();
    }
  });

  it("maps malformed JSON bodies to BAD_REQUEST (400) per §16.2", async () => {
    const app = await buildApp(makeTestConfig());
    app.post("/tools/probe", () => ({ ok: true }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: {
          authorization: `Bearer ${TEST_TOKEN_USER_A}`,
          "content-type": "application/json",
        },
        payload: "{not-json",
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("BAD_REQUEST");
    } finally {
      await app.close();
    }
  });

  it("maps Fastify validation failures to VALIDATION_ERROR (422) per §16.2", async () => {
    const app = await buildApp(makeTestConfig());
    app.withTypeProvider<ZodTypeProvider>().route({
      method: "POST",
      url: "/tools/probe",
      schema: { body: z.object({ query: z.string().min(1) }) },
      handler: () => ({ ok: true }),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
        payload: { query: "" },
      });
      expect(response.statusCode).toBe(422);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });

  it("decorates the app with config and tokens", async () => {
    const config = makeTestConfig();
    const app = await buildApp(config);
    try {
      expect(app.config.publicBaseUrl).toBe(config.publicBaseUrl);
      expect(app.config.tokens.get(TEST_TOKEN_USER_A)).toBe("user_a");
    } finally {
      await app.close();
    }
  });

  it("closes the process-scoped OAuth client resolver during app shutdown", async () => {
    const app = await buildApp(makeTestConfig());
    const closeResolver = vi.spyOn(app.services.oauth.clientResolver, "close");

    await app.close();

    expect(closeResolver).toHaveBeenCalledTimes(1);
    await expect(
      app.services.oauth.clientResolver.resolveClient(
        "https://client.example/metadata.json",
        "203.0.114.10",
      ),
    ).rejects.toMatchObject({ kind: "temporarily_unavailable" });
  });

  it("trusts X-Forwarded-For from peers inside TRUSTED_PROXY_CIDRS", async () => {
    const config = makeTestConfig({ TRUSTED_PROXY_CIDRS: "10.0.0.0/8,127.0.0.1/8,::1/128" });
    const app = await buildApp(config);
    app.get("/__probe-ip", (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/__probe-ip",
        headers: {
          authorization: `Bearer ${TEST_TOKEN_USER_A}`,
          "x-forwarded-for": "1.2.3.4",
        },
        remoteAddress: "10.0.0.1",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ ip: string }>().ip).toBe("1.2.3.4");
    } finally {
      await app.close();
    }
  });

  it("ignores X-Forwarded-For from peers outside TRUSTED_PROXY_CIDRS (§7.1)", async () => {
    // Only loopback is trusted — a peer in `203.0.113.0/24` must NOT be able
    // to inject a fake client-IP via `X-Forwarded-For`. `request.ip` must
    // fall back to the actual TCP peer address.
    const config = makeTestConfig({ TRUSTED_PROXY_CIDRS: "127.0.0.1/8,::1/128" });
    const app = await buildApp(config);
    app.get("/__probe-ip", (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/__probe-ip",
        headers: {
          authorization: `Bearer ${TEST_TOKEN_USER_A}`,
          "x-forwarded-for": "1.2.3.4",
        },
        remoteAddress: "203.0.113.1",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ ip: string }>().ip).toBe("203.0.113.1");
    } finally {
      await app.close();
    }
  });

  it("skips feature-gated routes and services when their credentials are absent", async () => {
    // Strip every optional credential — only Firecrawl-backed tools should
    // remain registered, and the deactivated services must stay `undefined`
    // on the decorator so accidental access surfaces immediately in tests.
    const config = makeTestConfig({
      EXA_API_KEY: "",
      QDRANT_BASE_URL: "",
      QDRANT_API_KEY: "",
      EMBEDDINGS_API_KEY: "",
    });
    const app = await buildApp(config);
    try {
      expect(app.config.features).toStrictEqual({
        exa: false,
        firecrawl: true,
        embeddings: false,
        memory: false,
        fetch: true,
        playwright: true,
        domain: true,
      });
      expect(app.services.exa).toBeUndefined();
      expect(app.services.qdrant).toBeUndefined();
      expect(app.services.embeddings).toBeUndefined();
      expect(app.services.firecrawl).toBeDefined();

      // Auth-protected feature routes should return 404 (route not registered),
      // even with a valid bearer token. Auth runs first, so a 404 here also
      // proves the auth hook is happy with our credentials.
      const headers = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };
      const searchResponse = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers,
        payload: { query: "anything" },
      });
      expect(searchResponse.statusCode).toBe(404);

      const memoryResponse = await app.inject({
        method: "POST",
        url: "/tools/memory/upsert",
        headers,
        payload: { text: "x" },
      });
      expect(memoryResponse.statusCode).toBe(404);

      // Firecrawl-backed routes stay registered.
      const scrapeResponse = await app.inject({
        method: "POST",
        url: "/tools/scrape",
        headers,
        payload: { url: "https://example.com" },
      });
      // The route exists; we expect a non-404 status (the upstream call will
      // fail because the test config points at a non-existent host, but the
      // status code reflects the route being matched).
      expect(scrapeResponse.statusCode).not.toBe(404);
    } finally {
      await app.close();
    }
  });

  it("declares redaction paths matching concept §21", () => {
    expect([...LOG_REDACT_PATHS]).toContain("req.headers.authorization");
    expect([...LOG_REDACT_PATHS]).toContain("req.body.text");
  });

  it("redacts the Authorization header via Pino's redact configuration", () => {
    const captured: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback): void {
        captured.push(String(chunk));
        callback();
      },
    });

    const config = makeTestConfig({ LOG_LEVEL: "info" });
    const logger = pino(createLoggerOptions(config), sink);
    logger.info(
      {
        req: {
          headers: { authorization: "Bearer super-secret-token" },
          body: { text: "private text" },
        },
      },
      "request",
    );
    logger.flush();

    const joined = captured.join("");
    expect(joined).not.toContain("super-secret-token");
    expect(joined).not.toContain("private text");
    expect(joined).toContain("[redacted]");
  });
});
