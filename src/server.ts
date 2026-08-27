import type { DestinationStream } from "pino";

import fastifyCookie from "@fastify/cookie";
import fastifyFormbody from "@fastify/formbody";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";
/**
 * Stellara server bootstrap.
 *
 * Exposes {@link buildApp} as a Fastify factory so tests can spin the server
 * up without actually listening on a TCP port, and {@link start} as the
 * production entry point with graceful shutdown wiring.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ulid } from "ulid";

import { createAuthHook } from "./auth.js";
import { type Config, loadConfig } from "./config.js";
import { AppError, ErrorCode, toErrorResponse } from "./errors.js";
import { DEFAULT_BODY_LIMIT } from "./limits.js";
import { createLoggerOptions } from "./logger.js";
import { type CimdTransport, createClientResolver } from "./oauth/client-metadata.js";
import { createClientRegistrar } from "./oauth/clients.js";
import { type ActiveSigningKey, loadOrBootstrapSigningKey } from "./oauth/keys.js";
import { initializeResourceCutover } from "./oauth/resource.js";
import { createSessionManager } from "./oauth/session.js";
import { OAuthStorage } from "./oauth/storage.js";
import { registerRateLimit, registerUnauthRateLimit } from "./rate-limit.js";
import { registerBrowserRoutes } from "./routes/browser/index.js";
import { registerCrawlStartRoute } from "./routes/crawl-start.js";
import { registerCrawlStatusRoute } from "./routes/crawl-status.js";
import { registerCrawlRoute } from "./routes/crawl.js";
import { registerDomainAvailabilityRoute } from "./routes/domain.js";
import { registerExtractRoute } from "./routes/extract.js";
import { registerFetchRoute } from "./routes/fetch.js";
import { registerGetRoute } from "./routes/get.js";
import { registerGraphqlQueryRoute } from "./routes/graphql-query.js";
import { registerGraphqlRoute } from "./routes/graphql.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMapRoute } from "./routes/map.js";
import { registerMcpRoute } from "./routes/mcp.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerOAuthRoutes } from "./routes/oauth/index.js";
import { registerOpenApiPlugin } from "./routes/openapi.js";
import { registerResearchRoute } from "./routes/research.js";
import { registerScrapeRoute } from "./routes/scrape.js";
import { registerSearchRoute } from "./routes/search.js";
import { createEmbeddingsProvider } from "./services/embeddings.js";
import { ExaClient } from "./services/exa.js";
import { FirecrawlClient } from "./services/firecrawl.js";
import { PlaywrightClient } from "./services/playwright.js";
import { QdrantStore } from "./services/qdrant.js";

/**
 * Maps a Fastify error onto a Stellara {@link AppError} when the §16.2
 * catalog covers it; returns `undefined` for the catch-all 500 path.
 *
 * For 413 PAYLOAD_TOO_LARGE the `details.limit` reports the route-specific
 * Fastify `bodyLimit` (exposed via `request.routeOptions.bodyLimit`) so the
 * caller learns exactly which cap they hit. Fastify always populates this
 * field from the route definition or the instance-wide default, so no
 * fallback is needed.
 */
function mapFastifyError(error: FastifyError, request: FastifyRequest): AppError | undefined {
  if (AppError.is(error)) return error;

  if (typeof error.statusCode === "number" && error.statusCode === 413) {
    return new AppError({
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      details: { limit: request.routeOptions.bodyLimit },
    });
  }

  // Zod / Fastify schema validation failures carry `.validation`
  // (§16.2 → 422 VALIDATION_ERROR).
  if (error.validation !== undefined) {
    return new AppError({ code: ErrorCode.VALIDATION_ERROR, message: error.message });
  }

  // Syntactic Bad-Request cases (wrong Content-Type, malformed JSON, …) hit
  // Fastify as 400 without `.validation` (§16.2 → 400 BAD_REQUEST).
  if (typeof error.statusCode === "number" && error.statusCode === 400) {
    return new AppError({ code: ErrorCode.BAD_REQUEST, message: error.message });
  }

  return undefined;
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const appError = mapFastifyError(error, request);
    if (appError !== undefined) {
      void reply.code(appError.httpStatus).send(toErrorResponse(appError));
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    const includeCause = app.config.nodeEnv !== "production";
    void reply.code(500).send(toErrorResponse(error, { includeCause }));
  });
}

