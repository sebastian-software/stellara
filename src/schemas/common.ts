/**
 * Shared Zod schemas used by the web and memory tool schemas.
 *
 * Extracted so the metadata bag has a single source of truth — both
 * `src/schemas/web.ts` and `src/schemas/memory.ts` import it from here.
 */
import { isIP } from "node:net";
import { z } from "zod/v4";

/** Free-form metadata bag — values are intentionally `unknown`. */
export const metadataSchema = z.record(z.string(), z.unknown());

/**
 * Hostnames that resolve to internal Stellara/Docker services. Any
 * user-supplied URL pointing at one of these is rejected by
 * {@link safeExternalUrl} so authenticated callers cannot pivot Firecrawl
 * scrapes onto our own infrastructure (SSRF).
 *
 * The list mirrors the service names from `docker-compose.yml` plus the
 * generic `localhost` alias. Kept as a hard-coded constant for v1; a future
 * env-driven override can extend this without changing the refinement shape.
 */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "qdrant",
  "firecrawl",
  "stellara",
  "embeddings",
]);

/** TLD suffixes that historically denote internal/private networks. */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [".internal", ".local"];

/** Allowed URL schemes — Firecrawl only speaks HTTP(S). */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Non-routable / private IPv4 CIDR blocks. Each entry is `[network, prefix]`
 * where `network` is the canonical base IPv4 expressed as a 32-bit unsigned
 * integer and `prefix` is the network-prefix length.
 *
 * Covers:
 * - `0.0.0.0/8` (this-network)
 * - `10.0.0.0/8` (RFC1918)
 * - `100.64.0.0/10` (CGNAT)
 * - `127.0.0.0/8` (loopback)
 * - `169.254.0.0/16` (link-local, incl. AWS metadata `169.254.169.254`)
 * - `172.16.0.0/12` (RFC1918)
 * - `192.0.0.0/24`, `192.0.2.0/24` (IETF protocol + TEST-NET-1)
 * - `192.168.0.0/16` (RFC1918)
 * - `198.18.0.0/15` (benchmark), `198.51.100.0/24` (TEST-NET-2)
 * - `203.0.113.0/24` (TEST-NET-3)
 * - `224.0.0.0/4` (multicast)
 * - `240.0.0.0/4` (reserved)
 */
const PRIVATE_IPV4_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [octetsToInt([0, 0, 0, 0]), 8],
  [octetsToInt([10, 0, 0, 0]), 8],
  [octetsToInt([100, 64, 0, 0]), 10],
  [octetsToInt([127, 0, 0, 0]), 8],
  [octetsToInt([169, 254, 0, 0]), 16],
  [octetsToInt([172, 16, 0, 0]), 12],
  [octetsToInt([192, 0, 0, 0]), 24],
  [octetsToInt([192, 0, 2, 0]), 24],
  [octetsToInt([192, 168, 0, 0]), 16],
  [octetsToInt([198, 18, 0, 0]), 15],
  [octetsToInt([198, 51, 100, 0]), 24],
  [octetsToInt([203, 0, 113, 0]), 24],
  [octetsToInt([224, 0, 0, 0]), 4],
  [octetsToInt([240, 0, 0, 0]), 4],
];

/** Packs four octets into a 32-bit unsigned integer. */
function octetsToInt(octets: readonly [number, number, number, number]): number {
  const [a, b, c, d] = octets;
  // `>>> 0` reinterprets the signed shift result as unsigned so the value
  // always lies in `[0, 2^32)`.
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Parses a single decimal octet (`"0".."255"`) without leading zeros. */
function parseOctet(part: string): number | undefined {
  const value = Number.parseInt(part, 10);
  if (!Number.isInteger(value) || value < 0 || value > 255) return undefined;
  // Reject leading zeros / spaces / non-canonical inputs ("01", " 1", "+1")
  // so attackers cannot smuggle ambiguous IPv4 literals past the guard.
  if (String(value) !== part) return undefined;
  return value;
}

/** Parses a dotted-quad IPv4 string into its 32-bit unsigned representation. */
function parseIpv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    const value = parseOctet(part);
    if (value === undefined) return undefined;
    octets.push(value);
  }
  // The `parts.length !== 4` guard plus the loop above ensure exactly four
  // octets — destructure into the fixed-arity tuple `octetsToInt` expects.
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return undefined;
  }
  return octetsToInt([a, b, c, d]);
}

/** Returns `true` if `host` is a literal IPv4 in any blocked CIDR. */
function isPrivateIpv4(host: string): boolean {
  const value = parseIpv4(host);
  if (value === undefined) return false;
  return PRIVATE_IPV4_BLOCKS.some(([network, prefix]) => {
    // `prefix === 0` would shift by 32 (a no-op in JS); none of our blocks use
    // it, but guard anyway so the helper stays composable.
    const mask = prefix === 0 ? 0 : (0xff_ff_ff_ff << (32 - prefix)) >>> 0;
    return (value & mask) === (network & mask);
  });
}

/**
 * IPv6 prefixes (canonical lower-case, no leading zeros) that fall into
 * ranges we never want Firecrawl to dial:
 *
 * - `::1` (loopback) and `::` (unspecified) — exact matches only
 * - `fe80::/10` (link-local) — first hextet in `fe80..febf`
 * - `fc00::/7` (unique-local, ULA) — first hextet starts with `fc` / `fd`
 * - `ff00::/8` (multicast) — first hextet starts with `ff`
 */
