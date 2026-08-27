/**
 * Dynamic Client Registration (RFC 7591) for the OAuth subsystem (plan 0004
 * § Open DCR).
 *
 * MCP clients (Claude Desktop, ChatGPT Connector, …) discover the
 * `registration_endpoint` from `/.well-known/oauth-authorization-server` and
 * POST a minimal JSON body (`client_name` + `redirect_uris`) to claim a
 * `client_id`. Stellara grants a 32-byte hex id, persists the binding, and
 * never issues a `client_secret` — all clients are public per OAuth 2.1.
 *
 * To keep storage from filling up under attack, an in-memory per-IP rate
 * limit caps registrations at five per hour. The bucket is intentionally
 * separate from `src/rate-limit.ts` so the OAuth-specific policy can evolve
 * (and so rate-limit accounting does not hit the SQLite DB during a flood).
 */
import { randomBytes } from "node:crypto";

import type { ClientRegistrationRequest, ClientRegistrationResponse } from "../schemas/oauth.js";
import type { OAuthStorage } from "./storage.js";

/** Length of the generated `client_id` in bytes before hex encoding. */
const CLIENT_ID_BYTES = 16;

/** Default DCR rate-limit: 5 registrations per IP per hour. */
const DEFAULT_DCR_MAX_PER_HOUR = 5;
const ONE_HOUR_MS = 3_600_000;

/** Result of {@link ClientRegistrar.registerClient}. */
export type RegisterClientResult =
  | { kind: "invalid_redirect_uri"; reason: string }
  | { kind: "ok"; response: ClientRegistrationResponse }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/** Configuration accepted by {@link createClientRegistrar}. */
export type ClientRegistrarOptions = {
  /** Optional override for the per-IP DCR cap; defaults to 5 per hour. */
  maxPerHour?: number;
  /** Reference-time override; defaults to `Date.now()`. */
  now?: () => number;
  /** Persistent resource cutover; new registrations are never backdated below it. */
  resourceRequiredSince?: number;
};

type RateBucketEntry = { count: number; resetAt: number };

/**
 * Bundles client registration with an in-memory rate-limit bucket and a
 * stable storage handle. Decoupling the bucket from a module-global Map keeps
 * tests isolated and lets the orchestrator wire one registrar per app.
 */
export type ClientRegistrar = {
  /** Registers a new client; returns the populated metadata or a rejection. */
  registerClient: (
    storage: OAuthStorage,
    request: ClientRegistrationRequest,
    ipAddress: string,
  ) => RegisterClientResult;
  /** Looks up an existing client and bumps `last_used_at`. */
  resolveClient: (storage: OAuthStorage, clientId: string) => ClientLookupResult;
  /** Exposed for tests/diagnostics: how many requests has `ipAddress` consumed in the current window? */
  inspectBucket: (ipAddress: string) => RateBucketEntry | undefined;
};

/** Lookup outcome for {@link ClientRegistrar.resolveClient}. */
export type ClientLookupResult =
  | {
      kind: "ok";
      clientId: string;
      clientName?: string;
      createdAt: number;
      redirectUris: readonly string[];
    }
  | { kind: "unknown" };

/** Per-consumeBucket call parameters bundled into one argument. */
type ConsumeBucketArgs = {
  buckets: Map<string, RateBucketEntry>;
  ipAddress: string;
  maxPerHour: number;
  nowMs: number;
};

/**
 * Decides whether `ipAddress` may register one more client right now.
 * Mutates the supplied bucket map in place so the caller (the registrar) can
 * keep the policy state in a single Map.
 */
function consumeBucket(args: ConsumeBucketArgs): "allow" | { retryAfterSeconds: number } {
  const { buckets, ipAddress, maxPerHour, nowMs } = args;
  const existing = buckets.get(ipAddress);
  if (existing === undefined || existing.resetAt <= nowMs) {
    buckets.set(ipAddress, { count: 1, resetAt: nowMs + ONE_HOUR_MS });
    return "allow";
  }
  if (existing.count >= maxPerHour) {
    return { retryAfterSeconds: Math.ceil((existing.resetAt - nowMs) / 1000) };
  }
  existing.count += 1;
  return "allow";
}

