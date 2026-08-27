/**
 * Fastify type augmentations for Stellara — adds the per-request `userId`
 * resolved by the auth hook plus the `config` and `services` decorators
 * populated during bootstrap.
 */
import type { Config } from "./config.js";
import type { ClientResolver } from "./oauth/client-metadata.js";
import type { ClientRegistrar } from "./oauth/clients.js";
import type { ActiveSigningKey } from "./oauth/keys.js";
import type { SessionManager } from "./oauth/session.js";
import type { OAuthStorage } from "./oauth/storage.js";
import type { EmbeddingsProvider } from "./services/embeddings.js";
import type { ExaClient } from "./services/exa.js";
import type { FirecrawlClient } from "./services/firecrawl.js";
import type { PlaywrightClient } from "./services/playwright.js";
import type { QdrantStore } from "./services/qdrant.js";

export type McpAuthContext = {
  clientId: string;
  expiresAt?: number;
  scopes: readonly string[];
  userId: string;
};

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved user id (concept §6.3). Undefined on public routes. */
    userId?: string;
    /** Token-free identity passed from bearer auth to the MCP SDK edge. */
    mcpAuth?: McpAuthContext;
  }

  interface FastifyInstance {
    /** Parsed configuration object attached during bootstrap. */
    config: Config;
    /** Shared upstream service clients (concept §11). */
    services: StellaraServices;
  }
}

/**
 * Aggregated upstream-service clients attached to the Fastify instance.
 *
 * Optional members reflect Stellara's feature flags (`Config.features`): a
 * service is only instantiated when its credentials are present. Routes and
 * MCP-tool dispatchers consult `Config.features` before reaching for these
 * fields, so absent entries indicate a deactivated feature rather than a
 * runtime bug. `oauth` is always populated — Stellara mandates the OAuth
 * surface per the MCP 2025-06-18 Authorization spec (§6.6).
 */
export type StellaraServices = {
  embeddings?: EmbeddingsProvider;
  exa?: ExaClient;
  firecrawl: FirecrawlClient;
  qdrant?: QdrantStore;
  playwright?: PlaywrightClient;
  oauth: OAuthServices;
};

/**
 * OAuth subsystem bundle attached to the Fastify instance. All four members
 * are required because the OAuth surface is non-optional in v1; future
 * versions may make individual components swappable.
 */
export type OAuthServices = {
  /** SQLite-backed persistence for clients, codes, tokens, sessions and keys. */
  storage: OAuthStorage;
  /** Active RSA signing key (loaded or bootstrapped at startup). */
  signingKey: ActiveSigningKey;
  /** DCR + client-lookup helper with per-IP rate-limit bucket. */
  registrar: ClientRegistrar;
  /** Unified async DCR/CIMD client metadata resolver. */
  clientResolver: ClientResolver;
  /** Persistent timestamp separating grandfathered and resource-strict DCR clients. */
  resourceRequiredSince: number;
  /** Login session-cookie lifecycle helper. */
  sessions: SessionManager;
};
