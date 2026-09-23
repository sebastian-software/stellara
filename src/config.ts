/**
 * Environment loading and validation for Stellara.
 *
 * Builds a typed {@link Config} object from `process.env`, validating every
 * variable listed in concept §12 plus build-owned `APP_VERSION`. Bearer
 * tokens follow the `STELLARA_TOKEN_<USERID>` convention from §6.3 and are
 * collected into a `Map<token, userId>` during loading; the suffix becomes
 * the lowercased userId.
 */
import { z } from "zod";

/** Prefix marking environment variables that carry per-user bearer tokens. */
export const TOKEN_ENV_PREFIX = "STELLARA_TOKEN_";

/** Public log levels accepted by the configuration. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * Conservative default for {@link Config.trustedProxyCidrs}: only loopback
 * peers are trusted out of the box. Deployments behind a reverse proxy MUST
 * extend this with the CIDRs of their direct trusted proxy peers (see concept
 * §7.1).
 */
const DEFAULT_TRUSTED_PROXY_CIDRS = "127.0.0.1/8,::1/128";

/**
 * Regex matching a single CIDR entry — either an IPv4 (a.b.c.d/n) or an
 * IPv6 (hex groups with optional `::`) followed by a numeric prefix length.
 * The check is intentionally permissive: Fastify's `proxy-addr` performs the
 * real validation when it compiles the list, but rejecting obvious garbage
 * here turns operator typos into a startup error instead of a silent fallback.
 */
const CIDR_PATTERN = /^[\da-f:.]+\/\d{1,3}$/i;

/**
 * Minimum length required for a bearer token. Matches the output of
 * `openssl rand -hex 16` (32 hex chars) — anything shorter can be guessed
 * over the public internet within hours.
 */
const TOKEN_MIN_LENGTH = 32;

/**
 * Minimum number of distinct characters a bearer token must contain.
 * Catches degenerate values like `aaaaaaaa…` that would otherwise pass the
 * length check despite being trivially guessable. 16 unique characters is
 * the natural floor for hex output (`0-9a-f`).
 */
const TOKEN_MIN_UNIQUE_CHARS = 16;

/**
 * Truthy/falsy parsing for boolean-style env vars. Trimmed, lowercased,
 * with `"false"` and `"0"` treated as `false` and everything else as
 * `true`. Exported so module-init code that has to read `process.env`
 * before `loadConfig` runs (e.g. `playwright-pool.ts`'s stealth-plugin
 * registration) can apply the exact same semantics as the Zod transform
 * uses inside this file.
 */
