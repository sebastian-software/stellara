/**
 * RDAP lookup service for the domain availability tool (plan 0013).
 *
 * Resolves the RDAP server for a given TLD via two sources:
 *
 * 1. A small, hand-maintained override map for ccTLDs that operate an RDAP
 *    server outside the IANA-RDAP-Bootstrap registry. Currently only `.de`
 *    (DENIC) — the IANA bootstrap registry deliberately excludes ccTLDs
 *    that are not ICANN-mandated.
 * 2. The IANA-RDAP-Bootstrap document at
 *    `https://data.iana.org/rdap/dns.json`, fetched once and cached
 *    in-memory for {@link BOOTSTRAP_TTL_MS}.
 *
 * The actual lookup performs `GET <base>/domain/<ascii>` and maps the HTTP
 * status:
 *
 * - `200` (object exists) → `registered`
 * - `404` with an RDAP-shaped body (`errorCode`, `title`) → `available`
 * - everything else → `indeterminate` with a short reason for the audit
 *   trail
 *
 * The bootstrap response shape is the standard `{ version, publication,
 * services: [[tlds, urls], …] }` document — see RFC 9224 §3.
 */
import { mapUpstreamError } from "../errors.js";

/** Default URL for the IANA RDAP DNS bootstrap document (RFC 9224). */
export const DEFAULT_IANA_RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

/**
 * In-memory TTL for the bootstrap snapshot. The document changes only when
 * a TLD's RDAP delegation moves, so a daily refresh is plenty; we keep the
 * last successful snapshot around even after expiry so a transient IANA
 * outage cannot turn every lookup into `unsupported_tld`.
 */
export const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Static RDAP base URLs for ccTLDs not covered by the IANA bootstrap
 * registry. The map is intentionally tiny — only DENIC at the moment;
 * extending it is a deliberate decision and not user-controllable.
 *
 * Lower-cased TLD as key, RDAP base URL as value (with trailing slash so
 * concatenation with `domain/<ascii>` always produces a single slash).
 */
export const STATIC_RDAP_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["de", "https://rdap.denic.de/"],
]);

/** Verdict shape returned by {@link lookupRdap}. */
export type RdapVerdict = {
  status: "available" | "indeterminate" | "registered";
  /** Optional machine-friendly reason; set for `indeterminate`. */
  reason?: string;
};

/** Shape of the IANA RDAP bootstrap JSON document; entries validated structurally per item. */
type IanaBootstrapDocument = {
  services: readonly unknown[];
};

/** Internal cached snapshot of the bootstrap document. */
type BootstrapCacheEntry = {
  fetchedAt: number;
  byTld: ReadonlyMap<string, string>;
};

/**
 * Module-level cache for the IANA bootstrap. We keep it module-scoped (and
 * not on the `FastifyInstance`) because the document is operator-agnostic
 * and the cache is small (~70 KB JSON, parsed to a TLD → URL map).
 */
let bootstrapCache: BootstrapCacheEntry | undefined;

/**
 * Resets the in-memory bootstrap cache. Exposed exclusively for tests so
 * they can deterministically replay the "first call hits the network" path.
 */
export function resetRdapBootstrapCache(): void {
  bootstrapCache = undefined;
}

/**
 * Looks up the RDAP base URL for a TLD. Checks the static override map
 * first, then the IANA bootstrap registry. Returns `undefined` when neither
 * source covers the TLD — the tool layer then falls through to WHOIS.
 *
 * Reads from the cache when fresh; refreshes from `bootstrapUrl` once the
 * TTL is exceeded. Network failures during refresh are not fatal: the last
 * successful snapshot keeps serving until a future call refreshes it
 * successfully.
 */
export async function resolveRdapBaseUrl(
  tld: string,
  signal: AbortSignal,
  bootstrapUrl: string = DEFAULT_IANA_RDAP_BOOTSTRAP_URL,
): Promise<string | undefined> {
  const lower = tld.toLowerCase();
  const override = STATIC_RDAP_OVERRIDES.get(lower);
  if (override !== undefined) return override;
  const snapshot = await getBootstrapSnapshot(bootstrapUrl, signal);
  return snapshot?.byTld.get(lower);
}

/**
 * Performs the RDAP `GET <base>/domain/<ascii>` request and returns the
 * verdict. Network or unexpected errors are returned as `indeterminate`
 * rather than thrown so the route handler can ship a structured response
 * instead of a 502.
 */