/** Optional knobs the bootstrap exposes for tests. */
export type BuildAppOptions = {
  /**
   * Custom pino destination. Used by tests to capture log output into a
   * memory-backed stream instead of letting sonic-boom write to stdout's
   * file descriptor, which would otherwise bypass any stdout spy.
   */
  loggerDestination?: DestinationStream;
  /** Hermetic CIMD transport override for security and route tests. */
  clientMetadataTransport?: CimdTransport;
};

/**
 * Creates a fully wired Fastify instance.
 *
 * Plugin order follows the architecture decision in plan 0002:
 *  1. logger + body-limit + trustProxy (constructor)
 *  2. request-id generator (`genReqId`)
 *  3. unauth rate-limit hook — runs before auth so token-brute-force and
 *     audit-log floods are capped even when the auth hook would reject the
 *     request with 401 (concept §7.1, §22)
 *  4. auth hook (`onRequest`)
 *  5. per-user rate-limit plugin (depends on `request.userId`)
 *  6. global error handler
 */
export async function buildApp(
  config: Config,
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: createLoggerOptions(config, options.loggerDestination),
    // Trust only the peers explicitly listed in `TRUSTED_PROXY_CIDRS`
    // (concept §7.1). Fastify accepts an array of CIDR strings here and
    // hands it to `@fastify/proxy-addr`, so `X-Forwarded-For` from any
    // other direct peer is ignored and cannot spoof `request.ip`.
    // We spread into a fresh array because Fastify mutates the option
    // bag internally and `Config.trustedProxyCidrs` is intentionally
    // immutable.
    trustProxy: [...config.trustedProxyCidrs],
    bodyLimit: DEFAULT_BODY_LIMIT,
    disableRequestLogging: false,
    genReqId: () => ulid(),
  });

  // OAuth subsystem must come up first because the auth hook depends on the
  // active signing key for JWT verification (§6.6).
  const { storage: oauthStorage, signingKey, resourceRequiredSince } = bootstrapOAuth(config);
  app.decorate("config", config);
  app.decorate(
    "services",
    buildServices(config, { oauthStorage, signingKey, resourceRequiredSince, options }),
  );

  await app.register(fastifyCookie);
  // The OAuth login page submits an HTML form with the default
  // `application/x-www-form-urlencoded` content type. Fastify ships no parser
  // for that media type out of the box, so without this plugin the POST to
  // `/oauth/login` fails at the body-parsing stage and returns INTERNAL_ERROR.
  await app.register(fastifyFormbody);
  registerLifecycleHooks(app, config, signingKey);
  await registerRateLimit(app, config);

  // OpenAPI plugin must be registered before any route whose Zod schema
  // should appear in the generated spec (concept §20); health routes
  // follow immediately so /health and /ready show up in `paths`. OAuth
  // routes are hidden from the spec via per-route `schema.hide: true`.
  await registerOpenApiPlugin(app);
  registerHealthRoutes(app);
  registerOAuthRoutes(app);
  registerToolRoutes(app);
  registerMcpRoute(app);
  registerErrorHandler(app);
  return app;
}

/**
 * Spins up the OAuth storage + signing key + orphan-cleanup sweep. Extracted
 * from {@link buildApp} so the bootstrap stays within the project's
 * per-function statement budget while keeping the OAuth-lifecycle steps
 * grouped together.
 */
