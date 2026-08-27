/**
 * Tests for the request/response schemas of the domain availability tool
 * (plan 0013). The schemas are the wire contract used by the REST surface
 * and the MCP `tools/list` payload, so each accepted/rejected case is a
 * compatibility guarantee.
 */
import { describe, expect, it } from "vitest";

import {
  DOMAIN_AVAILABILITY_SOURCES,
  DOMAIN_AVAILABILITY_STATUSES,
  domainAvailabilityRequestSchema,
  domainAvailabilityResponseSchema,
} from "../../../src/schemas/domain.js";

describe("domainAvailabilityRequestSchema", () => {
  it("accepts a plain ASCII domain", () => {
    const parsed = domainAvailabilityRequestSchema.safeParse({ domain: "example.com" });
    expect(parsed.success).toBe(true);
  });

  it("accepts an IDN string (Punycode conversion happens in the tool layer)", () => {
    const parsed = domainAvailabilityRequestSchema.safeParse({ domain: "käse.de" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an empty string", () => {
    const parsed = domainAvailabilityRequestSchema.safeParse({ domain: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a name beyond 253 characters", () => {
    const tooLong = `${"a".repeat(254)}.com`;
    const parsed = domainAvailabilityRequestSchema.safeParse({ domain: tooLong });
    expect(parsed.success).toBe(false);
  });

  it("rejects a missing domain field", () => {
    const parsed = domainAvailabilityRequestSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("domainAvailabilityResponseSchema", () => {
  it("accepts a registered response", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "registered",
      domain: "example.com",
      tld: "com",
      source: "rdap",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an available response", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "available",
      domain: "example.eu",
      tld: "eu",
      source: "whois",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unsupported_tld response with reason", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "unsupported_tld",
      domain: "example.xyz-unknown",
      tld: "xyz-unknown",
      source: "none",
      reason: "no_registry_endpoint",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an indeterminate response with reason", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "indeterminate",
      domain: "example.io",
      tld: "io",
      source: "whois",
      reason: "rate_limited",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown status discriminator", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "maybe",
      domain: "example.com",
      tld: "com",
      source: "rdap",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown source value", () => {
    const parsed = domainAvailabilityResponseSchema.safeParse({
      status: "registered",
      domain: "example.com",
      tld: "com",
      source: "dns",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("DOMAIN_AVAILABILITY_STATUSES / DOMAIN_AVAILABILITY_SOURCES", () => {
  it("exposes the four documented status values", () => {
    expect(new Set(DOMAIN_AVAILABILITY_STATUSES)).toStrictEqual(
      new Set(["registered", "available", "unsupported_tld", "indeterminate"]),
    );
  });

  it("exposes the three documented source values", () => {
    expect(new Set(DOMAIN_AVAILABILITY_SOURCES)).toStrictEqual(new Set(["rdap", "whois", "none"]));
  });
});
