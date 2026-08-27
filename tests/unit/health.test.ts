import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/server.js";
import { makeTestConfig } from "./helpers/test-config.js";

type ProbeFn = (signal: AbortSignal) => Promise<void>;

async function probeOk(): Promise<void> {
  await Promise.resolve();
}

async function probeFail(): Promise<void> {
  await Promise.resolve();
  throw new Error("qdrant down");
}

function stubAllProbes(app: FastifyInstance, impl: ProbeFn): void {
  // `makeTestConfig()` activates every feature, so the optional service
  // entries are always populated. The non-null assertion stays in tests only;
  // production code consults `Config.features` before reaching for these.
  for (const service of ["exa", "firecrawl", "qdrant", "embeddings"] as const) {
    vi.spyOn(app.services[service]!, "probe").mockImplementation(impl);
  }
}

function stubProbe(
  app: FastifyInstance,
  service: "embeddings" | "exa" | "firecrawl" | "qdrant",
  impl: ProbeFn,
): void {
  vi.spyOn(app.services[service]!, "probe").mockImplementation(impl);
}

function neverResolve(): ProbeFn {
  return async (signal) =>
    new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
}

describe("GET /health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 200 with the §15.1 shape and the configured app version", async () => {
    const app = await buildApp(makeTestConfig({ APP_VERSION: "9.9.9" }));
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; service: string; version: string }>();
      expect(body).toStrictEqual({
        status: "ok",
        service: "stellara",
        version: "9.9.9",
      });
    } finally {
      await app.close();
    }
  });

  it("answers without an Authorization header (public allowlist)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("GET /ready", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns 200 when all probes resolve, with each dependency marked ok", async () => {
    const app = await buildApp(makeTestConfig());
    stubAllProbes(app, probeOk);
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; checks: Record<string, string> }>();
      expect(body).toStrictEqual({
        status: "ok",
        checks: {
          exa: "ok",
          firecrawl: "ok",
          qdrant: "ok",
          embeddings: "ok",
          playwright: "ok",
          oauth_storage: "ok",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns 503 when one probe rejects and marks that service as error", async () => {
    const app = await buildApp(makeTestConfig());
    stubProbe(app, "exa", probeOk);
    stubProbe(app, "firecrawl", probeOk);
    stubProbe(app, "qdrant", probeFail);
    stubProbe(app, "embeddings", probeOk);
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe("error");
      expect(body.checks).toStrictEqual({
        exa: "ok",
        firecrawl: "ok",
        qdrant: "error",
        embeddings: "ok",
        playwright: "ok",
        oauth_storage: "ok",
      });
    } finally {
      await app.close();
    }
  });

  it("answers without an Authorization header (public allowlist)", async () => {
    const app = await buildApp(makeTestConfig());
    stubAllProbes(app, probeOk);
    try {
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 503 within the 2 s per-probe budget when a probe hangs", async () => {
    const app = await buildApp(makeTestConfig());
    stubProbe(app, "exa", probeOk);
    stubProbe(app, "firecrawl", probeOk);
    stubProbe(app, "qdrant", neverResolve());
    stubProbe(app, "embeddings", probeOk);
    try {
      // The probe timeout in `/ready` is driven by a real `setTimeout(2000)`.
      // Fake timers let us advance past the per-probe budget without burning
      // wall-clock seconds. We enable them after `buildApp` so Fastify's
      // startup is unaffected, and disable them in `afterEach`.
      vi.useFakeTimers();
      const responsePromise = app.inject({ method: "GET", url: "/ready" });
      // Advance just past the 2 s per-probe budget while flushing microtasks
      // so the inject pipeline can settle once the abort fires.
      await vi.advanceTimersByTimeAsync(2000);
      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      const body = response.json<{ status: string; checks: Record<string, string> }>();
      expect(body.checks.qdrant).toBe("error");
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
