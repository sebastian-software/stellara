/** Unified asynchronous OAuth client resolver for DCR and client metadata documents. */
import type { ClientRegistrar } from "./clients.js";
import type { OAuthStorage } from "./storage.js";

import { isOAuthClientIdWithinLimit } from "./client-id.js";
import { fetchClientDocument, parseClientDocumentUrl } from "./client-metadata-document.js";
import { createSourceRateLimiter, type SourceRateLimiter } from "./client-metadata-rate-limit.js";
import {
  CIMD_TIMEOUT_MS,
  type CimdOperationContext,
  type CimdTransport,
  createPinnedHttpsTransport,
} from "./client-metadata-transport.js";

export {
  assertConnectedAddress,
  createPinnedHttpsTransport,
  isPublicAddress,
} from "./client-metadata-transport.js";
export type {
  CimdOperationContext,
  CimdTransport,
  CimdTransportResponse,
} from "./client-metadata-transport.js";

const NEGATIVE_TTL_MS = 30_000;

/** Authoritative metadata returned by either registration mechanism. */
export type ResolvedClient = {
  clientId: string;
  clientName?: string;
  redirectUris: readonly string[];
  registration: "cimd" | "dcr";
  createdAt?: number;
};

export type ClientResolverOptions = {
  storage: OAuthStorage;
  registrar: ClientRegistrar;
  rateLimitPerMinute: number;
  maxInFlight: number;
  cacheMaxEntries: number;
  now?: () => number;
  transport?: CimdTransport;
  /** Test seam and hard memory cap for rotating source-address buckets. */
  rateBucketMaxEntries?: number;
};

export type ClientResolver = {
  resolveClient: (clientId: string, sourceIp: string) => Promise<ResolvedClient>;
  close: () => Promise<void>;
};

export type CimdErrorKind = "invalid_client" | "rate_limited" | "temporarily_unavailable";

/** Stable local error contract consumed by public OAuth routes. */
export class ClientMetadataError extends Error {
  public constructor(
    public readonly kind: CimdErrorKind,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClientMetadataError";
  }
}

type CacheValue =
  | { expiresAt: number; kind: "negative"; error: ClientMetadataError }
  | { expiresAt: number; kind: "positive"; client: ResolvedClient };
type ResolverState = {
  options: ClientResolverOptions;
  now: () => number;
  transport: CimdTransport;
  cache: Map<string, CacheValue>;
  flights: Map<string, Promise<ResolvedClient>>;
  controllers: Map<string, AbortController>;
  rateLimiter: SourceRateLimiter;
  inFlight: number;
  closed: boolean;
  closePromise?: Promise<void>;
};

/** Creates one process-scoped resolver with shared cache, single-flight and limits. */
export function createClientResolver(options: ClientResolverOptions): ClientResolver {
  const state: ResolverState = {
    options,
    now: options.now ?? Date.now,
    transport: options.transport ?? createPinnedHttpsTransport(),
    cache: new Map(),
    flights: new Map(),
    controllers: new Map(),
    rateLimiter: createSourceRateLimiter({
      maxPerMinute: options.rateLimitPerMinute,
      maxEntries: options.rateBucketMaxEntries,
    }),
    inFlight: 0,
    closed: false,
  };
  return {
    async resolveClient(clientId, sourceIp) {
      return resolveClient(state, clientId, sourceIp);
    },
    async close() {
      await closeResolver(state);
    },
  };
}

async function resolveClient(
  state: ResolverState,
  clientId: string,
  sourceIp: string,
): Promise<ResolvedClient> {
  if (state.closed) throw unavailable("OAuth client resolver is shutting down");
  if (!isOAuthClientIdWithinLimit(clientId)) throw invalid("client_id exceeds the safe limit");
  if (isHttpsClientId(clientId)) return resolveCimd(state, clientId, sourceIp);
  const local = state.options.registrar.resolveClient(state.options.storage, clientId);
  if (local.kind !== "ok") throw invalid("Unknown client_id");
  return {
    clientId: local.clientId,
    clientName: local.clientName,
    redirectUris: local.redirectUris,
    registration: "dcr",
    createdAt: local.createdAt,
  };
}

async function resolveCimd(
  state: ResolverState,
  clientId: string,
  sourceIp: string,
): Promise<ResolvedClient> {
  validateCimdIdentifier(clientId);
  const cached = readCache(state.cache, clientId, state.now());
  if (cached !== undefined) return unwrapCache(cached, clientId);
  const existingFlight = state.flights.get(clientId);
  if (existingFlight !== undefined) return existingFlight;
  enforceMissLimits(state, sourceIp);
  return startFlight(state, clientId);
}

function validateCimdIdentifier(clientId: string): void {
  try {
    parseClientDocumentUrl(clientId);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Invalid CIMD client_id");
  }
}

