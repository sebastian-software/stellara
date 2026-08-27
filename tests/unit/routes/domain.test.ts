/**
 * Route-level tests for `POST /tools/domain/availability` plus the MCP
 * `tools/call` adapter for `domain_availability` (plan 0013).
 *
 * Both surfaces consume the same `runDomainAvailability` function, but the
 * REST handler must additionally emit the audit-log line and the MCP
 * adapter must wrap the result in the `structuredContent` envelope. Each
 * status path is exercised once through REST and once through MCP so the
 * two transports cannot drift.
 */
import type { FastifyInstance } from "fastify";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DomainAvailabilityResult } from "../../../src/tools/domain.js";

import { buildApp } from "../../../src/server.js";
import * as rdap from "../../../src/services/rdap.js";
import * as whois from "../../../src/services/whois.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../helpers/test-config.js";

const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN_USER_A}` };
const MCP_HEADERS = {
  ...AUTH_HEADERS,
  accept: "application/json",
  "content-type": "application/json",
  host: "stellara.example.test",
  "x-forwarded-proto": "https",
};

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

function withAppDomainDisabled(fn: (app: FastifyInstance) => Promise<void>): () => Promise<void> {
  return async () => {
    const app = await buildApp(makeTestConfig({ STELLARA_DOMAIN_ENABLED: "false" }));
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  };
}

/** Convenience for the registered RDAP shortcut: returns the canonical base URL plus a registered verdict. */
function mockRdapRegistered(baseUrl: string): void {
  vi.spyOn(rdap, "resolveRdapBaseUrl").mockResolvedValue(baseUrl);
  vi.spyOn(rdap, "lookupRdap").mockResolvedValue({ status: "registered" });
}

/** Convenience for the available RDAP shortcut. */
function mockRdapAvailable(baseUrl: string): void {
  vi.spyOn(rdap, "resolveRdapBaseUrl").mockResolvedValue(baseUrl);
  vi.spyOn(rdap, "lookupRdap").mockResolvedValue({ status: "available" });
}

/** Convenience for the WHOIS path when RDAP is not configured for the TLD. */
function mockWhoisRegistered(server: string): void {
  vi.spyOn(rdap, "resolveRdapBaseUrl").mockResolvedValue(undefined);
  vi.spyOn(whois, "resolveWhoisServer").mockResolvedValue(server);
  vi.spyOn(whois, "lookupWhois").mockResolvedValue({ status: "registered" });
}

function mockWhoisAvailable(server: string): void {
  vi.spyOn(rdap, "resolveRdapBaseUrl").mockResolvedValue(undefined);
  vi.spyOn(whois, "resolveWhoisServer").mockResolvedValue(server);
  vi.spyOn(whois, "lookupWhois").mockResolvedValue({ status: "available" });
}

function mockUnsupported(): void {
  vi.spyOn(rdap, "resolveRdapBaseUrl").mockResolvedValue(undefined);
  vi.spyOn(whois, "resolveWhoisServer").mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /tools/domain/availability", () => {
  it(
    "returns registered via RDAP for a gTLD",
    withApp(async (app) => {
      mockRdapRegistered("https://rdap.example.test/");
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "example.com" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<DomainAvailabilityResult>();
      expect(body).toStrictEqual({
        status: "registered",
        domain: "example.com",
        tld: "com",
        source: "rdap",
      });
    }),
  );

  it(
    "returns available via RDAP for a gTLD",
    withApp(async (app) => {
      mockRdapAvailable("https://rdap.example.test/");
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "this-one-is-free.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<DomainAvailabilityResult>().status).toBe("available");
    }),
  );

  it(
    "returns registered via WHOIS for .eu",
    withApp(async (app) => {
      mockWhoisRegistered("whois.eu");
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "eurid.eu" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<DomainAvailabilityResult>();
      expect(body).toStrictEqual({
        status: "registered",
        domain: "eurid.eu",
        tld: "eu",
        source: "whois",
      });
    }),
  );

  it(
    "returns available via WHOIS for .eu",
    withApp(async (app) => {
      mockWhoisAvailable("whois.eu");
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "free-name-1234.eu" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<DomainAvailabilityResult>().status).toBe("available");
    }),
  );

  it(
    "returns unsupported_tld when neither RDAP nor WHOIS resolves",
    withApp(async (app) => {
      mockUnsupported();
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "example.xyz-unknown" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<DomainAvailabilityResult>();
      expect(body.status).toBe("unsupported_tld");
      expect(body.source).toBe("none");
      expect(body.reason).toBe("no_registry_endpoint");
    }),
  );

  it(
    "normalises an IDN input to Punycode",
    withApp(async (app) => {
      const resolveSpy = vi
        .spyOn(rdap, "resolveRdapBaseUrl")
        .mockResolvedValue("https://rdap.denic.de/");
      const lookupSpy = vi.spyOn(rdap, "lookupRdap").mockResolvedValue({ status: "registered" });
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "käse.de" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<DomainAvailabilityResult>();
      expect(body.domain).toBe("xn--kse-qla.de");
      expect(body.tld).toBe("de");
      expect(resolveSpy).toHaveBeenCalledWith("de", expect.anything());
      expect(lookupSpy).toHaveBeenCalledWith(
        "https://rdap.denic.de/",
        "xn--kse-qla.de",
        expect.anything(),
      );
    }),
  );

  it(
    "rejects an empty domain with 422",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "" },
      });
      expect(response.statusCode).toBe(422);
    }),
  );

  it(
    "rejects requests without a bearer token with 401",
    withApp(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        payload: { domain: "example.com" },
      });
      expect(response.statusCode).toBe(401);
    }),
  );
});

describe("STELLARA_DOMAIN_ENABLED=false", () => {
  it(
    "leaves the REST route unregistered",
    withAppDomainDisabled(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/tools/domain/availability",
        headers: AUTH_HEADERS,
        payload: { domain: "example.com" },
      });
      expect(response.statusCode).toBe(404);
    }),
  );

  it(
    "hides domain_availability from the MCP tools/list payload",
    withAppDomainDisabled(async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: MCP_HEADERS,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ result: { tools: Array<{ name: string }> } }>();
      const names = body.result.tools.map((tool) => tool.name);
      expect(names).not.toContain("domain_availability");
    }),
  );
});

describe("MCP tools/call — domain_availability", () => {
  it(
    "returns the same result envelope as the REST surface",
    withApp(async (app) => {
      mockRdapRegistered("https://rdap.example.test/");
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: MCP_HEADERS,
        payload: {
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "domain_availability", arguments: { domain: "example.com" } },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        result: { structuredContent: DomainAvailabilityResult };
      }>();
      expect(body.result.structuredContent).toStrictEqual({
        status: "registered",
        domain: "example.com",
        tld: "com",
        source: "rdap",
      });
    }),
  );
});
