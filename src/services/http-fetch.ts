import type { FetchResponse } from "../schemas/web.js";

/**
 * Shared HTTP-fetch service backing `web_fetch` and `web_graphql`
 * (concept §8.17/§8.18, plan 0006).
 *
 * One Service-Layer helper covers SSRF-guarding, header sanitization, body
 * encoding, redirect-hop validation, response decoding and the 10 MB body
 * cap. Both tools delegate here so the security-sensitive bits live in a
 * single place. The helper uses Node 24's global `fetch` (undici) and adds
 * no new runtime dependency.
 */
import { AppError, ErrorCode, mapUpstreamError } from "../errors.js";
import { safeExternalUrl } from "../schemas/common.js";
import {
  decodeResponseBody,
  encodeRequestBody,
  type HttpFetchBody,
  readBodyWithCap,
} from "./http-fetch-body.js";

export type { HttpFetchBody } from "./http-fetch-body.js";

/**
 * Lowercased hop-by-hop and otherwise-disallowed request headers. The
 * gateway strips these before forwarding to the upstream:
 *
 * - `host`, `connection`, `transfer-encoding`, `content-length`,
 *   `keep-alive`, `te`, `upgrade` are hop-by-hop headers (RFC 7230 §6.1) —
 *   passing them through would either confuse undici or leak the gateway's
 *   own pool to the caller.
 * - `cookie` is dropped because Stellara is not a cookie-jar; tokens
 *   intended for the upstream should travel via `Authorization`.
 *
 * `Authorization` is explicitly *not* in this set — it is the primary use
 * case for the fetch tool.
 */
const BLOCKED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
  "keep-alive",
  "te",
  "upgrade",
  "cookie",
]);

/**
 * Response headers that survive the sanitization pass. Stellara intentionally
 * forwards only this minimal, well-understood subset — `Set-Cookie` and any
 * other auth/tracking-flavored header never reach the caller.
 */
const ALLOWED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "location",
  "retry-after",
]);

/**
 * HTTP status codes that require redirect-following under the manual flow.
 * 307/308 preserve the original method; 301/302/303 rewrite to GET (see
 * `REDIRECT_METHOD_REWRITES`).
 */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Method rewrite table for status codes that mandate a GET-downgrade per
 * RFC 7231 §6.4. 307 and 308 are intentionally absent — they preserve the
 * original method and body unchanged.
 */
const REDIRECT_METHOD_REWRITES: ReadonlyMap<number, "GET"> = new Map([
  [301, "GET"],
  [302, "GET"],
  [303, "GET"],
]);

/** Header inspected to detect the body's auto-format on a successful response. */
const CONTENT_TYPE_HEADER = "content-type";

/** Inputs accepted by {@link runHttpFetch}. */
export type RunHttpFetchArgs = {
  /** Initial URL (already passed through `safeExternalUrl` at the schema layer). */
  url: string;
  /** HTTP method. The schema layer rejects body-less methods carrying a body. */
  method: string;
  /** Caller-supplied request headers (pre-sanitization). */
  headers?: Record<string, string>;
  /** Discriminated body bag matching the request schema's union. */
  body?: HttpFetchBody;
  /** How the caller wants the response decoded (auto/json/text/binary). */
  responseFormat: "auto" | "binary" | "json" | "text";
  /** Whether to follow 3xx redirects (per-hop SSRF-checked). */
  followRedirects: boolean;
  /** Hard cap on redirect hops (≤ 10 enforced by the schema). */
  maxRedirects: number;
  /** Abort signal threaded in by the route-level `withTimeout` wrapper. */
  signal: AbortSignal;
};

/** Result shape returned by {@link runHttpFetch}. */
export type HttpFetchResult = FetchResponse;

/**
 * Executes a single HTTP request with Stellara's SSRF, header-sanitization
 * and body-cap policies. Both `runWebFetch` and `runWebGraphql` delegate to
 * this helper.
 *
 * Transport-level failures (DNS, TLS, connection-refused, abort) are
 * normalized via {@link mapUpstreamError}. Upstream 4xx/5xx responses are
 * returned 1:1 in the result so callers can react to the server's status —
 * the whole point of a generic fetch tool.
 */
export async function runHttpFetch(args: RunHttpFetchArgs): Promise<HttpFetchResult> {
  const sanitized = sanitizeRequestHeaders(args.headers);
  const initialRequest = buildInternalRequest(args, sanitized.headers);
  return performWithRedirects({
    args,
    initialUrl: args.url,
    initialRequest,
    droppedRequestHeaders: sanitized.dropped,
  });
}