function bootstrapOAuth(config: Config): {
  storage: OAuthStorage;
  signingKey: ActiveSigningKey;
  resourceRequiredSince: number;
} {
  const storage = new OAuthStorage({ path: resolveSqlitePath(config) });
  const resourceRequiredSince = initializeResourceCutover(storage);
  const signingKey = loadOrBootstrapSigningKey(storage);
  // Token-rotation hygiene: drop any sessions/refresh tokens whose userId is
  // no longer in the configured token map. Protects against the doubly-used-
  // credential case where `STELLARA_TOKEN_<USERID>` was rotated while the
  // OAuth surface still carried valid refresh tokens for that user.
  sweepOrphanedOAuthState(storage, config);
  return { storage, signingKey, resourceRequiredSince };
}

/**
 * Registers the lifecycle + request hooks that surround the auth pipeline:
 * onClose for SQLite shutdown, requestId binding, unauth rate-limit, auth
 * hook and userId binding. Same plugin order as before — only the call site
 * is collapsed so `buildApp` stays small.
 */
function registerLifecycleHooks(
  app: FastifyInstance,
  config: Config,
  signingKey: ActiveSigningKey,
): void {
  // Close the SQLite connection during graceful shutdown so file locks are
  // released cleanly and the periodic TTL sweep stops firing.
  app.addHook("onClose", async (instance) => {
    await instance.services.oauth.clientResolver.close();
    instance.services.oauth.storage.close();
  });
  // Tear down the Playwright session pool: stops the background sweeper,
  // closes every open browser context and shuts down the shared Chromium
  // process so a SIGTERM/SIGINT cycle does not leak zombie browsers.
  app.addHook("onClose", async (instance) => {
    if (instance.services.playwright !== undefined) {
      await instance.services.playwright.close();
    }
  });
  // Attach the resolved requestId binding to the per-request child logger and
  // mirror it in the response header so callers can correlate logs (§21).
  app.addHook("onRequest", (request, reply, done) => {
    request.log = request.log.child({ requestId: request.id });
    void reply.header("x-request-id", request.id);
    done();
  });
  // Pre-auth IP rate-limit — must run BEFORE `createAuthHook` so that
  // unauthenticated traffic cannot brute-force tokens or flood the audit log
  // by hiding behind 401 responses (concept §7.1, §22).
  registerUnauthRateLimit(app, config);
  app.addHook("onRequest", createAuthHook(config, { signingKey }));
  // Rebind the child logger right after auth so subsequent log lines —
  // including those emitted by the rate-limit plugin's onRequest hook below —
  // carry the resolved `userId`.
  app.addHook("onRequest", (request, _reply, done) => {
    if (request.userId !== undefined) {
      request.log = request.log.child({ userId: request.userId });
    }
    done();
  });
}

/**
 * Resolves the SQLite path from the configured data dir. The `:memory:`
 * sentinel passes through unchanged so tests can run against an in-memory
 * DB; everything else is treated as a directory and gets `stellara.db`
 * appended.
 */
function resolveSqlitePath(config: Config): string {
  if (config.oauth.dataDir === ":memory:") return ":memory:";
  return join(config.oauth.dataDir, "stellara.db");
}

/**
 * Removes refresh tokens and sessions for userIds that are no longer in the
 * configured token map. Called once at boot so a `STELLARA_TOKEN_<USERID>`
 * rotation cannot leave stale OAuth credentials alive past the rotation
 * (plan 0004 plan-review security finding).
 */
function sweepOrphanedOAuthState(storage: OAuthStorage, config: Config): void {
  const knownUserIds = new Set(config.tokens.values());
  const allRefreshRows = storage.db
    .prepare<unknown[], { user_id: string }>("SELECT DISTINCT user_id FROM oauth_refresh_tokens")
    .all();
  const allSessionRows = storage.db
    .prepare<unknown[], { user_id: string }>("SELECT DISTINCT user_id FROM oauth_sessions")
    .all();
  const orphanUserIds = new Set<string>();
  for (const row of [...allRefreshRows, ...allSessionRows]) {
    if (!knownUserIds.has(row.user_id)) orphanUserIds.add(row.user_id);
  }
  for (const userId of orphanUserIds) {
    storage.deleteRefreshTokensForUser(userId);
    storage.deleteSessionsForUser(userId);
  }
}