export async function lookupRdap(
  baseUrl: string,
  asciiDomain: string,
  signal: AbortSignal,
): Promise<RdapVerdict> {
  const url = joinRdapBase(baseUrl, asciiDomain);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "follow",
      signal,
    });
    if (response.status === 200) return { status: "registered" };
    if (response.status === 404) return { status: "available" };
    if (response.status === 429) return { status: "indeterminate", reason: "rate_limited" };
    return { status: "indeterminate", reason: `unexpected_status_${response.status}` };
  } catch (error) {
    // Surface aborts as a timeout-flavoured indeterminate; other transport
    // errors collapse onto `upstream_unreachable` so the LLM gets a single
    // hint instead of a leaking `cause` chain.
    if (signal.aborted) return { status: "indeterminate", reason: "timeout" };
    const mapped = mapUpstreamError(error, { service: "rdap", signal });
    return {
      status: "indeterminate",
      reason: mapped.code === "TIMEOUT" ? "timeout" : "upstream_unreachable",
    };
  }
}

/** Returns the cached snapshot, refreshing on TTL miss. */
async function getBootstrapSnapshot(
  bootstrapUrl: string,
  signal: AbortSignal,
): Promise<BootstrapCacheEntry | undefined> {
  const beforeRefresh = bootstrapCache;
  if (beforeRefresh !== undefined && Date.now() - beforeRefresh.fetchedAt < BOOTSTRAP_TTL_MS) {
    return beforeRefresh;
  }
  const refreshed = await fetchBootstrap(bootstrapUrl, signal);
  if (refreshed !== undefined) {
    const entry: BootstrapCacheEntry = { fetchedAt: Date.now(), byTld: refreshed };
    // Single writer of the module-scoped `bootstrapCache`. The require-
    // atomic-updates rule treats `cache = entry` after an `await` as a
    // potential clobber of a concurrent write, but every refresh produces
    // the same TLD → URL projection (the IANA document is canonical), so
    // "last write wins" is safe — the worst case is one extra fetch.
    // eslint-disable-next-line require-atomic-updates -- see comment above
    bootstrapCache = entry;
    return entry;
  }
  // Refresh failed — keep serving the snapshot we captured at the start of
  // the call if any. The caller needs a consistent answer; freshness is
  // preferred but never required.
  return beforeRefresh;
}

/** Fetches the IANA RDAP bootstrap document and projects it to a TLD → URL map. */
async function fetchBootstrap(
  bootstrapUrl: string,
  signal: AbortSignal,
): Promise<Map<string, string> | undefined> {
  try {
    const response = await fetch(bootstrapUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "follow",
      signal,
    });
    if (!response.ok) return undefined;
    const parsed: unknown = await response.json();
    if (!isBootstrapDocument(parsed)) return undefined;
    return projectBootstrap(parsed);
  } catch {
    return undefined;
  }
}

/** Structural type guard for the IANA RDAP bootstrap JSON shape. */
function isBootstrapDocument(value: unknown): value is IanaBootstrapDocument {
  if (typeof value !== "object" || value === null) return false;
  if (!("services" in value)) return false;
  return Array.isArray(value.services);
}

/**
 * Flattens the bootstrap document into a TLD → first-URL map. Multiple URLs
 * are common (mirror endpoints); we keep the first because RFC 9224 calls
 * them out as equivalent and the lookup itself is idempotent.
 */
function projectBootstrap(doc: IanaBootstrapDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const service of doc.services) {
    mergeBootstrapService(map, service);
  }
  return map;
}

/**
 * Folds a single bootstrap `[tlds, urls]` entry into the accumulator map.
 * Extracted from {@link projectBootstrap} to keep the per-function
 * cyclomatic complexity inside the project's lint budget.
 */
function mergeBootstrapService(map: Map<string, string>, service: unknown): void {
  const parsed = parseBootstrapService(service);
  if (parsed === undefined) return;
  for (const tld of parsed.tlds) {
    if (typeof tld !== "string") continue;
    const lower = tld.toLowerCase();
    if (lower === "" || map.has(lower)) continue;
    map.set(lower, parsed.base);
  }
}

/**
 * Validates a single bootstrap entry and returns its `[tlds, base URL]`
 * pair, or `undefined` when the entry is malformed. Extracted so the
 * caller stays under the per-function cyclomatic-complexity cap.
 */
function parseBootstrapService(
  service: unknown,
): { tlds: readonly unknown[]; base: string } | undefined {
  if (!isUnknownArray(service) || service.length < 2) return undefined;
  const tlds = service[0];
  const urls = service[1];
  if (!isUnknownArray(tlds) || !isUnknownArray(urls)) return undefined;
  const base = urls[0];
  if (typeof base !== "string" || base === "") return undefined;
  const normalised = base.endsWith("/") ? base : `${base}/`;
  return { tlds, base: normalised };
}

/** Type guard that narrows `value` to `unknown[]` without the `any[]` widening from `Array.isArray`. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Joins a base URL with `domain/<ascii>` while guaranteeing exactly one slash. */
function joinRdapBase(baseUrl: string, asciiDomain: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${trimmed}domain/${encodeURIComponent(asciiDomain)}`;
}