/**
 * Strips hop-by-hop and otherwise-blocked headers from the caller-supplied bag.
 * The returned `dropped` list (sorted, lowercased) is forwarded in the result
 * as `droppedRequestHeaders` so callers can diagnose silent upstream behavior
 * changes without reading Stellara's server logs.
 */
function sanitizeRequestHeaders(headers: Record<string, string> | undefined): {
  headers: Record<string, string>;
  dropped: string[];
} {
  const kept: Record<string, string> = {};
  const droppedSet = new Set<string>();
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (BLOCKED_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-")) {
        droppedSet.add(lower);
        continue;
      }
      kept[key] = value;
    }
  }
  return { headers: kept, dropped: [...droppedSet].sort() };
}

/**
 * Internal stable representation of the request as we follow redirects.
 *
 * Keeping headers as a plain `Record<string, string>` (rather than the
 * `HeadersInit` union) means we can mutate the bag between hops without
 * fighting the `Headers` / array-of-tuples shapes that `fetch` would also
 * accept. The body union mirrors what {@link encodeRequestBody} can emit:
 * a JSON string, a form-encoded string, a `Uint8Array` (for base64 input)
 * or `undefined` (for body-less methods).
 */
type InternalRequest = {
  method: string;
  headers: Record<string, string>;
  body: InternalBody;
};

/** Body shapes the encoder can emit and that undici's `fetch` accepts. */
type InternalBody = string | Uint8Array | undefined;

/** Inputs threaded through {@link performWithRedirects}. */
type PerformWithRedirectsArgs = {
  args: RunHttpFetchArgs;
  initialUrl: string;
  initialRequest: InternalRequest;
  droppedRequestHeaders: string[];
};

/**
 * Issues the initial request and follows redirects manually, validating each
 * hop through `safeExternalUrl`. Returns the final response wrapped in the
 * Stellara result shape.
 */
async function performWithRedirects(input: PerformWithRedirectsArgs): Promise<HttpFetchResult> {
  let currentUrl = input.initialUrl;
  let currentRequest: InternalRequest = input.initialRequest;
  for (let hop = 0; hop <= input.args.maxRedirects; hop += 1) {
    const response = await dispatchRequest(currentUrl, currentRequest, input.args.signal);
    if (
      !input.args.followRedirects ||
      !REDIRECT_STATUS_CODES.has(response.status) ||
      hop === input.args.maxRedirects
    ) {
      return assembleResult({
        response,
        finalUrl: currentUrl,
        droppedRequestHeaders: input.droppedRequestHeaders,
        responseFormat: input.args.responseFormat,
        signal: input.args.signal,
      });
    }
    const next = resolveRedirect({ response, currentUrl, currentRequest });
    // Discard the previous response body — we are about to follow the
    // redirect and undici otherwise leaks the socket.
    await response.body?.cancel();
    currentUrl = next.url;
    currentRequest = next.request;
  }
  // The loop guarantees an early return; this branch is unreachable but
  // keeps the type system happy.
  throw new AppError({
    code: ErrorCode.UPSTREAM_ERROR,
    details: { service: "fetch", reason: "redirect_loop" },
  });
}

/** Wraps `fetch` with Stellara's upstream-error mapping. */
async function dispatchRequest(
  url: string,
  request: InternalRequest,
  signal: AbortSignal,
): Promise<Response> {
  // `redirect: "manual"` ensures undici never follows a 3xx on our behalf;
  // every hop has to clear `safeExternalUrl` first.
  try {
    return await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal,
    });
  } catch (error) {
    throw mapUpstreamError(error, { service: "fetch", signal });
  }
}

/** Inputs for {@link resolveRedirect}. */
type ResolveRedirectInput = {
  response: Response;
  currentUrl: string;
  currentRequest: InternalRequest;
};

/**
 * Computes the next URL and `InternalRequest` for a redirect hop. Throws an
 * `AppError` when the target violates {@link safeExternalUrl}: SSRF is a
 * security event, so we surface a clear `UPSTREAM_ERROR` (502) rather than
 * silently swallowing the redirect.
 */
