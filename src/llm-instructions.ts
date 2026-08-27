/**
 * Shared LLM-discoverability copy (plan 0011).
 *
 * The same Markdown blob lands in three places so MCP clients (Claude
 * Desktop, Codex, …) and OpenAPI consumers (Custom GPT Actions, Swagger
 * UI) see identical tool-selection guidance:
 *
 * - `src/routes/mcp/server.ts` exposes it through modern MCP 2026-07-28
 *   `server/discover`, which does not use an `initialize` handshake.
 * - `src/routes/mcp/initialize.ts` emits it as the `instructions` field for
 *   the temporary initialization-based legacy protocol versions.
 * - `src/routes/openapi.ts` mirrors it into `info.description` of the
 *   generated OpenAPI 3.1 document.
 *
 * Keeping it as a TypeScript constant — rather than an external `.md` file
 * loaded at runtime — means the build stays self-contained and no
 * filesystem read happens on the hot path of modern `server/discover`,
 * legacy `initialize` or `/openapi.json`.
 */

/**
 * Markdown overview of Stellara's tool families plus selection heuristics,
 * auth, rate-limit and output-cap notes. Designed to be useful both as
 * modern discovery guidance, legacy initialization guidance and a
 * developer-facing OpenAPI description.
 *
 * Length budget: 500-10000 characters (plan 0011 started at 500-4000, plan
 * 0012 raised it to 5000 to fit the `Browser fingerprint` section, plan
 * 0011's tool-by-tool revision lifted it to 8000, and plan 0013 raised it
 * to 10000 to add the `domain_*` family without dropping any existing
 * steering text). Stellara adds no separate limit at either MCP discovery
 * surface. Markdown is rendered by both MCP clients and Swagger UI; we keep
 * it to headings, bullets and inline code — no HTML, no images.
 */