function enforceMissLimits(state: ResolverState, sourceIp: string): void {
  if (state.inFlight >= state.options.maxInFlight) {
    throw unavailable("CIMD lookup capacity exhausted");
  }
  const retryAfterSeconds = state.rateLimiter.consume(sourceIp, state.now());
  if (retryAfterSeconds !== undefined) {
    throw new ClientMetadataError(
      "rate_limited",
      "CIMD lookup rate limit exceeded",
      retryAfterSeconds,
    );
  }
}

async function startFlight(state: ResolverState, clientId: string): Promise<ResolvedClient> {
  state.inFlight += 1;
  const controller = new AbortController();
  const operation: CimdOperationContext = {
    deadlineAt: Date.now() + CIMD_TIMEOUT_MS,
    signal: controller.signal,
  };
  const timer = setTimeout(() => {
    controller.abort(new Error("CIMD request timed out"));
  }, CIMD_TIMEOUT_MS);
  timer.unref();
  state.controllers.set(clientId, controller);
  const flight = fetchClientDocument({
    originalClientId: clientId,
    transport: state.transport,
    nowMs: state.now(),
    operation,
  })
    .then((document) => {
      const client: ResolvedClient = {
        clientId: document.clientId,
        clientName: document.clientName,
        redirectUris: document.redirectUris,
        registration: "cimd",
      };
      return cacheSuccess(state, { clientId, client, ttlMs: document.ttlMs }, operation.signal);
    })
    .catch((error: unknown) => cacheFailure({ state, clientId, error, signal: operation.signal }))
    .finally(() => {
      clearTimeout(timer);
      state.inFlight -= 1;
      state.controllers.delete(clientId);
      state.flights.delete(clientId);
    });
  state.flights.set(clientId, flight);
  return flight;
}

function cacheSuccess(
  state: ResolverState,
  result: { clientId: string; client: ResolvedClient; ttlMs: number },
  signal: AbortSignal,
): ResolvedClient {
  if (state.closed || signal.aborted) {
    throw unavailable("OAuth client resolver is shutting down");
  }
  writeCache({
    cache: state.cache,
    key: result.clientId,
    value: {
      kind: "positive",
      client: result.client,
      expiresAt: state.now() + result.ttlMs,
    },
    maxEntries: state.options.cacheMaxEntries,
  });
  return result.client;
}

function cacheFailure(args: {
  state: ResolverState;
  clientId: string;
  error: unknown;
  signal: AbortSignal;
}): never {
  const { state, clientId, error, signal } = args;
  const safeError = state.closed
    ? unavailable("OAuth client resolver is shutting down")
    : normalizeCimdError(error);
  if (!state.closed && !signal.aborted) {
    writeCache({
      cache: state.cache,
      key: clientId,
      value: { kind: "negative", error: safeError, expiresAt: state.now() + NEGATIVE_TTL_MS },
      maxEntries: state.options.cacheMaxEntries,
    });
  }
  throw safeError;
}

/** URL-shaped HTTPS identifiers always take the metadata-document path. */
export function isHttpsClientId(clientId: string): boolean {
  try {
    return new URL(clientId).protocol === "https:";
  } catch {
    return clientId.toLowerCase().startsWith("https:");
  }
}

function unwrapCache(value: CacheValue, originalClientId: string): ResolvedClient {
  if (value.kind === "negative") throw value.error;
  if (value.client.clientId !== originalClientId) throw invalid("CIMD self-binding mismatch");
  return value.client;
}

function readCache(
  cache: Map<string, CacheValue>,
  key: string,
  nowMs: number,
): CacheValue | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  if (value.expiresAt <= nowMs) return undefined;
  cache.set(key, value);
  return value;
}

function writeCache(args: {
  cache: Map<string, CacheValue>;
  key: string;
  value: CacheValue;
  maxEntries: number;
}): void {
  if (!isOAuthClientIdWithinLimit(args.key)) return;
  args.cache.delete(args.key);
  args.cache.set(args.key, args.value);
  while (args.cache.size > args.maxEntries) {
    const oldest = args.cache.keys().next();
    if (oldest.done) return;
    args.cache.delete(oldest.value);
  }
}

async function closeResolver(state: ResolverState): Promise<void> {
  if (state.closePromise !== undefined) return state.closePromise;
  state.closed = true;
  state.cache.clear();
  state.rateLimiter.clear();
  const shutdownError = unavailable("OAuth client resolver is shutting down");
  for (const controller of state.controllers.values()) controller.abort(shutdownError);
  state.closePromise = Promise.allSettled(state.flights.values()).then(() => {
    state.cache.clear();
    state.rateLimiter.clear();
  });
  await state.closePromise;
}

function invalid(message: string): ClientMetadataError {
  return new ClientMetadataError("invalid_client", message);
}

function unavailable(message: string): ClientMetadataError {
  return new ClientMetadataError("temporarily_unavailable", message);
}

function normalizeCimdError(error: unknown): ClientMetadataError {
  return error instanceof ClientMetadataError
    ? error
    : invalid(error instanceof Error ? error.message : "Unable to resolve client metadata");
}