function resolveRedirect(input: ResolveRedirectInput): {
  url: string;
  request: InternalRequest;
} {
  const nextUrl = resolveRedirectUrl(input.response, input.currentUrl);
  const methodRewrite = REDIRECT_METHOD_REWRITES.get(input.response.status);
  if (methodRewrite === undefined) {
    return { url: nextUrl, request: input.currentRequest };
  }
  // 301/302/303 force GET per RFC 7231; drop the body and its implicit
  // content-type so the next hop does not see a payload it ignores.
  const nextHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.currentRequest.headers)) {
    if (key.toLowerCase() !== "content-type") nextHeaders[key] = value;
  }
  return {
    url: nextUrl,
    request: { method: methodRewrite, headers: nextHeaders, body: undefined },
  };
}

/**
 * Reads the `Location` header off `response`, resolves it against `currentUrl`
 * and re-runs it through {@link safeExternalUrl}. Throws an `AppError` with a
 * structured `details.reason` for each failure mode so the caller can
 * distinguish a missing Location, a parse failure and an SSRF block.
 */
function resolveRedirectUrl(response: Response, currentUrl: string): string {
  const location = response.headers.get("location");
  if (location === null || location === "") {
    throw new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "fetch", reason: "redirect_without_location" },
    });
  }
  // `new URL(location, base)` throws `TypeError` for malformed inputs (e.g.
  // `http://[bad`, embedded NULs, control chars). Catch the parse error
  // explicitly so the caller sees a structured `redirect_invalid_location`
  // reason instead of a generic UPSTREAM_ERROR envelope.
  let nextUrl: string;
  try {
    nextUrl = new URL(location, currentUrl).toString();
  } catch {
    throw new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "fetch", reason: "redirect_invalid_location", location },
    });
  }
  const safeCheck = safeExternalUrl.safeParse(nextUrl);
  if (!safeCheck.success) {
    throw new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { service: "fetch", reason: "redirect_blocked", url: nextUrl },
    });
  }
  return nextUrl;
}

/** Inputs for {@link assembleResult}. */
type AssembleResultInput = {
  response: Response;
  finalUrl: string;
  droppedRequestHeaders: string[];
  responseFormat: RunHttpFetchArgs["responseFormat"];
  signal: AbortSignal;
};

/**
 * Reads, decodes and wraps the final upstream response into the Stellara
 * result shape. Performs the response-header filter pass here (not on every
 * hop) because only the terminal response is returned to the caller.
 *
 * `signal` is propagated into `readBodyWithCap` so the body-drain loop bails
 * out promptly when the route-level `withTimeout` fires mid-stream (R-0000066
 * defense-in-depth — undici cancels the stream too, but the service layer
 * should not depend on that behavior).
 */
async function assembleResult(input: AssembleResultInput): Promise<HttpFetchResult> {
  const headers = filterResponseHeaders(input.response.headers);
  const { bytes, truncated } = await readBodyWithCap(input.response, input.signal);
  const decoded = decodeResponseBody({
    bytes,
    truncated,
    requested: input.responseFormat,
    contentType: headers[CONTENT_TYPE_HEADER],
    status: input.response.status,
  });
  return {
    status: input.response.status,
    statusText: input.response.statusText,
    headers,
    format: decoded.format,
    body: decoded.body,
    url: input.finalUrl,
    truncated: decoded.truncated,
    droppedRequestHeaders: input.droppedRequestHeaders,
  };
}

/**
 * Returns only the allowlisted response headers, normalized to lowercase keys.
 * Everything outside `ALLOWED_RESPONSE_HEADERS` — including `Set-Cookie` and
 * any auth/tracking-flavored header — is silently dropped so Stellara cannot
 * act as an unintended cookie-jar or credential relay.
 */
function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (ALLOWED_RESPONSE_HEADERS.has(lower)) {
      out[lower] = value;
    }
  }
  return out;
}

/**
 * Encodes the caller's body and merges the resulting `Content-Type` default
 * into the (already-sanitized) header bag. The caller-supplied `Content-Type`
 * always wins — the default only fills the gap when the caller did not set one.
 */
function buildInternalRequest(
  args: RunHttpFetchArgs,
  headers: Record<string, string>,
): InternalRequest {
  const finalHeaders = { ...headers };
  let body: InternalBody;
  if (args.body !== undefined) {
    const encoded = encodeRequestBody(args.body);
    body = encoded.body;
    if (encoded.contentType !== undefined && !hasContentType(finalHeaders)) {
      finalHeaders["content-type"] = encoded.contentType;
    }
  }
  return {
    method: args.method,
    headers: finalHeaders,
    body,
  };
}

/**
 * Returns `true` if the header bag already carries a `Content-Type`. Case-
 * insensitive check because callers may send mixed-case header names before
 * the sanitization pass normalizes them.
 */
function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
}