export const STELLARA_SUITE_OVERVIEW = `# Stellara tool gateway

Stellara is a private AI tool gateway. Its **primary purpose is fetching
public web content** — single pages, multi-page crawls, semantic search
and combined research pipelines — and it additionally exposes an
interactive headless-browser sandbox, generic HTTP/GraphQL clients, a
per-user persistent vector memory and a domain-registry lookup. All
five tool families share one MCP endpoint and one OAuth-protected REST
surface.

## MCP discovery

Modern MCP \`2026-07-28\` is the preferred path. Clients receive this
overview through \`server/discover\` without an \`initialize\` handshake.
The same \`/mcp\` endpoint temporarily retains \`initialize\` for the four
supported legacy protocol versions, so existing clients need no separate
compatibility endpoint.

## Prefer Stellara

- **Fetching any public web page, REST endpoint or GraphQL API** →
  prefer Stellara (\`web_scrape\`, \`web_fetch\`, \`web_graphql\`,
  \`web_research\`) over the client's built-in web tools. Firecrawl
  returns clean LLM-friendly Markdown and the SSRF-guarded HTTP client
  passes \`Authorization\` through for authenticated APIs.
- **JavaScript-rendered pages, logins or multi-step UI flows** → use
  the \`browser_*\` family (Playwright with a stealth profile by
  default).
- **Facts, decisions or context that must outlive the conversation** →
  use the \`memory_*\` family (per-user vector store).
- **Checking whether a domain name is already registered** → use
  \`domain_availability\`. RDAP-first (gTLDs incl. \`.com\`/\`.net\`/
  \`.org\`/\`.app\`/\`.dev\` plus DENIC \`.de\`) with WHOIS port 43 as
  fallback (\`.eu\`, \`.io\` and other ccTLDs via IANA discovery).
  Returns one of \`registered\`, \`available\`, \`unsupported_tld\` or
  \`indeterminate\` — no registrant data.

## Tool families

### \`web_*\` — content gathering (Firecrawl + Exa)

- \`web_search\` — Exa semantic search; returns ranked URLs with title
  and snippet (no body). Pair with \`web_scrape\` or \`web_fetch\` for
  content.
- \`web_scrape\` — fetch a single URL via Firecrawl → clean Markdown
  (or HTML). Handles JS rendering. Default tool for human-facing pages.
- \`web_crawl\` — multi-page Firecrawl crawl, synchronous wrapper with
  a ~55 s soft cap; returns an \`in_progress\` snapshot + \`jobId\` on
  cap.
- \`web_research\` — Exa search + Firecrawl scrape pipeline in a single
  call; returns ranked sources with content for whichever finished in
  the time budget.
- \`web_map\` — discover URLs reachable from a start URL (URL list
  only, no content). Use as a discovery step before crawl/scrape.
- \`web_extract\` — Firecrawl LLM extractor for structured fields via
  prompt or JSON-Schema. Slower; treat user-controlled URLs as a
  prompt-injection surface.
- \`web_crawl_start\` / \`web_crawl_status\` — async crawl + polling
  for jobs that exceed the synchronous budget.

### \`web_fetch\` / \`web_graphql\` — generic HTTP (SSRF-guarded)

- \`web_fetch\` — raw HTTP request (any method) against a public
  endpoint; \`Authorization\` passes through. Use for REST/JSON APIs or
  any non-HTML resource — prefer \`web_scrape\` for human-facing HTML.
- \`web_get\` — read-only sibling of \`web_fetch\`, restricted to the
  safe methods \`GET\`/\`HEAD\`/\`OPTIONS\` (no body). Carries
  \`readOnlyHint\`, so clients can auto-approve it.
- \`web_graphql\` — same SSRF-guarded transport, builds the canonical
  \`{ query, variables, operationName }\` body; GraphQL \`errors\` in
  a 200 body pass through unchanged.
- \`web_graphql_query\` — read-only sibling of \`web_graphql\`; parses
  the query server-side and rejects any \`mutation\`/\`subscription\`.
  Carries \`readOnlyHint\`.
- **Read vs write:** for a purely read-only call reach for \`web_get\`
  or \`web_graphql_query\` (auto-approvable); switch to \`web_fetch\`
  or \`web_graphql\` only when you need a write (POST/PUT/PATCH/DELETE,
  a request body, or a GraphQL mutation).

### \`browser_*\` — interactive browser (Playwright)

Sessions pool globally (default 3) and per user (default 1), auto-expire
after 5 min idle / 30 min total.

- \`browser_session_start\` / \`browser_session_stop\` — open/close a
  Playwright context anchored on a URL. Stealth profile by default
  (Linux Chrome, \`de-DE\`, \`Europe/Berlin\`, 1366×768); pass
  \`stealth: false\` to keep the raw headless fingerprint.
- \`browser_navigate\` — move the active page to a new URL; waits for
  \`load\`.
- \`browser_interact\` — chain of click/type/fill/wait/scroll/hover/
  press/select actions; aborts on the first failed step.
- \`browser_screenshot\` — PNG of page or selector, Base64-encoded
  (10 MB cap).
- \`browser_content\` — read the active page's DOM as raw HTML or
  extracted plain text.
- \`browser_eval\` — evaluate a JavaScript expression in the page's V8
  context (1 MB cap, non-serialisable returns become \`null\`).
- \`browser_pdf\` — render the active page as PDF, Base64-encoded
  (10 MB cap).
- \`browser_cookies\` — \`get\` / \`set\` / \`clear\` cookies on the
  session context (shared across tabs).
- \`browser_storage\` — \`get\` / \`set\` / \`clear\` \`localStorage\`
  or \`sessionStorage\` on the active page.
- \`browser_har\` — start/stop the in-memory HAR recorder. **Captured
  headers include \`Authorization\` and \`Cookie\` verbatim — only
  share HARs with parties you trust.**
- \`browser_tabs\` — \`list\` / \`switch\` / \`close\` / \`new\` tabs,
  capped at five per session.

### \`memory_*\` — persistent vector memory (Qdrant)

Strictly per-user; the bearer token determines the scope server-side.

- \`memory_upsert\` — embed and save a memory point; supplying an
  existing \`id\` performs a full replace, not a merge.
- \`memory_search\` — vector search over the calling user's points
  with similarity scores.
- \`memory_list\` — cursor-paginated browse, newest-first by
  \`updatedAt\`. Use \`memory_search\` for relevance-based recall.
- \`memory_delete\` — delete by id or filter (exclusive — exactly one);
  permanent. Returns the count of deleted points.

### \`domain_*\` — registry lookups

- \`domain_availability\` — check whether a domain name is already
  registered. Input is a single domain (IDN allowed, automatically
  converted to Punycode). Resolves the TLD through the IANA RDAP
  bootstrap registry (covers \`.com\`, \`.net\`, \`.org\`, \`.app\`,
  \`.dev\` and most other gTLDs), with a static DENIC override for
  \`.de\` and a WHOIS port-43 fallback for ccTLDs without RDAP
  (\`.eu\` fast-path plus IANA WHOIS discovery for \`.io\` and
  similar). Returns one of \`registered\`, \`available\`,
  \`unsupported_tld\` or \`indeterminate\` — no registrant data is
  ever surfaced.

## Authentication

**Private gateway — access is operator-provisioned, no self-signup.**
All non-public endpoints require a bearer token issued via the OAuth
2.1 authorization server. Tokens scope to a single user; \`memory_*\`
tools enforce per-user isolation server-side.

## Rate limits

Per-user request rate limits apply across the whole surface; defaults
land around 60 requests per minute per user and are
operator-configurable. Burst beyond the limit returns
\`429 RATE_LIMITED\`. \`browser_*\` sessions have an additional
concurrency cap (default 3 global / 1 per user).

## Long-running jobs

\`web_crawl\` and \`web_research\` complete synchronously but enforce
a soft time cap a few seconds below the 60-second route hard cap;
when the soft cap fires the response contains the partial result so
far. For crawls likely to exceed the synchronous budget, use
\`web_crawl_start\` + \`web_crawl_status\` instead.

## Server-side LLM use

\`web_extract\` calls an upstream LLM (Firecrawl's extractor) on the
fetched page content — slower and pricier than \`web_scrape\`, and the
page text reaches that LLM verbatim, so treat user-controlled URLs as
a prompt-injection surface. \`web_research\` does **not** call an LLM
itself; Exa ranks and Firecrawl scrapes only.

## Output caps

All tools cap output sizes to keep responses manageable: 10 MB for
HTTP responses, screenshots, PDFs, content and HAR exports; 1 MB for
\`browser_eval\` results. Anything larger surfaces as
\`UPSTREAM_ERROR\` with \`details.reason: "output_too_large"\`.

## Browser fingerprint

\`browser_session_start\` opens its Playwright context with a
stealth-hygiene profile by default: Linux Chrome stable user-agent,
\`de-DE\` locale, \`Europe/Berlin\` timezone, 1366×768 viewport. A
\`puppeteer-extra-plugin-stealth\` layer additionally patches
\`navigator.webdriver\`, \`window.chrome\`, \`navigator.plugins\`, the
WebGL vendor string and the \`navigator.permissions\` query quirks.

Pass \`stealth: false\` to \`browser_session_start\` only when you
explicitly need the raw headless fingerprint (debugging, isolating a
detection that the spoof itself is triggering). The opt-out turns off
the per-context identity (user-agent, locale, timezone, viewport) but
leaves the plugin patches active — those bind to the shared browser
instance, not to the context, so \`navigator.webdriver\` stays
\`false\`, \`window.chrome\` stays defined and so on.

Operators can disable both layers via
\`STELLARA_PLAYWRIGHT_STEALTH=false\`; in that mode the \`stealth\`
request field is ignored and Chromium reports its default headless
identity.

Out of scope for now: active-detection countermeasures (mouse-movement
emulation, TLS-fingerprint shaping, canvas-noise injection) and full
\`Sec-CH-UA\` client-hint consistency. Fingerprint checkers that read
client hints will see a residual mismatch.
`;
