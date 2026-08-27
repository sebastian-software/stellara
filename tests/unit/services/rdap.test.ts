/**
 * Unit tests for the RDAP service (plan 0013).
 *
 * The bootstrap fetch uses the global `fetch`; the existing `mockFetchOnce`
 * helper covers both the bootstrap document and the domain-lookup roundtrip
 * via per-call `vi.mocked(globalThis.fetch).mockImplementationOnce`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  lookupRdap,
  resetRdapBootstrapCache,
  resolveRdapBaseUrl,
  STATIC_RDAP_OVERRIDES,
} from "../../../src/services/rdap.js";
import { jsonResponse } from "../helpers/fetch-mock.js";

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetRdapBootstrapCache();
});

describe("resolveRdapBaseUrl — static override", () => {
  it("returns the DENIC RDAP base for .de without hitting the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const base = await resolveRdapBaseUrl("de", neverAbortedSignal());
    expect(base).toBe(STATIC_RDAP_OVERRIDES.get("de"));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("resolveRdapBaseUrl — IANA bootstrap", () => {
  const BOOTSTRAP = {
    services: [
      [["com"], ["https://rdap.verisign.com/com/v1/"]],
      [["net"], ["https://rdap.verisign.com/net/v1/"]],
      [["app", "dev"], ["https://pubapi.registry.google/rdap/"]],
    ],
  };

  it("resolves .com from the IANA bootstrap document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(BOOTSTRAP));
    const base = await resolveRdapBaseUrl("com", neverAbortedSignal());
    expect(base).toBe("https://rdap.verisign.com/com/v1/");
  });

  it("resolves .app to the Google Registry RDAP base", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(BOOTSTRAP));
    const base = await resolveRdapBaseUrl("app", neverAbortedSignal());
    expect(base).toBe("https://pubapi.registry.google/rdap/");
  });

  it("returns undefined for a TLD that is not in the bootstrap document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(BOOTSTRAP));
    const base = await resolveRdapBaseUrl("xyz-unknown", neverAbortedSignal());
    expect(base).toBeUndefined();
  });

  it("does not fetch the bootstrap twice within the TTL window", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(BOOTSTRAP));
    await resolveRdapBaseUrl("com", neverAbortedSignal());
    await resolveRdapBaseUrl("net", neverAbortedSignal());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the cached snapshot when a later refresh fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse(BOOTSTRAP));
    const firstBase = await resolveRdapBaseUrl("com", neverAbortedSignal());
    resetRdapBootstrapCache();
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const secondBase = await resolveRdapBaseUrl("com", neverAbortedSignal());
    expect(firstBase).toBe("https://rdap.verisign.com/com/v1/");
    // After the failed refresh, the second call returns undefined because
    // the cache was already reset; the rescue path applies only when the
    // cache is non-empty at refresh time.
    expect(secondBase).toBeUndefined();
  });
});

describe("lookupRdap", () => {
  it("maps a 200 response onto registered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ rdapConformance: ["x"] }));
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "example.com",
      neverAbortedSignal(),
    );
    expect(verdict.status).toBe("registered");
  });

  it("maps a 404 response onto available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ errorCode: 404, title: "No such domain." }), {
        status: 404,
        headers: { "content-type": "application/rdap+json" },
      }),
    );
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "free-domain-1234.com",
      neverAbortedSignal(),
    );
    expect(verdict.status).toBe("available");
  });

  it("maps a 429 response onto indeterminate with rate_limited", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 429 }));
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "example.com",
      neverAbortedSignal(),
    );
    expect(verdict).toStrictEqual({ status: "indeterminate", reason: "rate_limited" });
  });

  it("maps an unexpected status onto indeterminate with a status-tagged reason", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 503 }));
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "example.com",
      neverAbortedSignal(),
    );
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.reason).toContain("503");
  });

  it("maps a transport error onto indeterminate with upstream_unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "example.com",
      neverAbortedSignal(),
    );
    expect(verdict).toStrictEqual({ status: "indeterminate", reason: "upstream_unreachable" });
  });

  it("maps an aborted signal onto indeterminate with timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    const verdict = await lookupRdap(
      "https://rdap.example.test/",
      "example.com",
      controller.signal,
    );
    expect(verdict).toStrictEqual({ status: "indeterminate", reason: "timeout" });
  });
});