/**
 * Builds the upstream-service decorator bag.
 *
 * Only services whose feature flag is on are instantiated; the others stay
 * `undefined` so a misconfigured deployment cannot accidentally probe (or be
 * dispatched to) an unconfigured backend. OAuth services are always present
 * because the OAuth surface is mandatory (§6.6). The object is frozen so
 * accidental mutation surfaces immediately during tests.
 */
function buildServices(
  config: Config,
  args: {
    oauthStorage: OAuthStorage;
    signingKey: ActiveSigningKey;
    resourceRequiredSince: number;
    options: BuildAppOptions;
  },
): FastifyInstance["services"] {
  const { oauthStorage, signingKey, resourceRequiredSince, options } = args;
  const registrar = createClientRegistrar({
    maxPerHour: config.oauth.dcrRateLimitPerHour,
    resourceRequiredSince,
  });
  return Object.freeze({
    embeddings: config.features.embeddings ? createEmbeddingsProvider(config) : undefined,
    exa: config.features.exa ? new ExaClient(config) : undefined,
    firecrawl: new FirecrawlClient(config),
    qdrant: config.features.memory ? new QdrantStore(config) : undefined,
    playwright: config.features.playwright ? new PlaywrightClient(config) : undefined,
    oauth: {
      storage: oauthStorage,
      signingKey,
      registrar,
      clientResolver: createClientResolver({
        storage: oauthStorage,
        registrar,
        rateLimitPerMinute: config.oauth.cimdRateLimitPerMinute,
        maxInFlight: config.oauth.cimdMaxInFlight,
        cacheMaxEntries: config.oauth.cimdCacheMaxEntries,
        transport: options.clientMetadataTransport,
      }),
      resourceRequiredSince,
      sessions: createSessionManager({ ttlSeconds: config.oauth.sessionTtlSeconds }),
    },
  });
}

/**
 * Registers the tool routes under `/tools/*` that match the resolved feature
 * flags. Routes for deactivated features are skipped entirely so the OpenAPI
 * surface and the route table reflect what the deployment can actually serve.
 */
function registerToolRoutes(app: FastifyInstance): void {
  const { features } = app.config;
  if (features.exa) {
    registerSearchRoute(app);
    registerResearchRoute(app);
  }
  if (features.firecrawl) {
    registerFirecrawlRoutes(app);
  }
  if (features.memory) {
    registerMemoryRoutes(app);
  }
  if (features.fetch) {
    registerFetchRoutes(app);
  }
  if (features.playwright) {
    registerBrowserRoutes(app);
  }
  if (features.domain) {
    registerDomainAvailabilityRoute(app);
  }
}

/**
 * Registers every Firecrawl-backed REST route. Pulled out of
 * {@link registerToolRoutes} so the latter stays under the project's
 * per-function statement budget — plan 0005 added seven new routes to this
 * block; plan 0008 removed the three interactive Firecrawl tools in favor
 * of the upcoming Playwright-based browser tool family (plan 0009/0010).
 */
function registerFirecrawlRoutes(app: FastifyInstance): void {
  registerScrapeRoute(app);
  registerCrawlRoute(app);
  registerMapRoute(app);
  registerExtractRoute(app);
  registerCrawlStartRoute(app);
  registerCrawlStatusRoute(app);
}

/**
 * Registers the lightweight HTTP-fetch routes (`/tools/fetch`,
 * `/tools/graphql`, plan 0006). Gated by `features.fetch` so deployments
 * that prefer to expose only the Firecrawl-backed surface can leave them
 * out via `STELLARA_FETCH_ENABLED=false`.
 */