export function isEnvFlagTrue(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return fallback;
  return normalized !== "false" && normalized !== "0";
}

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      // Default keeps local `tsx watch` runs convenient without forcing a value.
      .default("development"),
    PORT: z.coerce.number().int().positive().default(8787),
    PUBLIC_BASE_URL: z.url(),

    FIRECRAWL_BASE_URL: z.url(),
    FIRECRAWL_API_KEY: z.string().min(1),

    EXA_API_KEY: z.string().min(1).optional(),

    QDRANT_BASE_URL: z.url().optional(),
    QDRANT_API_KEY: z.string().min(1).optional(),
    // Default per §12.
    QDRANT_COLLECTION: z.string().min(1).default("stellara-memory"),

    // Default per §12.
    EMBEDDINGS_PROVIDER: z.string().min(1).default("openai"),
    // Sensible OpenAI defaults so operators only need to set
    // `EMBEDDINGS_API_KEY` to activate the embeddings feature.
    EMBEDDINGS_MODEL: z.string().min(1).default("text-embedding-3-small"),
    EMBEDDINGS_API_KEY: z.string().min(1).optional(),
    EMBEDDINGS_DIMENSIONS: z.coerce.number().int().positive().default(1536),

    // Default per §12.
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    // Default per §12 — deadline for graceful shutdown, not request handling.
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),

    // Defaults per §12.
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    // Pre-auth tier for unauthenticated requests (concept §7.1, §22). A
    // separate, tighter bucket — keyed on `request.ip` — runs BEFORE the auth
    // hook. Only requests without a usable Bearer header enter this bucket;
    // invalid or revoked Bearer attempts currently bypass it.
    UNAUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    UNAUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

    // Comma-separated list of revoked bearer token values (§6.5 Token-
    // Rotation & Revocation). Tokens listed here are rejected with 401 even if
    // their `STELLARA_TOKEN_<USERID>` entry still exists — this gives ops a
    // path to disable a leaked credential at the next process restart until
    // the configured env var can be rotated. Empty string (default) means no
    // revocations.
    STELLARA_REVOKED_TOKENS: z.string().default(""),

    // OAuth subsystem (§6.6). The data dir holds `stellara.db`, the SQLite
    // file that persists clients, refresh tokens, sessions and the signing
    // keypair. Default `/data` matches the volume mount declared in the
    // Dockerfile; tests override to `:memory:` via STELLARA_DATA_DIR.
    STELLARA_DATA_DIR: z.string().min(1).default("/data"),
    // JWT access-token lifetime (1 h) — short on purpose so refresh-token
    // rotation drives credential hygiene without a dedicated blocklist.
    STELLARA_OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    // Refresh-token lifetime (30 d). Single-use rotation per OAuth 2.1 §6.3
    // means each refresh produces a fresh token; this cap is the *idle*
    // ceiling before the user has to re-authenticate via the browser flow.
    STELLARA_OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),
    // Login session-cookie lifetime (12 h) with sliding renewal after the
    // first hour of inactivity — see `src/oauth/session.ts`.
    STELLARA_OAUTH_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
    // Per-IP DCR rate limit. Five registrations/hour is enough for a normal
    // multi-client setup pass but blocks naive storage-fill attacks.
    STELLARA_OAUTH_DCR_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
    // Client-ID Metadata Documents are fetched from an unauthenticated OAuth
    // path, so their outbound work has a separate, fail-closed budget.
    STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
    STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(16),
    STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(512),

    // Feature flag for the lightweight HTTP-fetch tools (`web_fetch` and
    // `web_graphql`, concept §8.17/§8.18). Default `true` because the tools
    // need no external credentials; deployments that prefer to expose only
    // the Firecrawl-backed surface can set `STELLARA_FETCH_ENABLED=false`.
    // `normalizeEnv` already maps the empty string to `undefined` so the
    // default kicks in for blank entries; explicit `"false"` / `"0"`
    // disable the feature, anything else (including `"true"`, `"1"`,
    // `"yes"`) leaves it enabled.
    STELLARA_FETCH_ENABLED: z
      .string()
      .default("true")
      .transform((value) => {
        const normalized = value.toLowerCase();
        return normalized !== "false" && normalized !== "0";
      }),

    // Feature flag for the Playwright-backed `browser_*` tools (concept
    // §8.19+). Default `true` because the tools need no external
    // credentials, only the bundled Chromium runtime. Operators that prefer
    // a slimmer surface (or run the gateway in an environment without
    // Chromium) can set `STELLARA_PLAYWRIGHT_ENABLED=false`. Same bool
    // semantics as `STELLARA_FETCH_ENABLED`.
    STELLARA_PLAYWRIGHT_ENABLED: z
      .string()
      .default("true")
      .transform((value) => {
        const normalized = value.toLowerCase();
        return normalized !== "false" && normalized !== "0";
      }),

    // Feature flag for the domain availability tool (`domain_availability`,
    // plan 0013). Default `true` because no external credentials are
    // required; the tool issues outbound HTTPS (RDAP) and plain TCP/43
    // (WHOIS) requests. Deployments that cannot reach TCP/43 — or want a
    // slimmer surface — can disable both with
    // `STELLARA_DOMAIN_ENABLED=false`. Same bool semantics as the other
    // feature flags above.
    STELLARA_DOMAIN_ENABLED: z
      .string()
      .default("true")
      .transform((value) => isEnvFlagTrue(value, true)),

    // Global cap on concurrent Playwright sessions (browser contexts). A
    // single Chromium context typically reserves 200-400 MB RAM, so the
    // default `3` keeps the gateway within the 1536 MB container budget
    // even under worst-case page memory.
    STELLARA_PLAYWRIGHT_MAX_SESSIONS: z.coerce.number().int().positive().default(3),

    // Per-user cap on concurrent Playwright sessions. Default `1` mirrors
    // the typical interactive flow (one user, one open browser); operators
    // with parallel scripted clients can raise it. Capped above by the
    // global limit.
    STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER: z.coerce.number().int().positive().default(1),

    // Plan 0012 stealth kill-switch. Default `true` enables both the
    // `puppeteer-extra-plugin-stealth` patches (registered at module load
    // in `src/services/playwright-pool.ts`) AND the per-session context
    // identity (Linux Chrome stable, de-DE, Europe/Berlin, 1366×768) that
    // `browser_session_start` applies when `stealth: true`. Setting this
    // to `false` disables both layers; the `stealth` request field is
    // ignored in that mode. Same bool semantics as
    // `STELLARA_PLAYWRIGHT_ENABLED`. Note: the pool module also reads
    // this env var directly at import time, before `loadConfig` runs, so
    // changing it requires a process restart to take effect on the plugin
    // registration path.
    STELLARA_PLAYWRIGHT_STEALTH: z
      .string()
      .default("true")
      .transform((value) => isEnvFlagTrue(value, true)),

    // Build-time version stamped by the Dockerfile (§19); falls back so dev
    // runs without the build arg still produce a usable response.
    APP_VERSION: z.string().min(1).default("0.0.0-dev"),

    // Comma-separated CIDR allowlist whose `X-Forwarded-For` headers Fastify
    // is allowed to trust (concept §7.1). The default is the loopback range
    // only — operators MUST extend this with the CIDRs of their direct trusted
    // reverse-proxy peers before exposing the gateway through a proxy;
    // otherwise the proxied client IP is unavailable. The string is parsed
    // into a trimmed, non-empty array so the resulting `Config` is easy to
    // assert against in tests.
    TRUSTED_PROXY_CIDRS: z
      .string()
      .default(DEFAULT_TRUSTED_PROXY_CIDRS)
      .transform((value, ctx) => {
        const entries = value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);

        if (entries.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "TRUSTED_PROXY_CIDRS must contain at least one CIDR entry",
          });
          return z.NEVER;
        }

        const invalid = entries.filter((entry) => !CIDR_PATTERN.test(entry));
        if (invalid.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `TRUSTED_PROXY_CIDRS contains invalid CIDR entries: ${invalid.join(", ")}`,
          });
          return z.NEVER;
        }

        return entries;
      }),
  })
  .superRefine((env, ctx) => {
    // Qdrant base URL and API key are coupled — both or neither (§12).
    // Missing one half is almost always a deployment misconfiguration that
    // would otherwise produce confusing 401s/connect-refused at request time.
    const qdrantBaseSet = env.QDRANT_BASE_URL !== undefined;
    const qdrantKeySet = env.QDRANT_API_KEY !== undefined;
    if (qdrantBaseSet !== qdrantKeySet) {
      ctx.addIssue({
        code: "custom",
        path: [qdrantBaseSet ? "QDRANT_API_KEY" : "QDRANT_BASE_URL"],
        message: "QDRANT_BASE_URL and QDRANT_API_KEY must both be set or both be unset",
      });
    }
    // Memory tools need both Qdrant and an embeddings backend. Reporting this
    // at config time gives the operator a clear pointer instead of a runtime
    // 500 the first time a `/tools/memory/*` call lands.
    if (qdrantBaseSet && env.EMBEDDINGS_API_KEY === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["EMBEDDINGS_API_KEY"],
        message:
          "Qdrant is configured but EMBEDDINGS_API_KEY is missing — memory tools require both",
      });
    }
  });