const BLOCKED_IPV6_FIRST_HEXTET_PREFIXES: readonly string[] = [
  "fe8",
  "fe9",
  "fea",
  "feb",
  "fc",
  "fd",
  "ff",
];

/** Textual IPv4-mapped IPv6 prefix (`::ffff:a.b.c.d`). */
const IPV4_MAPPED_TEXTUAL_PREFIX = "::ffff:";

/** Hex-compressed IPv4-mapped IPv6: `::ffff:HHHH:HHHH`. */
const IPV4_MAPPED_HEX_PATTERN = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/;

/** Decodes the two-hextet tail of a hex-compressed IPv4-mapped IPv6. */
function hexTailToDotted(high: number, low: number): string | undefined {
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  if (high < 0 || high > 0xff_ff || low < 0 || low > 0xff_ff) return undefined;
  const a = (high >> 8) & 0xff;
  const b = high & 0xff;
  const c = (low >> 8) & 0xff;
  const d = low & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Extracts and re-checks an embedded IPv4 from IPv4-mapped IPv6 forms.
 *
 * Node's URL parser normalizes `::ffff:192.168.0.1` to `::ffff:c0a8:1` —
 * accept both shapes. Returns `true` when the embedded IPv4 falls in a
 * blocked range; otherwise `false`.
 */
function isMappedPrivateIpv4(lower: string): boolean {
  if (lower.startsWith(IPV4_MAPPED_TEXTUAL_PREFIX)) {
    const embedded = lower.slice(IPV4_MAPPED_TEXTUAL_PREFIX.length);
    if (isIP(embedded) === 4 && isPrivateIpv4(embedded)) return true;
  }
  const hexMatch = IPV4_MAPPED_HEX_PATTERN.exec(lower);
  if (hexMatch === null) return false;
  const dotted = hexTailToDotted(
    Number.parseInt(hexMatch[1] ?? "", 16),
    Number.parseInt(hexMatch[2] ?? "", 16),
  );
  return dotted !== undefined && isPrivateIpv4(dotted);
}

/** Returns the canonical first hextet (no leading zeros) of an IPv6 string. */
function firstHextet(lower: string): string {
  // Empty first hextet means the address starts with `::` (e.g. `::1`); the
  // first non-empty group lives further down — but for our prefix checks
  // those addresses are already handled by exact-match (`::`, `::1`) or by
  // {@link isMappedPrivateIpv4}, so an empty string here is fine.
  const head = lower.split(":")[0] ?? "";
  return head.replace(/^0+/, "") || head;
}

/** Returns `true` if `host` is a literal IPv6 in any blocked range. */
function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (isMappedPrivateIpv4(lower)) return true;
  const head = firstHextet(lower);
  return BLOCKED_IPV6_FIRST_HEXTET_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** Returns `true` if `host` is a literal IP in any blocked range. */
function isPrivateIp(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

/** Returns `true` if `host` matches a blocked literal hostname / suffix. */
function isBlockedHostname(host: string): boolean {
  if (host === "") return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Zod refinement for user-supplied URLs that will be dialed by Firecrawl.
 *
 * Rejects:
 * - non-http(s) schemes (e.g. `file://`, `gopher://`, `ftp://`)
 * - internal Docker service names (`qdrant`, `firecrawl`, …) and `localhost`
 * - `.internal` / `.local` suffixes
 * - literal IPs in private / loopback / link-local / CGNAT / multicast ranges
 *   (RFC1918, `127.0.0.0/8`, `169.254.0.0/16`, `fc00::/7`, …)
 *
 * NOTE — TOCTOU: a public hostname can still resolve to a private address at
 * scrape time (`https://attacker.example/` → `127.0.0.1`). This refinement is
 * the first layer of defense; Firecrawl's own SSRF guard (configured via
 * `BLOCKED_URLS` in `docker-compose.yml`) is the second.
 */
export const safeExternalUrl = z
  .url()
  .describe(
    "Public HTTPS or HTTP URL. Loopback, RFC1918, CGNAT, link-local, multicast and internal Docker hostnames are rejected before the connect (concept §17.1). `user:password@host` authorities are also rejected.",
  )
  .refine((value) => {
    // `z.url()` accepts URL-shaped strings but `new URL` can still throw on
    // edge cases (whitespace, malformed authority, ...). Treat any parse
    // failure as a hard reject.
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return false;
    // Reject embedded `user[:password]@host` authorities. Userinfo would never
    // affect SSRF directly, but `https://trusted.example@attacker.example/`
    // is a classic phishing/spoofing primitive — and undici/curl quirks have
    // historically led to inconsistent host resolution when userinfo is
    // present. Block it at the schema layer so neither layer of the stack
    // has to second-guess the authority.
    if (url.username !== "" || url.password !== "") return false;
    // `URL.hostname` keeps the surrounding brackets on IPv6 literals
    // (`http://[::1]/` → `"[::1]"`). Strip them so `node:net.isIP` and the
    // IPv6 helpers below see the canonical address text.
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
    if (isBlockedHostname(host)) return false;
    if (isIP(host) !== 0 && isPrivateIp(host)) return false;
    return true;
  }, "URL must be a public http(s) endpoint without userinfo (user:pw@host); localhost, internal services, RFC1918, loopback, link-local and other private targets are rejected");
