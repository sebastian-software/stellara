/**
 * Zod schemas for the four non-memory web tools (`search`, `scrape`, `crawl`,
 * `research`) per concept §8.1–§8.4.
 *
 * The schemas are the single source of truth for request validation,
 * response serialization and the OpenAPI document. Defaults and limits
 * mirror the concept's recommended values; finer tuning happens here so the
 * route handlers stay focused on orchestration.
 */
import { z } from "zod/v4";

import { metadataSchema, safeExternalUrl } from "./common.js";

/** Request body for `POST /tools/search` (§8.1). */
export const searchRequestSchema = z.object({
  query: z.string().min(1).describe("Free-text search query passed to Exa."),
  maxResults: z.number().int().min(1).max(25).default(5),
  type: z
    .enum(["auto", "neural", "keyword"])
    .default("auto")
    .describe(
      "`neural` favours semantic match, `keyword` favours lexical, `auto` lets Exa choose.",
    ),
});

/** Response body for `POST /tools/search` (§8.1). */
export const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      snippet: z.string(),
      /**
       * Only present when the upstream returns a relevance score (Exa
       * neural-results carry one, keyword-results may not).
       */
      score: z.number().optional(),
      publishedAt: z.iso.datetime().optional(),
    }),
  ),
});

/** Request body for `POST /tools/scrape` (§8.2). */
export const scrapeRequestSchema = z.object({
  // `safeExternalUrl` rejects internal Docker hosts, RFC1918 IPs, loopback,
  // link-local and non-http(s) schemes so authenticated callers cannot pivot
  // Firecrawl onto the gateway's own infrastructure (SSRF, see §17).
  url: safeExternalUrl,
  formats: z
    .array(z.enum(["markdown", "html"]))
    .min(1)
    .default(["markdown"])
    .describe("Output formats; `markdown` is recommended for LLM consumption."),
  onlyMainContent: z
    .boolean()
    .default(true)
    .describe("Strip chrome/nav/ads from the scraped content (Firecrawl heuristic)."),
});

/** Response body for `POST /tools/scrape` (§8.2). */
export const scrapeResponseSchema = z.object({
  url: z.url(),
  title: z.string().optional(),
  markdown: z.string().optional(),
  html: z.string().optional(),
  metadata: metadataSchema.optional(),
});

/** Request body for `POST /tools/crawl` (§8.3). */
export const crawlRequestSchema = z.object({
  // Same SSRF guard as `scrapeRequestSchema.url` — see comment there.
  url: safeExternalUrl,
  maxDepth: z.number().int().min(1).max(10).default(2),
  maxPages: z.number().int().min(1).max(100).default(20),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
});

/**
 * Response body for `POST /tools/crawl` (§8.3). The sync wrapper now polls
 * Firecrawl's async job under the hood, so the response carries both a
 * `status` discriminator and the `jobId` — callers that hit the soft cap
 * (`status: "in_progress"`) can resume polling via `/tools/crawl/status`
 * with the same `jobId` (plan 0005).
 */
export const crawlResponseSchema = z.object({
  status: z.enum(["completed", "in_progress"]),
  jobId: z.string().min(1),
  pages: z.array(
    z.object({
      url: z.url(),
      title: z.string().optional(),
      markdown: z.string().optional(),
      html: z.string().optional(),
      metadata: metadataSchema.optional(),
    }),
  ),
  stats: z.object({
    pagesScraped: z.number().int().min(0),
    durationMs: z.number().int().min(0),
  }),
});

/** Request body for `POST /tools/research` (§8.4). */
export const researchRequestSchema = z.object({
  query: z.string().min(1),
  maxSources: z.number().int().min(1).max(10).default(5),
  // Soft cap evaluated inside the route handler; capped strictly below the
  // 60-second route hard cap from §17 so the soft-cap branch always fires
  // before the hard cap converts the request into a 504 TIMEOUT.
  timeBudgetMs: z.number().int().min(1000).max(55_000).default(45_000),
});

/** Response body for `POST /tools/research` (§8.4). */
export const researchResponseSchema = z.object({
  query: z.string(),
  sources: z.array(
    z.object({
      url: z.url(),
      title: z.string(),
      snippet: z.string(),
      content: z.string().optional(),
    }),
  ),
});

