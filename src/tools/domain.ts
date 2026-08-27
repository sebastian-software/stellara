import type { FastifyInstance } from "fastify";

/**
 * Orchestration for the `domain_availability` tool (plan 0013).
 *
 * Normalises the caller's input (IDN → Punycode, lower-case, no trailing
 * dot), extracts the TLD and walks a resolver chain that prefers RDAP over
 * WHOIS:
 *
 *   1. static ccTLD RDAP override map  (e.g. `.de` → DENIC)
 *   2. IANA RDAP bootstrap registry    (gTLDs incl. `.com`, `.app`, `.dev`)
 *   3. static TLD WHOIS map (fast path, e.g. `.eu`)
 *   4. IANA WHOIS discovery via `whois.iana.org` (catches `.io` and most
 *      other ccTLDs)
 *   5. `unsupported_tld`
 *
 * Every variant of the response carries the normalised ASCII domain and
 * the extracted TLD so the route handler can log it without re-parsing.
 */
import { domainToASCII } from "node:url";

import type { DomainAvailabilityRequest, DomainAvailabilityResponse } from "../schemas/domain.js";

import { AppError, ErrorCode } from "../errors.js";
import { lookupRdap, resolveRdapBaseUrl } from "../services/rdap.js";
import { lookupWhois, resolveWhoisServer } from "../services/whois.js";
import { PER_ROUTE_TIMEOUTS_MS, withTimeout } from "../timeouts.js";

/** Public alias mirroring the Zod-inferred response type. */
export type DomainAvailabilityResult = DomainAvailabilityResponse;

/**
 * Maximum number of labels accepted in the normalised domain. RFC 1035
 * theoretically allows 127, but anything past 10 is essentially never seen
 * in real registry data and rejecting the rest defends against silly
 * inputs without locking out legitimate cases (`a.b.c.example.co.uk` is
 * five labels, well under the cap).
 */
const MAX_DOMAIN_LABELS = 10;

/**
 * Executes the `domain_availability` tool. The `_app` parameter is unused
 * today — kept on the signature so the function matches the
 * `run<Tool>(app, input)` convention used by every other Stellara tool and
 * can be wired into the MCP adapter without a shape mismatch.
 */
export async function runDomainAvailability(
  _app: FastifyInstance,
  input: DomainAvailabilityRequest,
): Promise<DomainAvailabilityResult> {
  const normalised = normaliseDomain(input.domain);
  const tld = extractTld(normalised);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.domainAvailability, async (signal) => {
    const rdapBase = await resolveRdapBaseUrl(tld, signal);
    if (rdapBase !== undefined) {
      const verdict = await lookupRdap(rdapBase, normalised, signal);
      return finalise({ verdict, domain: normalised, tld, source: "rdap" });
    }
    const whoisServer = await resolveWhoisServer(tld, signal);
    if (whoisServer !== undefined) {
      const verdict = await lookupWhois(whoisServer, normalised, signal);
      return finalise({ verdict, domain: normalised, tld, source: "whois" });
    }
    return {
      status: "unsupported_tld",
      domain: normalised,
      tld,
      source: "none",
      reason: "no_registry_endpoint",
    };
  });
}

/** Inputs passed to {@link finalise}; bundled to satisfy the max-params lint. */
type FinaliseArgs = {
  verdict: { status: "available" | "indeterminate" | "registered"; reason?: string };
  domain: string;
  tld: string;
  source: "rdap" | "whois";
};

/**
 * Folds a service verdict into the discriminated response envelope. Only
 * `indeterminate` carries a `reason` from the verdict; the `registered`
 * and `available` paths intentionally drop the field so the response stays
 * minimal for the happy paths.
 */
function finalise(args: FinaliseArgs): DomainAvailabilityResult {
  const { verdict, domain, tld, source } = args;
  if (verdict.status === "indeterminate") {
    return {
      status: "indeterminate",
      domain,
      tld,
      source,
      reason: verdict.reason ?? "unknown",
    };
  }
  return { status: verdict.status, domain, tld, source };
}

/**
 * Normalises the caller's input to ASCII (Punycode), lower-case, no
 * trailing dot, no leading/trailing whitespace. Throws a 422
 * `VALIDATION_ERROR` if the result is empty, exceeds the label cap, or
 * fails the structural DNS-name check.
 */
function normaliseDomain(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new AppError({ code: ErrorCode.VALIDATION_ERROR, message: "domain must not be empty" });
  }
  const withoutTrailingDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (ascii === "") {
    throw new AppError({
      code: ErrorCode.VALIDATION_ERROR,
      message: "domain is not a valid IDN/ASCII name",
    });
  }
  assertStructurallyValid(ascii);
  return ascii;
}

/**
 * Structural check after Punycode conversion: at least two labels, every
 * label non-empty, every label conforming to the DNS-label charset, and
 * the total label count within {@link MAX_DOMAIN_LABELS}.
 */
function assertStructurallyValid(ascii: string): void {
  const labels = ascii.split(".");
  if (labels.length < 2) {
    throw new AppError({
      code: ErrorCode.VALIDATION_ERROR,
      message: "domain must contain at least one dot (e.g. `example.com`)",
    });
  }
  if (labels.length > MAX_DOMAIN_LABELS) {
    throw new AppError({
      code: ErrorCode.VALIDATION_ERROR,
      message: `domain has too many labels (max ${MAX_DOMAIN_LABELS})`,
    });
  }
  for (const label of labels) {
    if (!isValidDnsLabel(label)) {
      throw new AppError({
        code: ErrorCode.VALIDATION_ERROR,
        message: `invalid DNS label: "${label}"`,
      });
    }
  }
}

/** Allowed character class per DNS label: lowercase ASCII letters, digits, hyphen. */
const DNS_LABEL_CHAR_PATTERN = /^[a-z0-9-]+$/;

/**
 * Strict DNS-label syntax (RFC 1035 §2.3.1): 1–63 lowercase alphanumerics
 * or hyphen, never leading or trailing with a hyphen. Case has already
 * been lowered by `domainToASCII`. Implemented as a small predicate
 * rather than a bounded-repetition regex so the lint rule
 * `security/detect-unsafe-regex` cannot flag a backtracking risk.
 */
function isValidDnsLabel(label: string): boolean {
  if (label.length === 0 || label.length > 63) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  return DNS_LABEL_CHAR_PATTERN.test(label);
}

/** Returns the lower-case TLD (last label) of the normalised ASCII domain. */
function extractTld(asciiDomain: string): string {
  const lastDot = asciiDomain.lastIndexOf(".");
  return asciiDomain.slice(lastDot + 1);
}