/**
 * Resolved feature flags derived from the parsed environment.
 *
 * A feature is "active" exactly when every credential it needs is present
 * (concept §12). The server bootstrap consults these flags to decide which
 * upstream services to instantiate, which REST routes to register, and which
 * MCP tools to expose. `memory` additionally requires `embeddings` because
 * Qdrant alone cannot answer `/tools/memory/*` without an embedding pipeline.
 */
export type ConfigFeatures = {
  /** Exa search backend (`/tools/search`, `/tools/research`). */
  exa: boolean;
  /** Firecrawl scrape/crawl backend (`/tools/scrape`, `/tools/crawl`). */
  firecrawl: boolean;
  /** Embeddings provider (currently OpenAI). */
  embeddings: boolean;
  /** Memory tools (`/tools/memory/*`) — needs Qdrant + Embeddings. */
  memory: boolean;
  /**
   * Lightweight HTTP-fetch tools (`/tools/fetch`, `/tools/graphql`,
   * concept §8.17/§8.18). Default-on because no external credentials are
   * required; can be turned off per deployment via
   * `STELLARA_FETCH_ENABLED=false`.
   */
  fetch: boolean;
  /**
   * Playwright-backed browser tools (`/tools/browser/*`, concept §8.19+).
   * Default-on because no external credentials are required, only the
   * bundled Chromium binary that ships with the runtime image; can be
   * turned off per deployment via `STELLARA_PLAYWRIGHT_ENABLED=false`.
   */
  playwright: boolean;
  /**
   * Domain availability tool (`/tools/domain/availability`, plan 0013).
   * Default-on because no external credentials are required, but the tool
   * needs outbound HTTPS plus plain TCP/43 (WHOIS). Deployments that
   * cannot egress on port 43 can disable the tool entirely via
   * `STELLARA_DOMAIN_ENABLED=false`.
   */
  domain: boolean;
};

