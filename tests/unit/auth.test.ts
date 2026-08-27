import type { FastifyInstance } from "fastify";

import { describe, expect, it, vi } from "vitest";

import { signAccessToken } from "../../src/oauth/tokens.js";
import { buildApp } from "../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A, TEST_TOKEN_USER_B } from "./helpers/test-config.js";

type CapturedLogLine = { clientIp?: string; msg?: string; userId?: string };

function pickString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function projectLogLine(value: unknown): CapturedLogLine {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record: Record<string, unknown> = { ...value };
  return {
    clientIp: pickString(record.clientIp),
    msg: pickString(record.msg),
    userId: pickString(record.userId),
  };
}

/**
 * Splits the captured pino stream output (one or more chunks of newline-
 * separated JSON) into structured log lines, projecting only the fields the
 * audit-log assertions care about. Keeping the parsing flat here avoids the
 * conditional-in-test lint rule firing on the assertion block itself.
 */
function parseCapturedLines(captured: readonly string[]): CapturedLogLine[] {
  const rawLines = captured
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.trim().length > 0);
  return rawLines.map((raw) => projectLogLine(JSON.parse(raw)));
}

/**
 * Stubs every readiness probe with a no-op resolve so `/ready` tests don't
 * attempt real network calls against the `.example.test` URLs in the test
 * config.
 */
function stubReadinessProbes(app: FastifyInstance): void {
  vi.spyOn(app.services.exa!, "probe").mockResolvedValue();
  vi.spyOn(app.services.firecrawl, "probe").mockResolvedValue();
  vi.spyOn(app.services.qdrant!, "probe").mockResolvedValue();
  vi.spyOn(app.services.embeddings!, "probe").mockResolvedValue();
}

describe("createAuthHook", () => {
  it("allows GET /health without an Authorization header", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      // /health is registered by Schritt 2; the auth hook lets the request
      // through and the handler answers with 200.
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows GET /ready without an Authorization header", async () => {
    const app = await buildApp(makeTestConfig());
    stubReadinessProbes(app);
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      // Auth hook lets the request reach the handler; with stubbed probes
      // the readiness response is 200. The important fact for this test is
      // that we never see 401.
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("allows GET /openapi.json without an Authorization header", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects /tools/search without Authorization with 401 envelope", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "POST", url: "/tools/search" });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("rejects /tools/search with a bogus bearer token", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: { authorization: "Bearer not-a-real-token" },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown token that matches a known token's length", async () => {
    // Regression guard for the constant-time token lookup: an attacker who
    // guesses the correct token length must not accidentally authenticate,
    // and the comparison must not short-circuit on length equality.
    // The configured token is 64 chars; we send a different 64-char token.
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: {
          authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("rejects /tools/search with a malformed Authorization header", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/search",
        headers: { authorization: "Basic abc" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("accepts a lowercase 'bearer' scheme (RFC 6750 §2.1)", async () => {
    const config = makeTestConfig();
    const app = await buildApp(config);
    app.post("/tools/probe", (request) => ({ userId: request.userId }));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ userId: "user_a" });
    } finally {
      await app.close();
    }
  });

  it("treats a trailing slash on a public path as public", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/health/" });
      // Auth hook lets it through; Fastify still returns 404 because no route
      // is registered yet, but importantly NOT a 401.
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("accepts a valid Bearer token and resolves the userId", async () => {
    const config = makeTestConfig();
    const observedUserIds: Array<string | undefined> = [];

    const app = await buildApp(config);
    app.addHook("preHandler", (request, _reply, done) => {
      observedUserIds.push(request.userId);
      done();
    });
    app.post("/tools/probe", (request) => ({ userId: request.userId }));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toStrictEqual({ userId: "user_a" });
      expect(observedUserIds).toContain("user_a");
    } finally {
      await app.close();
    }
  });

  it("rejects a valid OAuth JWT that lacks the required mcp scope", async () => {
    const config = makeTestConfig();
    const app = await buildApp(config);
    const jwt = await signAccessToken(app.services.oauth.signingKey, {
      issuer: config.publicBaseUrl,
      audience: `${config.publicBaseUrl}/mcp`,
      userId: "user_a",
      clientId: "oauth-client",
      scope: "profile",
      ttlSeconds: 60,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/json",
          "content-type": "application/json",
          host: "stellara.example.test",
          "x-forwarded-proto": "https",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain('scope="mcp"');
    } finally {
      await app.close();
    }
  });

  it("rejects a revoked bearer token with 401 even when it is still in the token map", async () => {
    // The token is listed in BOTH STELLARA_TOKEN_USER_A and the
    // revocation list — the revocation must win so a leaked credential can
    // be disabled without removing its env var.
    const config = makeTestConfig({
      STELLARA_REVOKED_TOKENS: TEST_TOKEN_USER_A,
    });
    const app = await buildApp(config);
    app.post("/tools/probe", (request) => ({ userId: request.userId }));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(response.statusCode).toBe(401);
      const body = response.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("UNAUTHORIZED");
    } finally {
      await app.close();
    }
  });

  it("ignores empty fragments in STELLARA_REVOKED_TOKENS", async () => {
    const config = makeTestConfig({
      STELLARA_REVOKED_TOKENS: ` , ${TEST_TOKEN_USER_B} ,, `,
    });
    const app = await buildApp(config);
    app.post("/tools/probe", (request) => ({ userId: request.userId }));

    try {
      // user_a is not revoked → still passes.
      const ok = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(ok.statusCode).toBe(200);

      // user_b is revoked (whitespace-trimmed) → 401.
      const revoked = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_B}` },
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("emits an info-level audit log on successful authentication", async () => {
    // Bump the log level past `silent` so the audit-ok line is actually
    // produced, then route pino's output through an in-memory stream so we
    // can parse the JSON without relying on stdout spying (sonic-boom
    // writes to fd=1 directly and bypasses `process.stdout.write` mocks).
    const config = makeTestConfig({ LOG_LEVEL: "info" });
    const captured: string[] = [];
    const sink = {
      write(chunk: string): void {
        captured.push(chunk);
      },
    };

    const app = await buildApp(config, { loggerDestination: sink });
    app.post("/tools/probe", (request) => ({ userId: request.userId }));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/tools/probe",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(response.statusCode).toBe(200);

      const lines = parseCapturedLines(captured);
      const authOk = lines.find((entry) => entry.msg === "auth ok");
      expect(authOk).toBeDefined();
      expect(authOk?.userId).toBe("user_a");
      expect(typeof authOk?.clientIp).toBe("string");
    } finally {
      await app.close();
    }
  });
});