/** Inferred TypeScript type for a `search` request body. */
export type SearchRequest = z.infer<typeof searchRequestSchema>;
/** Inferred TypeScript type for a `scrape` request body. */
export type ScrapeRequest = z.infer<typeof scrapeRequestSchema>;
/** Inferred TypeScript type for a `crawl` request body. */
export type CrawlRequest = z.infer<typeof crawlRequestSchema>;
/** Inferred TypeScript type for a `research` request body. */
export type ResearchRequest = z.infer<typeof researchRequestSchema>;

// ---------------------------------------------------------------------------
// Plan 0005 — additional Firecrawl-backed tools (§8.10–§8.16).
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /tools/map` (§8.10). Returns the discovered URL set
 * for the start URL. Bounded `maxUrls` so a huge sitemap cannot drown the
 * caller in a single response.
 */
export const mapRequestSchema = z.object({
  url: safeExternalUrl,
  search: z.string().min(1).optional(),
  maxUrls: z.number().int().min(1).max(5000).default(500),
});

/** Response body for `POST /tools/map` (§8.10). */
export const mapResponseSchema = z.object({
  urls: z.array(z.url()),
});

/**
 * Request body for `POST /tools/extract` (§8.11). Firecrawl accepts either a
 * free-form prompt, a JSON-Schema-shaped extraction spec, or both. Stellara
 * enforces "at least one of prompt or schema" via `.refine`; the schema
 * itself is passed through as an arbitrary record so the upstream-vertrag
 * stays the source of truth.
 */
export const extractRequestSchema = z
  .object({
    urls: z.array(safeExternalUrl).min(1).max(20),
    prompt: z
      .string()
      .min(1)
      .optional()
      .describe("Free-form extraction instruction; combine with `schema` for stricter structure."),
    schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Optional JSON-Schema shape that the extracted output must conform to."),
    systemPrompt: z.string().min(1).optional(),
  })
  .refine((value) => value.prompt !== undefined || value.schema !== undefined, {
    message: "extract requires at least one of `prompt` or `schema`",
  });

/**
 * Response body for `POST /tools/extract` (§8.11). `data` is left as
 * `unknown` because the shape is caller-defined (via `schema`) or
 * model-generated (via `prompt`); we surface it 1:1 without coercion.
 */
export const extractResponseSchema = z.object({
  data: z.unknown(),
  status: z.enum(["completed", "failed", "in_progress"]),
});

/**
 * Request body for `POST /tools/crawl/start` (§8.15). Identical knobs to the
 * sync `crawl` schema; the only difference is the async response contract.
 */
export const crawlStartRequestSchema = crawlRequestSchema;

/** Response body for `POST /tools/crawl/start` (§8.15). */
export const crawlStartResponseSchema = z.object({
  jobId: z.string().min(1),
});

/** Request body for `POST /tools/crawl/status` (§8.16). */
export const crawlStatusRequestSchema = z.object({
  jobId: z.string().min(1).describe("Crawl job id returned by `web_crawl_start`."),
});

/** Per-crawl status discriminator returned by Firecrawl. */
export const crawlStatusValueSchema = z.enum(["scraping", "completed", "failed", "cancelled"]);

/** Response body for `POST /tools/crawl/status` (§8.16). */
export const crawlStatusResponseSchema = z.object({
  status: crawlStatusValueSchema,
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  pages: z.array(
    z.object({
      url: z.url(),
      title: z.string().optional(),
      markdown: z.string().optional(),
      html: z.string().optional(),
      metadata: metadataSchema.optional(),
    }),
  ),
});

/** Inferred TypeScript types for the new request bodies. */
export type MapRequest = z.infer<typeof mapRequestSchema>;
export type ExtractRequest = z.infer<typeof extractRequestSchema>;
export type CrawlStartRequest = z.infer<typeof crawlStartRequestSchema>;
export type CrawlStatusRequest = z.infer<typeof crawlStatusRequestSchema>;

// ---------------------------------------------------------------------------
// Plan 0006 — lightweight HTTP-fetch tools (§8.17/§8.18).
// ---------------------------------------------------------------------------

/**
 * HTTP methods accepted by `POST /tools/fetch`. The set matches the Fetch
 * standard's idempotent + non-idempotent verbs; `CONNECT` and `TRACE` are
 * intentionally not exposed.
 */
export const fetchMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/**
 * Discriminated request-body union (§8.17). The discriminator drives the
 * automatic `Content-Type` default in the service layer:
 *
 * - `json` → `application/json` (value is `JSON.stringify`'d)
 * - `text` → `text/plain; charset=utf-8`
 * - `form` → `application/x-www-form-urlencoded`
 * - `base64` → no implicit content type; caller picks the binary mime
 */
export const fetchBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json"), value: z.unknown() }),
  z.object({ type: z.literal("text"), value: z.string() }),
  z.object({ type: z.literal("form"), value: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("base64"), value: z.string() }),
]);

/**
 * RFC 7230 `token` production for header names: visible ASCII excluding the
 * delimiters/separators. `\w` covers `[0-9A-Z_a-z]`; the remaining special
 * characters (`!#$%&'*+-.^`|~`) are listed explicitly. The pattern matches
 * what Node's `undici` would accept on the wire — we reject anything else at
 * the schema layer so the request never reaches the upstream with a
 * structurally invalid header.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.\w^`|~]+$/;

/**
 * RFC 7230 `field-value`: visible ASCII (0x21-0x7E) plus HTAB (0x09) and SP
 * (0x20). Critically, CR (0x0D) and LF (0x0A) are excluded so a caller cannot
 * smuggle a synthetic header line (CRLF injection / response splitting) via a
 * crafted value. Other control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F,
 * 0x7F) are likewise rejected.
 */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7E]*$/;

/**
 * Header-bag schema reused by both `web_fetch` and `web_graphql`. Header names
 * and values are validated against the RFC 7230 grammar so the SSRF guard is
 * complemented by a "no CRLF injection, no control characters" guarantee.
 */
const fetchHeadersSchema = z
  .record(z.string().min(1), z.string())
  .refine((value) => Object.keys(value).every((name) => HEADER_NAME_PATTERN.test(name)), {
    message:
      "header names must match RFC 7230 token: visible ASCII without separators (no whitespace, no `:` etc.)",
  })
  .refine((value) => Object.values(value).every((header) => HEADER_VALUE_PATTERN.test(header)), {
    message:
      "header values must contain only visible ASCII and HTAB; CR/LF and other control characters are rejected",
  });

/** Response-format mode requested by the caller (§8.17). */
export const fetchResponseFormatSchema = z.enum(["auto", "json", "text", "binary"]);

/** Format actually delivered in the response body (`binary` → base64 string). */
export const fetchResponseFormatActualSchema = z.enum(["json", "text", "binary"]);

/**
 * Request body for `POST /tools/fetch` (§8.17). The `body` field is rejected
 * for body-less methods so callers can never accidentally smuggle a payload
 * past an upstream that ignores GET bodies — the request would otherwise
 * silently lose the data.
 */
export const fetchRequestSchema = z
  .object({
    url: safeExternalUrl,
    method: fetchMethodSchema.default("GET"),
    headers: fetchHeadersSchema.optional(),
    body: fetchBodySchema.optional(),
    responseFormat: fetchResponseFormatSchema.default("auto"),
    followRedirects: z.boolean().default(true),
    maxRedirects: z.number().int().min(0).max(10).default(5),
  })
  .refine(
    (value) => value.body === undefined || !["GET", "HEAD", "OPTIONS"].includes(value.method),
    { message: "`body` is not allowed for GET, HEAD or OPTIONS requests", path: ["body"] },
  );

/**
 * Response body for `POST /tools/fetch` (§8.17). `headers` is a sanitized
 * subset (`Set-Cookie` is always stripped), `body` is unknown because the
 * shape depends on the resolved `format`. `droppedRequestHeaders` lists
 * caller-supplied headers that the service-layer hop-by-hop guard removed —
 * surfaced so the caller can adjust the request rather than wonder why an
 * upstream behavior changed silently.
 */
export const fetchResponseSchema = z.object({
  status: z.number().int().min(0).max(599),
  statusText: z.string(),
  headers: z.record(z.string().min(1), z.string()),
  format: fetchResponseFormatActualSchema,
  body: z.unknown(),
  url: z.url(),
  truncated: z.boolean(),
  droppedRequestHeaders: z.array(z.string()),
});

/**
 * Request body for `POST /tools/graphql` (§8.18). `variables` is left as a
 * `Record<string, unknown>` because GraphQL operations may carry arbitrary
 * input scalars/objects; the gateway does not introspect the schema.
 */
export const graphqlRequestSchema = z.object({
  endpoint: safeExternalUrl,
  query: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).optional(),
  operationName: z.string().min(1).optional(),
  headers: fetchHeadersSchema.optional(),
});

/**
 * Response body for `POST /tools/graphql` (§8.18). GraphQL errors-in-200-body
 * is a normal state, so `errors` is passed through 1:1 (no throw). `status`
 * mirrors the upstream HTTP status for transparency.
 */
export const graphqlResponseSchema = z.object({
  status: z.number().int().min(0).max(599),
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Plan 0014 — read-only siblings `web_get` and `web_graphql_query`
// (§8.31/§8.32). Both reuse the response schemas above; only the request
// side is constrained so the tools can honestly carry `readOnlyHint: true`.
// ---------------------------------------------------------------------------

/**
 * Request body for `POST /tools/get` (§8.31). The read-only sibling of
 * `fetchRequestSchema`: `method` is restricted to the HTTP "safe methods"
 * (`GET`, `HEAD`, `OPTIONS`) and there is no `body` field at all — safe
 * methods carry no payload. The schema is `.strict()`, so a stray `body`
 * (or any other unknown key) is rejected with a 422 rather than silently
 * stripped; this mirrors the strictness of `web_fetch`, which rejects a
 * `body` on safe methods via its `.refine` rule. Everything else mirrors
 * `web_fetch`, including the shared `fetchHeadersSchema` (RFC 7230 header
 * validation) and the SSRF guard on `url`.
 */
export const getRequestSchema = z
  .object({
    url: safeExternalUrl,
    method: z.enum(["GET", "HEAD", "OPTIONS"]).default("GET"),
    headers: fetchHeadersSchema.optional(),
    responseFormat: fetchResponseFormatSchema.default("auto"),
    followRedirects: z.boolean().default(true),
    maxRedirects: z.number().int().min(0).max(10).default(5),
  })
  .strict();

/**
 * Request body for `POST /tools/graphql-query` (§8.32). Structurally
 * identical to `graphqlRequestSchema`; the read-only guarantee is enforced
 * at the orchestrator level, where the `query` string is parsed and rejected
 * if it carries any `mutation`/`subscription` operation (see
 * `src/services/graphql-guard.ts`). Like `getRequestSchema`, the object is
 * `.strict()`: an unknown top-level key is a 422 rather than silently
 * dropped, so the two read-only siblings share the same strict contract.
 */
export const graphqlQueryRequestSchema = z
  .object({
    endpoint: safeExternalUrl,
    // `query` is parsed synchronously by the read-only guard (`assertQueryOnly`)
    // before the upstream call, so — unlike `web_graphql`, which forwards the
    // string unparsed — an unbounded document would block the event loop. Cap it
    // well below the 1 MB body limit; real GraphQL operations are far smaller.
    query: z.string().min(1).max(100_000),
    variables: z.record(z.string(), z.unknown()).optional(),
    operationName: z.string().min(1).optional(),
    headers: fetchHeadersSchema.optional(),
  })
  .strict();

/** Inferred TypeScript type for a `fetch` request body. */
export type FetchRequest = z.infer<typeof fetchRequestSchema>;
/** Inferred TypeScript type for a `fetch` response body. */
export type FetchResponse = z.infer<typeof fetchResponseSchema>;
/** Inferred TypeScript type for a `graphql` request body. */
export type GraphqlRequest = z.infer<typeof graphqlRequestSchema>;
/** Inferred TypeScript type for a `graphql` response body. */
export type GraphqlResponse = z.infer<typeof graphqlResponseSchema>;
/** Inferred TypeScript type for a `get` request body (§8.31). */
export type GetRequest = z.infer<typeof getRequestSchema>;
/** Inferred TypeScript type for a `graphql-query` request body (§8.32). */
export type GraphqlQueryRequest = z.infer<typeof graphqlQueryRequestSchema>;
