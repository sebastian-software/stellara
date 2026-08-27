/**
 * Zod schemas for the domain availability tool (`domain_availability`,
 * plan 0013).
 *
 * The tool reports the registration status of a single domain in the global
 * DNS. The response is a discriminated union over `status` so callers cannot
 * mistakenly read the `source` or `reason` fields when they do not apply.
 */
import { z } from "zod/v4";

/**
 * Maximum length of an absolute DNS name per RFC 1035 §2.3.4 (excluding the
 * implicit trailing dot). 253 octets covers the longest legal hostname while
 * rejecting obvious abuse like multi-kilobyte strings without forcing the
 * service layer to deal with them.
 */
const MAX_DOMAIN_LENGTH = 253;

/** Request body for `POST /tools/domain/availability`. */
export const domainAvailabilityRequestSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(MAX_DOMAIN_LENGTH)
    .describe(
      "Domain name to check. Whitespace, a trailing dot and case are normalised; IDN labels are converted to Punycode before the lookup. The tool reports only registered/available status, never registrant data.",
    ),
});

/**
 * Discriminator values for {@link domainAvailabilityResponseSchema}. Promoted
 * to a constant so tests, the MCP description and the route handler can
 * reference them without hard-coding string literals.
 */
export const DOMAIN_AVAILABILITY_STATUSES = [
  "registered",
  "available",
  "unsupported_tld",
  "indeterminate",
] as const;

/** Union of every valid `status` value emitted by the tool. */
export type DomainAvailabilityStatus = (typeof DOMAIN_AVAILABILITY_STATUSES)[number];

/** Lookup source that produced the verdict. `none` is used for `unsupported_tld`. */
export const DOMAIN_AVAILABILITY_SOURCES = ["rdap", "whois", "none"] as const;

/** Union of every valid `source` value emitted by the tool. */
export type DomainAvailabilitySource = (typeof DOMAIN_AVAILABILITY_SOURCES)[number];

/**
 * Discriminated response shape for `POST /tools/domain/availability`. Every
 * variant carries the normalised `domain` (ASCII / Punycode) plus the
 * extracted `tld`; verdict variants additionally carry the `source` that
 * produced the answer, and the non-verdict variants carry an optional
 * `reason` so callers can render a useful explanation.
 */
export const domainAvailabilityResponseSchema = z.object({
  status: z.enum(DOMAIN_AVAILABILITY_STATUSES),
  domain: z.string().min(1).describe("Normalised ASCII (Punycode) form of the input domain."),
  tld: z.string().min(1).describe("The TLD that drove the lookup (ASCII, lower-case)."),
  source: z.enum(DOMAIN_AVAILABILITY_SOURCES),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional human-readable hint set on `unsupported_tld` and `indeterminate` (e.g. `discovery_unreachable`).",
    ),
});

/** Inferred TypeScript type for a `domain_availability` request body. */
export type DomainAvailabilityRequest = z.infer<typeof domainAvailabilityRequestSchema>;

/** Inferred TypeScript type for a `domain_availability` response body. */
export type DomainAvailabilityResponse = z.infer<typeof domainAvailabilityResponseSchema>;