function registerFetchRoutes(app: FastifyInstance): void {
  registerFetchRoute(app);
  registerGraphqlRoute(app);
  // Plan 0014 — read-only siblings share the same `features.fetch` gate.
  registerGetRoute(app);
  registerGraphqlQueryRoute(app);
}

/**
 * Centralized process-exit helper. Funnelling every bootstrap/shutdown exit
 * through one function keeps `node/no-process-exit` warnings at a single,
 * documented design-decision site (CLI entry + signal-driven shutdown — both
 * cases where throwing is not an option). All callers are inside this file.
 */
function exitProcess(code: number): never {
  // The single intentional `process.exit` site — see TSDoc above. The
  // `node/no-process-exit` warning is acknowledged as an explicit design
  // decision for the CLI/bootstrap path; the wrapper consolidates four call
  // sites (force-exit timer + happy/error path of `app.close()` + outer
  // bootstrap catch) down to one warning.
  process.exit(code);
}

/**
 * Production bootstrap: load config, build the app, listen, and wire
 * graceful shutdown on SIGTERM/SIGINT (§19).
 */
export async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);

  // Single boot-time line that lets operators see at a glance which tool
  // surface this container actually serves. Avoids the silent-degradation
  // failure mode where a missing credential just hides a tool without any
  // visible signal in the logs.
  app.log.info({ features: config.features }, "Stellara configuration loaded");

  // Plan 0002 Schritt 3 demands an explicit boot-time Qdrant probe: if the
  // collection is missing/incompatible the gateway must exit with a clear
  // error rather than running in a half-broken state where `/tools/memory/*`
  // would fail later (concept §25). We do this before `app.ready()` so the
  // failure surfaces before any route handler can accept a request. Skipped
  // entirely when memory is deactivated — there is no collection to verify.
  if (config.features.memory && app.services.qdrant !== undefined) {
    await app.services.qdrant.ensureCollection();
  }

  // Concept §20 requires the OpenAPI spec to be built once during startup so
  // the first caller does not pay the build latency and schema errors fail
  // boot rather than the first incoming request. `buildApp` itself stays
  // mutable for tests that want to register extra routes after construction.
  await app.ready();
  app.swagger();

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "received shutdown signal");
    // Hard cap on graceful shutdown — Kubernetes/Docker send SIGKILL after
    // `terminationGracePeriodSeconds`, so we mirror the §17 request budget
    // here (concept §19): pending requests get up to `REQUEST_TIMEOUT_MS` to
    // finish, then we force-exit. The timer intentionally keeps the event
    // loop alive: if `app.close()` ever hangs without holding any handles
    // open, an `.unref()`ed timer would never fire and the process would
    // exit prematurely with the wrong code. The happy and error paths below
    // both `clearTimeout` the timer, so this only matters under a true hang.
    const forceExitTimer = setTimeout(() => {
      // Best-effort Pino log first — it might still flush before exit.
      app.log.error({ timeoutMs: config.requestTimeoutMs }, "shutdown timed out — forcing exit");
      // Synchronous backup diagnostic on stderr: Pino's worker stream may not
      // flush before `process.exit(1)` when `app.close()` is hanging, which
      // would swallow the diagnostic exactly when it matters most. A direct
      // `process.stderr.write` bypasses the worker and lands in the parent
      // process's stderr immediately.
      process.stderr.write(
        `${JSON.stringify({
          level: "fatal",
          msg: "shutdown timed out — forcing exit",
          timeoutMs: config.requestTimeoutMs,
        })}\n`,
      );
      exitProcess(1);
    }, config.requestTimeoutMs);
    try {
      await app.close();
      clearTimeout(forceExitTimer);
      exitProcess(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      app.log.error({ err: error }, "error during shutdown");
      exitProcess(1);
    }
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

// Only auto-start when this module is executed as the entry point (e.g.
// `node dist/server.js` or `tsx src/server.ts`); imports from tests stay
// inert.
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await start();
  } catch (error) {
    console.error(error);
    exitProcess(1);
  }
}
