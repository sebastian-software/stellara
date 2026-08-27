/**
 * WHOIS lookup service for the domain availability tool (plan 0013).
 *
 * Provides three concerns in one module:
 *
 * 1. A small static TLD → WHOIS-server fast-path map (currently `.eu`).
 * 2. IANA-WHOIS-Discovery: when a TLD is not in the fast-path map, query
 *    `whois.iana.org:43` for the TLD and parse the `whois:` field from the
 *    canonical response. Result is cached in-memory with a long TTL
 *    (delegations are very stable) and a negative-cache for TLDs without a
 *    `whois:` field.
 * 3. A plain-TCP/43 client that issues the actual `<domain>\r\n` query and
 *    classifies the response as `available`, `registered` or
 *    `indeterminate` via a registry-agnostic pattern list.
 *
 * All discovered hostnames are validated against a strict DNS-label regex
 * before they are dialled; user input never determines the WHOIS host —
 * the user-controlled value is the domain itself, which is shipped as the
 * query payload only.
 */
import { createConnection } from "node:net";

/** Default WHOIS server used for TLD discovery. */
export const IANA_WHOIS_HOST = "whois.iana.org";

/** WHOIS protocol port (RFC 3912). */
export const WHOIS_PORT = 43;

/**
 * Cache TTL for successful TLD → WHOIS-server entries (7 days). TLD
 * delegations rarely change; long TTL keeps the lookup snappy without
 * preventing operators from picking up changes within a week of a redeploy.
 */
export const WHOIS_DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Negative-cache TTL (1 day). TLDs without a published WHOIS server (some
 * new gTLDs, registries with RDAP-only policy) get a shorter TTL so an
 * eventual upstream fix becomes visible within a day rather than a week.
 */
export const WHOIS_DISCOVERY_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on the bytes we read from a WHOIS server before forcibly closing the
 * socket. Real responses are a few kilobytes at most; this guard prevents a
 * misbehaving upstream from filling the event-loop memory.
 */
export const WHOIS_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Static TLD → WHOIS-server map. Fast-path for TLDs we know don't have an
 * RDAP endpoint; everything else flows through IANA discovery. Keys are
 * lower-cased TLDs.
 */
export const STATIC_WHOIS_SERVERS: ReadonlyMap<string, string> = new Map([["eu", "whois.eu"]]);

/**
 * Patterns that indicate a domain is NOT registered, applied to the
 * lowercased response body. The list is deliberately registry-agnostic;
 * per-registry overrides are added only when the generic list mis-classifies
 * a real response.
 */
const AVAILABLE_PATTERNS: readonly string[] = [
  "status: available",
  "status: free",
  "status:available",
  "status:free",
  "no match for",
  "not found",
  "no entries found",
  "domain not found",
  "no object found",
  "available for purchase",
  "no data found",
];

/**
 * Patterns that hint at a registered domain when no `available` marker
 * matched. Lowercased response body is scanned for these in order.
 */
const REGISTERED_HINTS: readonly string[] = [
  "domain:",
  "domain name:",
  "name servers:",
  "name server:",
  "nserver:",
  "registrar:",
  "registrant:",
  "creation date:",
  "registered:",
];

/** Allowed character class per DNS label: lowercase ASCII letters, digits, hyphen. */
const DNS_LABEL_CHAR_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validates a single DNS label (RFC 1035 §2.3.1): 1–63 characters,
 * lower-case ASCII alphanumerics or hyphen, never starting or ending with
 * a hyphen. Done as a small predicate rather than a `\d{0,61}`-style
 * regex so the linter's `security/detect-unsafe-regex` rule cannot mark
 * a backtracking risk.
 */
function isValidHostnameLabel(label: string): boolean {
  if (label.length === 0 || label.length > 63) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return DNS_LABEL_CHAR_PATTERN.test(label);
}

/**
 * Validates a full hostname (`a.b.c`): at least one dot present, every
 * label conforms to {@link isValidHostnameLabel}. Used to gate discovered
 * WHOIS hosts before we dial them.
 */
function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) => isValidHostnameLabel(label));
}

/** Verdict shape returned by {@link lookupWhois}. */
export type WhoisVerdict = {
  status: "available" | "indeterminate" | "registered";
  /** Optional machine-friendly reason; set for `indeterminate`. */
  reason?: string;
};

/** Cache entry for the WHOIS-server discovery. */
type DiscoveryCacheEntry = {
  cachedAt: number;
  /** WHOIS host name, or `undefined` for a negative-cache entry. */
  host: string | undefined;
};

/**
 * Module-level cache for IANA-discovery results. Module-scoped because the
 * mapping is operator-independent and the entry count is small (one per
 * looked-up TLD).
 */
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * Resets the in-memory discovery cache. Exposed exclusively for tests so
 * they can deterministically replay the "first call hits IANA" path.
 */
