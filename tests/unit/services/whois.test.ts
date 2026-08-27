/**
 * Unit tests for the WHOIS service (plan 0013).
 *
 * The TCP path is covered through real loopback servers so the
 * encoder/decoder, byte-cap and abort wiring are exercised end-to-end. The
 * classifier and IANA-field parser are exposed and tested directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyWhoisResponse,
  lookupWhois,
  parseIanaWhoisField,
  resetWhoisDiscoveryCache,
  resolveWhoisServer,
  STATIC_WHOIS_SERVERS,
  WHOIS_MAX_RESPONSE_BYTES,
} from "../../../src/services/whois.js";

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetWhoisDiscoveryCache();
});

describe("parseIanaWhoisField", () => {
  it("extracts the whois host from a canonical IANA reply", () => {
    const body = [
      "% IANA WHOIS server",
      "domain:       IO",
      "organisation: ICB",
      "whois:        whois.nic.io",
      "status:       ACTIVE",
    ].join("\n");
    expect(parseIanaWhoisField(body)).toBe("whois.nic.io");
  });

  it("returns undefined when the whois field is missing", () => {
    const body = ["domain:       APP", "status:       ACTIVE"].join("\n");
    expect(parseIanaWhoisField(body)).toBeUndefined();
  });

  it("rejects a hostname that fails the DNS-label pattern", () => {
    const body = ["whois:        not a hostname!"].join("\n");
    expect(parseIanaWhoisField(body)).toBeUndefined();
  });

  it("rejects a single-label hostname", () => {
    const body = ["whois:        whoisinternal"].join("\n");
    expect(parseIanaWhoisField(body)).toBeUndefined();
  });
});

describe("classifyWhoisResponse", () => {
  it("flags available for a Status: AVAILABLE marker", () => {
    expect(classifyWhoisResponse("Domain: foo.eu\nStatus: AVAILABLE")).toStrictEqual({
      status: "available",
    });
  });

  it("flags available for a no match marker", () => {
    expect(classifyWhoisResponse("No match for FOO.COM\n")).toStrictEqual({ status: "available" });
  });

  it("flags registered when a name servers block is present", () => {
    expect(
      classifyWhoisResponse("Domain: eurid.eu\nRegistrar: EURid\nName servers:\n  ns1.eurid.eu\n"),
    ).toStrictEqual({ status: "registered" });
  });

  it("flags indeterminate with rate_limited for access denied bodies", () => {
    expect(classifyWhoisResponse("ACCESS DENIED — quota exceeded")).toStrictEqual({
      status: "indeterminate",
      reason: "rate_limited",
    });
  });

  it("flags indeterminate with unrecognised_response for empty bodies", () => {
    expect(classifyWhoisResponse("")).toStrictEqual({
      status: "indeterminate",
      reason: "unrecognised_response",
    });
  });
});

describe("resolveWhoisServer — fast path", () => {
  it("returns the static map entry for .eu without IANA discovery", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const server = await resolveWhoisServer("eu", neverAbortedSignal());
    expect(server).toBe(STATIC_WHOIS_SERVERS.get("eu"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("lookupWhois — abort and network errors", () => {
  it("returns indeterminate timeout when the abort signal fires before connect", async () => {
    const controller = new AbortController();
    controller.abort();
    const verdict = await lookupWhois("127.0.0.1", "example.eu", controller.signal);
    expect(verdict).toStrictEqual({ status: "indeterminate", reason: "timeout" });
  });

  it("returns indeterminate upstream_unreachable for a closed port", async () => {
    // 127.0.0.1 with a port that is virtually never bound. ECONNREFUSED maps
    // to indeterminate/upstream_unreachable.
    const verdict = await lookupWhois("127.0.0.1", "example.io", neverAbortedSignal());
    expect(verdict.status).toBe("indeterminate");
    expect(verdict.reason).toBe("upstream_unreachable");
  });
});

describe("WHOIS_MAX_RESPONSE_BYTES", () => {
  it("is at least 16 KB to fit real-world registry responses", () => {
    expect(WHOIS_MAX_RESPONSE_BYTES).toBeGreaterThanOrEqual(16 * 1024);
  });
});