/** Parsed and validated configuration object exposed to the rest of the app. */
export type Config = {
  nodeEnv: "development" | "production" | "test";
  port: number;
  publicBaseUrl: string;

  firecrawlBaseUrl: string;
  firecrawlApiKey: string;

  exaApiKey?: string;

  qdrantBaseUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection: string;

  embeddingsProvider: string;
  embeddingsModel: string;
  embeddingsApiKey?: string;
  embeddingsDimensions: number;

  /** Resolved feature flags (see {@link ConfigFeatures}). */
  features: ConfigFeatures;

  logLevel: (typeof LOG_LEVELS)[number];
  requestTimeoutMs: number;

  rateLimitMax: number;
  rateLimitWindowMs: number;

  unauthRateLimitMax: number;
  unauthRateLimitWindowMs: number;

  appVersion: string;

  /**
   * CIDR allowlist of peers whose `X-Forwarded-For` (and friends) Fastify
   * may trust to resolve `request.ip` (§7.1). Anything outside this list is
   * treated as a direct client and its forwarded-headers are ignored.
   */
  trustedProxyCidrs: readonly string[];

  /** Lookup map from raw bearer token to resolved userId (§6.3). */
  tokens: ReadonlyMap<string, string>;

  /**
   * Set of revoked bearer token values (§6.5). Applied to direct static
   * authentication and OAuth login after a process or container restart.
   */
  revokedTokens: ReadonlySet<string>;

  /** OAuth-2.1 authorization-server configuration (§6.6). */
  oauth: OAuthConfig;

  /** Playwright session-pool configuration (concept §8.19+). */
  playwright: PlaywrightConfig;
};

/** Playwright session-pool configuration block. */
export type PlaywrightConfig = {
  /** Global cap on concurrent Playwright sessions (browser contexts). */
  maxSessions: number;
  /** Per-user cap on concurrent Playwright sessions. */
  maxSessionsPerUser: number;
  /**
   * Plan 0012 — when `true`, `browser_session_start` applies the Linux
   * Chrome stable spoof identity to every new context (subject to the
   * per-session `stealth` flag) AND the stealth plugin registered in
   * `playwright-pool.ts` patches `navigator.webdriver`, `window.chrome`
   * and friends. When `false`, both layers are disabled and the per-
   * session `stealth` flag is ignored. The pool module reads the same
   * env var directly at import time, before `loadConfig` runs.
   */
  stealth: boolean;
};

