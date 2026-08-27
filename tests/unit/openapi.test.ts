import { describe, expect, it } from "vitest";

import { buildApp } from "../../src/server.js";
import { makeTestConfig } from "./helpers/test-config.js";

type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string; description?: string }>;
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string }>;
  };
  paths: Record<string, unknown>;
};

describe("GET /openapi.json", () => {
  it("returns 200 with application/json and an OpenAPI 3.1 document", async () => {
    const app = await buildApp(makeTestConfig({ APP_VERSION: "9.9.9" }));
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toMatch(/application\/json/);

      const body = response.json<OpenApiDocument>();
      expect(body.openapi).toBe("3.1.0");
      expect(body.info.title).toBe("Stellara");
      expect(body.info.version).toBe("9.9.9");
    } finally {
      await app.close();
    }
  });

  it("advertises the configured public base URL as the only server", async () => {
    const app = await buildApp(makeTestConfig({ PUBLIC_BASE_URL: "https://stellara.example/api" }));
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<OpenApiDocument>();
      expect(body.servers).toStrictEqual([
        { url: "https://stellara.example/api", description: "Public API" },
      ]);
    } finally {
      await app.close();
    }
  });

  it.each(["https://stellara.example/api/", "https://stellara.example/api///"])(
    "removes trailing slashes from the configured public base URL %s",
    async (publicBaseUrl) => {
      const app = await buildApp(makeTestConfig({ PUBLIC_BASE_URL: publicBaseUrl }));
      try {
        const response = await app.inject({ method: "GET", url: "/openapi.json" });
        const body = response.json<OpenApiDocument>();
        expect(body.servers).toStrictEqual([
          { url: "https://stellara.example/api", description: "Public API" },
        ]);
      } finally {
        await app.close();
      }
    },
  );

  it("declares a bearerAuth http/bearer security scheme", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<OpenApiDocument>();
      const scheme = body.components.securitySchemes.bearerAuth;
      expect(scheme).toBeDefined();
      expect(scheme?.type).toBe("http");
      expect(scheme?.scheme).toBe("bearer");
    } finally {
      await app.close();
    }
  });

  it("answers without an Authorization header (public allowlist)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // The /openapi.json route itself is hidden via `schema: { hide: true }`
  // — the OpenAPI document does not need to document its own delivery
  // endpoint and keeping it out of `paths` reduces clutter for the
  // ChatGPT Actions builder.
  it("includes /health and /ready in the paths object (Zod schemas picked up)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<OpenApiDocument>();
      expect(Object.keys(body.paths)).toContain("/health");
      expect(Object.keys(body.paths)).toContain("/ready");
      expect(Object.keys(body.paths)).not.toContain("/openapi.json");
    } finally {
      await app.close();
    }
  });

  it("lists all eight tool routes with their MCP-aligned operationIds", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<OpenApiDocument>();
      const paths = Object.keys(body.paths);
      expect(paths).toContain("/tools/search");
      expect(paths).toContain("/tools/scrape");
      expect(paths).toContain("/tools/crawl");
      expect(paths).toContain("/tools/research");
      expect(paths).toContain("/tools/memory/upsert");
      expect(paths).toContain("/tools/memory/search");
      expect(paths).toContain("/tools/memory/list");
      expect(paths).toContain("/tools/memory/delete");
    } finally {
      await app.close();
    }
  });

  it("mirrors the tool-suite overview into `info.description` (plan 0011)", async () => {
    const app = await buildApp(makeTestConfig());
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<OpenApiDocument>();
      // The mirror is unconditional after plan 0011 — fail loudly if it
      // is missing rather than silently fall through to the marker checks.
      expect(typeof body.info.description).toBe("string");
      const text = body.info.description!;
      expect(text.length).toBeGreaterThanOrEqual(500);
      // Marker check — no brittle wording assertions.
      expect(text).toContain("tool families");
      expect(text).toContain("web_scrape");
      expect(text).toContain("browser_");
      expect(text).toContain("memory_");
    } finally {
      await app.close();
    }
  });

  it("each tool operation carries the MCP-aligned operationId and bearer security", async () => {
    const app = await buildApp(makeTestConfig());
    type Operation = { operationId?: string; security?: Array<Record<string, unknown>> };
    type PathEntry = { post?: Operation };
    const expected: Record<string, string> = {
      "/tools/search": "web_search",
      "/tools/scrape": "web_scrape",
      "/tools/crawl": "web_crawl",
      "/tools/research": "web_research",
      "/tools/memory/upsert": "memory_upsert",
      "/tools/memory/search": "memory_search",
      "/tools/memory/list": "memory_list",
      "/tools/memory/delete": "memory_delete",
    };
    try {
      const response = await app.inject({ method: "GET", url: "/openapi.json" });
      const body = response.json<{ paths: Record<string, PathEntry> }>();
      for (const [path, operationId] of Object.entries(expected)) {
        const op = body.paths[path]?.post;
        expect(op?.operationId).toBe(operationId);
        expect(op?.security).toStrictEqual([{ bearerAuth: [] }]);
      }
    } finally {
      await app.close();
    }
  });
});