/** Persists a freshly-issued client row and assembles its DCR response. */
function persistAndShape(args: {
  storage: OAuthStorage;
  request: ClientRegistrationRequest;
  nowMs: number;
  resourceRequiredSince: number;
}): ClientRegistrationResponse {
  const { storage, request, nowMs, resourceRequiredSince } = args;
  const clientId = randomBytes(CLIENT_ID_BYTES).toString("hex");
  storage.insertClient({
    client_id: clientId,
    client_name: request.client_name ?? null,
    redirect_uris: JSON.stringify(request.redirect_uris),
    created_at: Math.max(nowMs, resourceRequiredSince),
    last_used_at: Math.max(nowMs, resourceRequiredSince),
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(nowMs / 1000),
    client_name: request.client_name,
    redirect_uris: request.redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/**
 * Creates a registrar instance. Each app should construct exactly one — the
 * bucket map is private state held in the closure.
 */
export function createClientRegistrar(options: ClientRegistrarOptions = {}): ClientRegistrar {
  const buckets = new Map<string, RateBucketEntry>();
  const maxPerHour = options.maxPerHour ?? DEFAULT_DCR_MAX_PER_HOUR;
  const now = options.now ?? Date.now;
  const resourceRequiredSince = options.resourceRequiredSince ?? 0;

  return {
    registerClient(storage, request, ipAddress) {
      const validation = validateRedirectUris(request.redirect_uris);
      if (validation.kind === "invalid") {
        return { kind: "invalid_redirect_uri", reason: validation.reason };
      }
      const bucketDecision = consumeBucket({ buckets, ipAddress, maxPerHour, nowMs: now() });
      if (bucketDecision !== "allow") {
        return { kind: "rate_limited", retryAfterSeconds: bucketDecision.retryAfterSeconds };
      }
      const response = persistAndShape({ storage, request, nowMs: now(), resourceRequiredSince });
      return { kind: "ok", response };
    },

    resolveClient(storage, clientId) {
      const row = storage.getClient(clientId);
      if (row === undefined) return { kind: "unknown" };
      storage.touchClient(clientId, now());
      const parsed: unknown = JSON.parse(row.redirect_uris);
      const redirectUris = Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [];
      return {
        kind: "ok",
        clientId: row.client_id,
        clientName: row.client_name ?? undefined,
        createdAt: row.created_at,
        redirectUris,
      };
    },

    inspectBucket(ipAddress) {
      const entry = buckets.get(ipAddress);
      return entry === undefined ? undefined : { ...entry };
    },
  };
}

/**
 * RFC-8252-conform redirect-URI policy. OAuth 2.1 §4.1.3 allows HTTPS plus
 * the two loopback exceptions for native clients; everything else is
 * rejected so an attacker cannot register a HTTP-leak redirect.
 */
export function validateRedirectUris(
  uris: readonly string[],
): { kind: "invalid"; reason: string } | { kind: "ok" } {
  for (const uri of uris) {
    const validation = validateSingleRedirectUri(uri);
    if (validation.kind === "invalid") return validation;
  }
  return { kind: "ok" };
}

function validateSingleRedirectUri(
  uri: string,
): { kind: "invalid"; reason: string } | { kind: "ok" } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { kind: "invalid", reason: `Redirect URI "${uri}" is not a valid URL` };
  }
  if (parsed.protocol === "https:") return { kind: "ok" };
  if (parsed.protocol === "http:") {
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
      return { kind: "ok" };
    }
    return {
      kind: "invalid",
      reason: `Redirect URI "${uri}" uses HTTP outside the localhost loopback allowlist`,
    };
  }
  return {
    kind: "invalid",
    reason: `Redirect URI "${uri}" uses unsupported scheme "${parsed.protocol}"`,
  };
}