/** OAuth-2.1 subsystem configuration block. */
export type OAuthConfig = {
  /** Filesystem directory holding `stellara.db`; mounted as a volume in prod. */
  dataDir: string;
  /** Lifetime of JWT access tokens, in seconds. */
  accessTokenTtlSeconds: number;
  /** Lifetime of opaque refresh tokens, in seconds. */
  refreshTokenTtlSeconds: number;
  /** Lifetime of the login session cookie, in seconds (sliding renewal). */
  sessionTtlSeconds: number;
  /** Per-IP cap on `/oauth/register` calls within a rolling hour window. */
  dcrRateLimitPerHour: number;
  /** Per-source-IP cap on real CIMD cache misses per minute. */
  cimdRateLimitPerMinute: number;
  /** Process-wide cap on concurrent CIMD network fetches. */
  cimdMaxInFlight: number;
  /** Shared positive/negative CIMD LRU capacity. */
  cimdCacheMaxEntries: number;
};

/** Error thrown when {@link loadConfig} cannot parse the supplied environment. */
export class ConfigError extends Error {
  public readonly issues: Record<string, string[]>;

  public constructor(message: string, issues: Record<string, string[]>) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/**
 * Throws a {@link ConfigError} when `value` falls below the minimum entropy
 * the gateway requires from a bearer token. Length and unique-character
 * floors are deliberately conservative — see {@link TOKEN_MIN_LENGTH} and
 * {@link TOKEN_MIN_UNIQUE_CHARS} — because tokens are the only credential
 * protecting public, internet-exposed endpoints (§6.3).
 */
function assertTokenStrength(userId: string, value: string): void {
  const uniqueChars = new Set(value).size;
  if (value.length >= TOKEN_MIN_LENGTH && uniqueChars >= TOKEN_MIN_UNIQUE_CHARS) {
    return;
  }
  throw new ConfigError(`Bearer token for user "${userId}" is too weak`, {
    [TOKEN_ENV_PREFIX]: [
      `Token value for "${userId}" must be at least ${TOKEN_MIN_LENGTH} characters with at least ${TOKEN_MIN_UNIQUE_CHARS} unique characters. Generate one with: openssl rand -hex 48`,
    ],
  });
}

/**
 * Parses the comma-separated `STELLARA_REVOKED_TOKENS` value into a `Set` of
 * trimmed token values. Empty fragments (e.g. trailing commas) are dropped
 * so operators do not have to be careful about whitespace.
 */
function buildRevokedTokenSet(raw: string): Set<string> {
  const revoked = new Set<string>();
  for (const fragment of raw.split(",")) {
    const value = fragment.trim();
    if (value !== "") {
      revoked.add(value);
    }
  }
  return revoked;
}

function buildTokenMap(env: NodeJS.ProcessEnv): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(TOKEN_ENV_PREFIX)) continue;
    if (value === undefined || value === "") continue;
    const userId = key.slice(TOKEN_ENV_PREFIX.length).toLowerCase();
    if (userId === "") continue;
    assertTokenStrength(userId, value);
    const existing = tokens.get(value);
    if (existing !== undefined && existing !== userId) {
      throw new ConfigError("Duplicate bearer token value across users", {
        [TOKEN_ENV_PREFIX]: [
          `Token value is shared by users "${existing}" and "${userId}" — regenerate one of them with \`openssl rand -hex 48\`.`,
        ],
      });
    }
    tokens.set(value, userId);
  }
  return tokens;
}

/**
 * Coerces empty environment values to `undefined` so that Zod's
 * `.optional()` matches both unset and blank entries. `dotenv` and Docker's
 * `--env-file` both materialize missing variables as empty strings; without
 * this normalization, every optional credential would still trip the
 * `.min(1)` / `.url()` guards even when the operator left it blank.
 */
function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key] = value === "" ? undefined : value;
  }
  return normalized;
}

/**
 * Derives the feature-flag matrix from a parsed config payload. Memory
 * additionally requires Embeddings because the upsert/search paths embed
 * `text` before talking to Qdrant — see concept §11/§12.
 */