export function resetWhoisDiscoveryCache(): void {
  discoveryCache.clear();
}

/**
 * Returns the WHOIS server for a TLD. Static map first, then IANA
 * discovery. `undefined` means neither source has an answer — the caller
 * (the domain tool) treats that as `unsupported_tld`.
 */
export async function resolveWhoisServer(
  tld: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const lower = tld.toLowerCase();
  const fastPath = STATIC_WHOIS_SERVERS.get(lower);
  if (fastPath !== undefined) return fastPath;
  return discoverWhoisServer(lower, signal);
}

/**
 * Performs the WHOIS query for `domain` against `server` and classifies
 * the response. Network failures collapse to `indeterminate` with a
 * machine-friendly reason; aborts surface as `timeout`.
 */
export async function lookupWhois(
  server: string,
  domain: string,
  signal: AbortSignal,
): Promise<WhoisVerdict> {
  try {
    const body = await queryWhois(server, domain, signal);
    return classifyWhoisResponse(body);
  } catch (error) {
    if (signal.aborted) return { status: "indeterminate", reason: "timeout" };
    if (isAccessDenied(error)) return { status: "indeterminate", reason: "rate_limited" };
    return { status: "indeterminate", reason: "upstream_unreachable" };
  }
}

/**
 * Classifies a WHOIS response body. Exposed because the integration tests
 * for {@link lookupWhois} feed it raw fixture text and need to assert the
 * verdict mapping in isolation from the TCP path.
 */
export function classifyWhoisResponse(body: string): WhoisVerdict {
  const lower = body.toLowerCase();
  for (const pattern of AVAILABLE_PATTERNS) {
    if (lower.includes(pattern)) return { status: "available" };
  }
  if (isAccessDeniedBody(lower)) {
    return { status: "indeterminate", reason: "rate_limited" };
  }
  for (const hint of REGISTERED_HINTS) {
    if (lower.includes(hint)) return { status: "registered" };
  }
  return { status: "indeterminate", reason: "unrecognised_response" };
}

/** Issues `whois.iana.org` discovery for `tld` and caches the result. */
async function discoverWhoisServer(tld: string, signal: AbortSignal): Promise<string | undefined> {
  const cached = discoveryCache.get(tld);
  if (cached !== undefined && !isDiscoveryEntryExpired(cached)) {
    return cached.host;
  }
  try {
    const body = await queryWhois(IANA_WHOIS_HOST, tld, signal);
    const host = parseIanaWhoisField(body);
    discoveryCache.set(tld, { cachedAt: Date.now(), host });
    return host;
  } catch {
    // Don't cache failures — the next call should retry. Returning
    // undefined surfaces as `unsupported_tld` for this attempt, but the
    // domain tool maps an active discovery failure separately.
    return undefined;
  }
}

/** True if a cache entry has exceeded its (positive or negative) TTL. */
function isDiscoveryEntryExpired(entry: DiscoveryCacheEntry): boolean {
  const ttl = entry.host === undefined ? WHOIS_DISCOVERY_NEGATIVE_TTL_MS : WHOIS_DISCOVERY_TTL_MS;
  return Date.now() - entry.cachedAt >= ttl;
}

/**
 * Extracts the `whois:` field from a `whois.iana.org` response. Returns
 * `undefined` when the field is missing or its value fails the strict
 * hostname check.
 */
export function parseIanaWhoisField(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("whois:")) continue;
    const value = line.slice("whois:".length).trim().toLowerCase();
    if (value === "") return undefined;
    return isValidHostname(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Establishes a plain TCP/43 connection and returns the full response body.
 * The Promise constructor is wrapped in an async function so the lint rule
 * `@typescript-eslint/promise-function-async` is satisfied while we still
 * use the explicit-promise idiom that socket-event APIs require.
 */
async function queryWhois(host: string, query: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    const socket = createConnection({ host, port: WHOIS_PORT });
    socket.setKeepAlive(false);
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      socket.destroy();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${query}\r\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > WHOIS_MAX_RESPONSE_BYTES) {
        cleanup();
        socket.destroy();
        reject(new Error("WHOIS response exceeded byte cap"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function abortError(): Error {
  const error = new Error("WHOIS query aborted");
  error.name = "AbortError";
  return error;
}

/** Recognises operator-side rate-limit/access-denied responses on the body. */
function isAccessDeniedBody(lowercaseBody: string): boolean {
  return (
    lowercaseBody.includes("access denied") ||
    lowercaseBody.includes("quota exceeded") ||
    lowercaseBody.includes("rate limit") ||
    lowercaseBody.includes("too many requests")
  );
}

/** Heuristic for socket-level errors that hint at upstream rate limiting. */
function isAccessDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error)) return false;
  const code = error.code;
  return code === "ECONNRESET" || code === "EPIPE";
}
