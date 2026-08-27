import { describe, expect, it } from "vitest";

import { safeExternalUrl } from "../../../src/schemas/common.js";
import {
  crawlRequestSchema,
  fetchRequestSchema,
  getRequestSchema,
  graphqlQueryRequestSchema,
  graphqlRequestSchema,
  scrapeRequestSchema,
} from "../../../src/schemas/web.js";

/**
 * Vector tests for the SSRF guard applied to user-supplied URLs that
 * eventually reach Firecrawl. These exercise both `safeExternalUrl` directly
 * (the refinement) and the request schemas that wire it in (`scrape`, `crawl`).
 */

const REJECTED_URLS: ReadonlyArray<{ label: string; url: string }> = [
  { label: "localhost", url: "http://localhost/" },
  { label: "localhost with port", url: "http://localhost:8080/" },
  { label: "loopback IPv4", url: "http://127.0.0.1/" },
  { label: "loopback IPv4 with port", url: "http://127.0.0.1:6333/admin" },
  { label: "loopback IPv6", url: "http://[::1]/" },
  { label: "internal qdrant service", url: "http://qdrant:6333/" },
  { label: "internal firecrawl service", url: "http://firecrawl:3002/" },
  { label: "internal embeddings service", url: "http://embeddings:8080/" },
  { label: "internal stellara service", url: "http://stellara:8787/health" },
  { label: "RFC1918 10.0.0.0/8", url: "http://10.0.0.1/" },
  { label: "RFC1918 172.16/12", url: "http://172.16.0.5/" },
  { label: "RFC1918 192.168/16", url: "http://192.168.1.1/" },
  { label: "link-local 169.254/16", url: "http://169.254.169.254/latest/meta-data/" },
  { label: "CGNAT 100.64/10", url: "http://100.64.0.1/" },
  { label: "this-network 0.0.0.0/8", url: "http://0.0.0.0/" },
  { label: ".internal suffix", url: "https://api.internal/" },
  { label: ".local suffix", url: "https://printer.local/" },
  { label: "file:// scheme", url: "file:///etc/passwd" },
  { label: "gopher:// scheme", url: "gopher://example.com/" },
  { label: "ftp:// scheme", url: "ftp://example.com/" },
  { label: "data: scheme", url: "data:text/plain,boom" },
  { label: "IPv6 unique-local (fd..)", url: "http://[fd00::1]/" },
  { label: "IPv6 link-local (fe80::/10)", url: "http://[fe80::1]/" },
  { label: "IPv4-mapped IPv6 to RFC1918", url: "http://[::ffff:192.168.0.1]/" },
];

const ACCEPTED_URLS: ReadonlyArray<{ label: string; url: string }> = [
  { label: "public https", url: "https://example.com/" },
  { label: "public https with path/query", url: "https://api.openai.com/v1/models?foo=1" },
  { label: "public http", url: "http://example.org/page" },
  { label: "public IPv4 literal", url: "https://8.8.8.8/" },
  { label: "public IPv6 literal", url: "https://[2606:4700:4700::1111]/" },
];

describe("safeExternalUrl", () => {
  it.each(REJECTED_URLS)("rejects $label ($url)", ({ url }) => {
    const result = safeExternalUrl.safeParse(url);
    expect(result.success).toBe(false);
  });

  it.each(ACCEPTED_URLS)("accepts $label ($url)", ({ url }) => {
    const result = safeExternalUrl.safeParse(url);
    expect(result.success).toBe(true);
  });

  it("rejects malformed URL strings", () => {
    expect(safeExternalUrl.safeParse("not a url").success).toBe(false);
    expect(safeExternalUrl.safeParse("").success).toBe(false);
  });
});

describe("scrapeRequestSchema.url", () => {
  it("rejects internal hosts via the SSRF guard", () => {
    const result = scrapeRequestSchema.safeParse({ url: "http://qdrant:6333/" });
    expect(result.success).toBe(false);
  });

  it("rejects RFC1918 IP literals", () => {
    const result = scrapeRequestSchema.safeParse({ url: "http://192.168.1.1/" });
    expect(result.success).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    const result = scrapeRequestSchema.safeParse({ url: "file:///etc/passwd" });
    expect(result.success).toBe(false);
  });

  it("accepts a public https URL", () => {
    const result = scrapeRequestSchema.safeParse({ url: "https://example.com/" });
    expect(result.success).toBe(true);
  });

  it("applies defaults alongside the refined URL", () => {
    // Confirms the refinement does not strip sibling defaults — `parse`
    // throws on failure, so the assertions below run only on a valid payload.
    const parsed = scrapeRequestSchema.parse({ url: "https://example.com/" });
    expect(parsed.formats).toStrictEqual(["markdown"]);
    expect(parsed.onlyMainContent).toBe(true);
  });
});