function deriveFeatures(data: z.infer<typeof envSchema>): ConfigFeatures {
  return {
    exa: data.EXA_API_KEY !== undefined,
    firecrawl: true,
    embeddings: data.EMBEDDINGS_API_KEY !== undefined,
    memory:
      data.QDRANT_BASE_URL !== undefined &&
      data.QDRANT_API_KEY !== undefined &&
      data.EMBEDDINGS_API_KEY !== undefined,
    fetch: data.STELLARA_FETCH_ENABLED,
    playwright: data.STELLARA_PLAYWRIGHT_ENABLED,
    domain: data.STELLARA_DOMAIN_ENABLED,
  };
}

/**
 * Loads and validates Stellara's configuration from the supplied environment.
 * Throws a {@link ConfigError} when required variables are missing or no
 * bearer tokens are configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const normalizedEnv = normalizeEnv(env);
  const parsed = envSchema.safeParse(normalizedEnv);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error).fieldErrors as Record<string, string[]>;
    throw new ConfigError("Invalid environment configuration", flat);
  }
  const tokens = buildTokenMap(normalizedEnv);
  if (tokens.size === 0) {
    throw new ConfigError("No bearer tokens configured", {
      [TOKEN_ENV_PREFIX]: [
        `Define at least one ${TOKEN_ENV_PREFIX}<USERID> variable (see concept §6.1).`,
      ],
    });
  }
  return assembleConfig(parsed.data, tokens);
}

/**
 * Maps the parsed Zod payload onto the runtime {@link Config} shape. Kept
 * separate from {@link loadConfig} so the top-level function stays within
 * the project's per-function statement budget.
 */
function assembleConfig(
  data: z.infer<typeof envSchema>,
  tokens: ReadonlyMap<string, string>,
): Config {
  return {
    nodeEnv: data.NODE_ENV,
    port: data.PORT,
    publicBaseUrl: data.PUBLIC_BASE_URL,

    firecrawlBaseUrl: data.FIRECRAWL_BASE_URL,
    firecrawlApiKey: data.FIRECRAWL_API_KEY,

    exaApiKey: data.EXA_API_KEY,

    qdrantBaseUrl: data.QDRANT_BASE_URL,
    qdrantApiKey: data.QDRANT_API_KEY,
    qdrantCollection: data.QDRANT_COLLECTION,

    embeddingsProvider: data.EMBEDDINGS_PROVIDER,
    embeddingsModel: data.EMBEDDINGS_MODEL,
    embeddingsApiKey: data.EMBEDDINGS_API_KEY,
    embeddingsDimensions: data.EMBEDDINGS_DIMENSIONS,

    features: deriveFeatures(data),

    logLevel: data.LOG_LEVEL,
    requestTimeoutMs: data.REQUEST_TIMEOUT_MS,

    rateLimitMax: data.RATE_LIMIT_MAX,
    rateLimitWindowMs: data.RATE_LIMIT_WINDOW_MS,

    unauthRateLimitMax: data.UNAUTH_RATE_LIMIT_MAX,
    unauthRateLimitWindowMs: data.UNAUTH_RATE_LIMIT_WINDOW_MS,

    appVersion: data.APP_VERSION,

    trustedProxyCidrs: data.TRUSTED_PROXY_CIDRS,

    tokens,
    revokedTokens: buildRevokedTokenSet(data.STELLARA_REVOKED_TOKENS),

    oauth: {
      dataDir: data.STELLARA_DATA_DIR,
      accessTokenTtlSeconds: data.STELLARA_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: data.STELLARA_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      sessionTtlSeconds: data.STELLARA_OAUTH_SESSION_TTL_SECONDS,
      dcrRateLimitPerHour: data.STELLARA_OAUTH_DCR_RATE_LIMIT_PER_HOUR,
      cimdRateLimitPerMinute: data.STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE,
      cimdMaxInFlight: data.STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT,
      cimdCacheMaxEntries: data.STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES,
    },

    playwright: {
      maxSessions: data.STELLARA_PLAYWRIGHT_MAX_SESSIONS,
      maxSessionsPerUser: data.STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER,
      stealth: data.STELLARA_PLAYWRIGHT_STEALTH,
    },
  };
}
