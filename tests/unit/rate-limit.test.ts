import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A, TEST_TOKEN_USER_B } from "./helpers/test-config.js";

describe("unauth rate-limit", () => {
  it("rate-limits the 11th unauthenticated request from the same IP", async () => {
    const config = makeTestConfig({
      UNAUTH_RATE_LIMIT_MAX: "10",
      UNAUTH_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = await buildApp(config);

    try {
      // First ten requests without bearer hit the auth hook and answer 401.
      for (let i = 0; i < 10; i += 1) {
        const response = await app.inject({ method: "POST", url: "/tools/search" });
        expect(response.statusCode).toBe(401);
      }

      // The 11th request from the same (default) IP exceeds the unauth
      // bucket and must be rejected as RATE_LIMITED before the auth hook
      // runs.
      const eleventh = await app.inject({ method: "POST", url: "/tools/search" });
      expect(eleventh.statusCode).toBe(429);
      const body = eleventh.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("RATE_LIMITED");
      expect(eleventh.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("does not throttle authenticated requests via the unauth bucket", async () => {
    const config = makeTestConfig({
      UNAUTH_RATE_LIMIT_MAX: "2",
      UNAUTH_RATE_LIMIT_WINDOW_MS: "60000",
      RATE_LIMIT_MAX: "100",
      RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = await buildApp(config);
    app.post("/tools/probe", () => ({ ok: true }));

    try {
      // Far more requests than the unauth tier permits — every one carries a
      // valid bearer and must succeed.
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/tools/probe",
          headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("exempts public paths from the unauth rate-limit", async () => {
    const config = makeTestConfig({
      UNAUTH_RATE_LIMIT_MAX: "1",
      UNAUTH_RATE_LIMIT_WINDOW_MS: "60000",
    });
    const app = await buildApp(config);

    try {
      // /health is public (§6.4) — five hits in a row must all 200, even
      // though the unauth bucket is capped at 1.
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});

describe("rate-limit integration", () => {
  it("counts consecutive authenticated requests against the same userId key", async () => {
    const config = makeTestConfig({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    const app = await buildApp(config);
    app.post("/tools/limited", () => ({ ok: true }));

    try {
      const first = await app.inject({
        method: "POST",
        url: "/tools/limited",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/tools/limited",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(second.statusCode).toBe(429);
      const body = second.json<{ error: { code: string } }>();
      expect(body.error.code).toBe("RATE_LIMITED");
    } finally {
      await app.close();
    }
  });

  it("tracks different users in separate buckets", async () => {
    const config = makeTestConfig({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    const app = await buildApp(config);
    app.post("/tools/limited", () => ({ ok: true }));

    try {
      const userA = await app.inject({
        method: "POST",
        url: "/tools/limited",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_A}` },
      });
      expect(userA.statusCode).toBe(200);

      const userB = await app.inject({
        method: "POST",
        url: "/tools/limited",
        headers: { authorization: `Bearer ${TEST_TOKEN_USER_B}` },
      });
      expect(userB.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("exempts public paths from rate-limit accounting", async () => {
    const config = makeTestConfig({ RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_MS: "60000" });
    // /health is registered by Schritt 2 inside buildApp itself and lives
    // on the public allowlist (§6.4) — five hits in a row must all 200.
    const app = await buildApp(config);

    try {
      const responses = await Promise.all(
        Array.from({ length: 5 }, async () => app.inject({ method: "GET", url: "/health" })),
      );
      const statuses = responses.map((r) => r.statusCode);
      expect(statuses).toStrictEqual([200, 200, 200, 200, 200]);
    } finally {
      await app.close();
    }
  });
});