describe("fetchRequestSchema.headers — RFC 7230 grammar", () => {
  const baseUrl = "https://example.com/api";

  it("rejects header values with embedded CRLF (response splitting)", () => {
    const result = fetchRequestSchema.safeParse({
      url: baseUrl,
      headers: { "X-Test": "value\r\nX-Smuggle: evil" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects header values with embedded NUL / control characters", () => {
    const result = fetchRequestSchema.safeParse({
      url: baseUrl,
      headers: { "X-Test": "value\u0000with-nul" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects header names containing whitespace", () => {
    const result = fetchRequestSchema.safeParse({
      url: baseUrl,
      headers: { "X Test": "value" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects header names containing the `:` separator", () => {
    const result = fetchRequestSchema.safeParse({
      url: baseUrl,
      headers: { "X:Test": "value" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a typical Authorization: Bearer header", () => {
    const result = fetchRequestSchema.safeParse({
      url: baseUrl,
      headers: { Authorization: "Bearer abc" },
    });
    expect(result.success).toBe(true);
  });

  it("also enforces the grammar on graphqlRequestSchema.headers", () => {
    const result = graphqlRequestSchema.safeParse({
      endpoint: baseUrl,
      query: "{ ping }",
      headers: { "X-Test": "value\r\nX-Smuggle: evil" },
    });
    expect(result.success).toBe(false);
  });
});

describe("safeExternalUrl — userinfo handling", () => {
  it("rejects URLs with a username", () => {
    const result = safeExternalUrl.safeParse("http://user@example.com/");
    expect(result.success).toBe(false);
  });

  it("rejects URLs with user:password", () => {
    const result = safeExternalUrl.safeParse("http://user:pw@example.com/");
    expect(result.success).toBe(false);
  });

  it("still accepts public URLs without userinfo (control case)", () => {
    const result = safeExternalUrl.safeParse("https://api.example.com/path");
    expect(result.success).toBe(true);
  });
});

describe("crawlRequestSchema.url", () => {
  it("rejects link-local addresses (AWS metadata)", () => {
    const result = crawlRequestSchema.safeParse({ url: "http://169.254.169.254/" });
    expect(result.success).toBe(false);
  });

  it("rejects loopback hostnames", () => {
    const result = crawlRequestSchema.safeParse({ url: "http://localhost/" });
    expect(result.success).toBe(false);
  });

  it("accepts a public https URL", () => {
    const result = crawlRequestSchema.safeParse({ url: "https://example.com/" });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan 0014 — read-only siblings `web_get` and `web_graphql_query` (§8.31/§8.32).
// ---------------------------------------------------------------------------

describe("getRequestSchema.method", () => {
  it.each(["GET", "HEAD", "OPTIONS"] as const)("accepts the safe method %s", (method) => {
    const result = getRequestSchema.safeParse({ url: "https://example.com/", method });
    expect(result.success).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("rejects the write method %s", (method) => {
    const result = getRequestSchema.safeParse({ url: "https://example.com/", method });
    expect(result.success).toBe(false);
  });

  it("defaults method to GET when omitted", () => {
    const parsed = getRequestSchema.parse({ url: "https://example.com/" });
    expect(parsed.method).toBe("GET");
  });
});

describe("getRequestSchema — no body field", () => {
  it("does not produce a `body` key on the parsed output for a plain request", () => {
    const parsed = getRequestSchema.parse({ url: "https://example.com/" });
    expect(Object.keys(parsed)).not.toContain("body");
  });

  it("rejects a request that carries a `body` field (schema is strict)", () => {
    // `.strict()` makes a stray `body` a 422 rather than silently stripping
    // it, mirroring how `web_fetch` rejects a body on safe methods.
    const result = getRequestSchema.safeParse({
      url: "https://example.com/",
      body: { type: "json", value: { key: "value" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects any other unknown key (schema is strict)", () => {
    const result = getRequestSchema.safeParse({
      url: "https://example.com/",
      timeout: 1000,
    });
    expect(result.success).toBe(false);
  });
});

describe("getRequestSchema — SSRF guard on url", () => {
  it("rejects an internal/loopback URL", () => {
    const result = getRequestSchema.safeParse({ url: "http://localhost/" });
    expect(result.success).toBe(false);
  });

  it("rejects an RFC1918 URL", () => {
    const result = getRequestSchema.safeParse({ url: "http://192.168.1.1/" });
    expect(result.success).toBe(false);
  });

  it("accepts a public https URL", () => {
    const result = getRequestSchema.safeParse({ url: "https://example.com/" });
    expect(result.success).toBe(true);
  });
});

describe("getRequestSchema — defaults", () => {
  it("applies all documented defaults", () => {
    const parsed = getRequestSchema.parse({ url: "https://example.com/" });
    expect(parsed.method).toBe("GET");
    expect(parsed.responseFormat).toBe("auto");
    expect(parsed.followRedirects).toBe(true);
    expect(parsed.maxRedirects).toBe(5);
  });
});

describe("graphqlQueryRequestSchema", () => {
  it("accepts a valid query request", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "https://api.example.com/graphql",
      query: "{ ping }",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an internal/SSRF endpoint URL", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "http://localhost/graphql",
      query: "{ ping }",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty query string (min(1))", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "https://api.example.com/graphql",
      query: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key (schema is strict, like getRequestSchema)", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "https://api.example.com/graphql",
      query: "{ ping }",
      timeout: 1000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized query string (max caps the synchronous parse)", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "https://api.example.com/graphql",
      query: `{ ${"a".repeat(100_001)} }`,
    });
    expect(result.success).toBe(false);
  });

  it("also enforces the RFC 7230 header grammar", () => {
    const result = graphqlQueryRequestSchema.safeParse({
      endpoint: "https://api.example.com/graphql",
      query: "{ ping }",
      headers: { "X-Test": "value\r\nX-Smuggle: evil" },
    });
    expect(result.success).toBe(false);
  });
});
