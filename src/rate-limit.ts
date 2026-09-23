import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Rate-limit plugin wiring for Stellara (concept §22).
 *
 * Two layered buckets:
 *
 *  1. {@link registerUnauthRateLimit} — runs BEFORE the auth hook and limits
 *     requests without a usable Bearer header by `request.ip`. Invalid or
 *     revoked Bearer attempts bypass this tier and the per-user tier.
 *  2. {@link registerRateLimit} — `@fastify/rate-limit` with a per-user key,
 *     registered AFTER the auth hook.
 *
 * Spoofing resistance of the IP key depends on the trustProxy CIDR
 * restriction (concept §7.1).
 */
import fastifyRateLimit from "@fastify/rate-limit";

import type { Config } from "./config.js";

import { hasBearerHeader, isPublicRequest } from "./auth.js";
import { AppError, ErrorCode, toErrorResponse } from "./errors.js";

/** Key used by the rate-limit bucket — userId if authenticated, IP otherwise. */
function rateLimitKey(request: FastifyRequest): string {
  return request.userId ?? request.ip;
}

/**
 * Registers `@fastify/rate-limit` with the project-wide defaults derived
 * from {@link Config}. Public endpoints (§6.4) are excluded via `allowList`.
 */
export async function registerRateLimit(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(fastifyRateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    keyGenerator: rateLimitKey,
    allowList: (request) => isPublicRequest(request),
    errorResponseBuilder(request, context) {
      // Audit-trail entry for rate-limit hits (§21). The child logger already
      // carries the userId (or clientIp fallback), so logging `context.key`
      // separately would only duplicate that field.
      request.log.warn({ retryAfter: context.after }, "rate limit exceeded");
      // The plugin throws whatever this builder returns. Returning an
      // AppError lets the global error handler render the §16.1 envelope.
      // `Retry-After` is set by the plugin automatically.
      return new AppError({
        code: ErrorCode.RATE_LIMITED,
        message: `Rate limit exceeded, retry in ${context.after}`,
        details: { retryAfter: context.after },
      });
    },
  });
}

/** Per-IP counter entry used by the unauth rate-limit hook. */
type UnauthCounter = { count: number; resetAt: number };

/** Outcome of {@link recordUnauthHit} — either "ok" or "retry after N seconds". */
type UnauthDecision = { allowed: false; retryAfterSeconds: number } | { allowed: true };

/** Arguments accepted by {@link recordUnauthHit}. */
type RecordUnauthHitArgs = {
  counters: Map<string, UnauthCounter>;
  ip: string;
  now: number;
  max: number;
  windowMs: number;
};

/**
 * Updates the per-IP counter for `ip` and decides whether the request may
 * proceed. Resets a counter lazily when its window has elapsed; counters are
 * never proactively pruned because the active set scales with the number of
 * misbehaving IPs in any 60-second window — well within a Map's footprint.
 */
function recordUnauthHit(args: RecordUnauthHitArgs): UnauthDecision {
  const { counters, ip, now, max, windowMs } = args;
  const entry = counters.get(ip);
  if (entry === undefined || now >= entry.resetAt) {
    counters.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  entry.count += 1;
  if (entry.count <= max) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}

/**
 * Renders the §16.1 RATE_LIMITED envelope on `reply` with HTTP 429 and the
 * `Retry-After` header set in seconds. Mirrors the shape that
 * `@fastify/rate-limit`'s `errorResponseBuilder` produces for the per-user
 * tier so clients see a consistent response across both buckets.
 */
function sendUnauthRateLimited(
  request: FastifyRequest,
  reply: FastifyReply,
  retryAfterSeconds: number,
): void {
  request.log.warn(
    { retryAfter: retryAfterSeconds, clientIp: request.ip },
    "unauth rate limit exceeded",
  );
  void reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send(
      toErrorResponse(
        new AppError({
          code: ErrorCode.RATE_LIMITED,
          message: `Rate limit exceeded, retry in ${retryAfterSeconds}`,
          details: { retryAfter: retryAfterSeconds },
        }),
      ),
    );
}

/**
 * Registers an `onRequest` hook that rate-limits unauthenticated requests by
 * `request.ip` BEFORE the auth hook can reject them with 401. This tier does
 * not count attempts that carry a Bearer header; invalid or revoked Bearer
 * values are rejected by auth before the per-user limiter runs.
 *
 * Implementation note: the counter map lives in-process. It does NOT survive
 * a restart and does NOT span replicas. That is acceptable for Stellara's
 * supported single-instance deployment; a shared backing store is required
 * before horizontal scaling.
 *
 * Public paths (§6.4) and requests that already carry a bearer header are
 * waved through — the per-user limiter takes over once auth resolves.
 */
export function registerUnauthRateLimit(app: FastifyInstance, config: Config): void {
  const counters = new Map<string, UnauthCounter>();
  const max = config.unauthRateLimitMax;
  const windowMs = config.unauthRateLimitWindowMs;

  app.addHook("onRequest", (request, reply, done) => {
    if (isPublicRequest(request) || hasBearerHeader(request.headers.authorization)) {
      done();
      return;
    }

    const decision = recordUnauthHit({
      counters,
      ip: request.ip,
      now: Date.now(),
      max,
      windowMs,
    });
    if (decision.allowed) {
      done();
      return;
    }
    sendUnauthRateLimited(request, reply, decision.retryAfterSeconds);
  });
}
