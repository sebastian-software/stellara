/**
 * Liveness (`/health`) and readiness (`/ready`) routes per concept §15.
 *
 * Both endpoints are on the public allowlist in `src/auth.ts` so the
 * Docker healthcheck and the reverse proxy can probe them without a
 * bearer token. Schemas are declared with Zod so `@fastify/swagger`
 * picks them up via the Zod transform registered in `src/routes/openapi.ts`.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { z } from "zod/v4";

/** Response body for `GET /health` per concept §15.1. */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("stellara"),
  version: z.string().min(1),
});

/** Status values reported per dependency in `/ready` (§15.2). */
const probeStatusSchema = z.enum(["ok", "error"]);

/** Aggregate status for `/ready` — `"error"` if any probe failed. */
const readyStatusSchema = z.enum(["ok", "error"]);

/**
 * Response body for `GET /ready` per concept §15.2.
 *
 * Each known dependency (`exa`, `firecrawl`, `qdrant`, `embeddings`) gets a
 * per-probe status; the aggregate `status` flips to `"error"` when any probe
 * fails so reverse proxies can drop the gateway from rotation.
 */
export const readyResponseSchema = z.object({
  status: readyStatusSchema,
  checks: z.record(z.string(), probeStatusSchema),
});

/** Per-probe timeout for the readiness endpoint (§15.2). */
const PROBE_TIMEOUT_MS = 2000;

type ProbeFn = (signal: AbortSignal) => Promise<void>;

/** Runs a single probe with a hard timeout, returning `"ok"` or `"error"`. */
async function runProbe(probe: ProbeFn): Promise<"error" | "ok"> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PROBE_TIMEOUT_MS);
  try {
    await probe(controller.signal);
    return "ok";
  } catch {
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collects probe functions for every backend the configuration activated.
 *
 * Deactivated features are skipped — their absence in the response signals
 * "not configured" rather than "broken", which is what `/ready` should report
 * for an intentionally minimal deployment. The OAuth storage is always
 * probed (mandatory subsystem) so a corrupt SQLite file or unmounted volume
 * surfaces here before a real OAuth flow lands on it.
 */
function buildProbeMap(app: FastifyInstance): Array<readonly [string, ProbeFn]> {
  const probes: Array<readonly [string, ProbeFn]> = [];
  const { exa, firecrawl, qdrant, embeddings, playwright, oauth } = app.services;
  if (exa !== undefined) probes.push(["exa", async (signal) => exa.probe(signal)]);
  probes.push(["firecrawl", async (signal) => firecrawl.probe(signal)]);
  if (qdrant !== undefined) probes.push(["qdrant", async (signal) => qdrant.probe(signal)]);
  if (embeddings !== undefined) {
    probes.push(["embeddings", async (signal) => embeddings.probe(signal)]);
  }
  if (playwright !== undefined) {
    // Cheap probe — does not spawn Chromium, just verifies the client is
    // still connected when a browser has already been launched. The probe
    // is synchronous on the inside; the async wrapper keeps the probe
    // signature uniform.
    probes.push([
      "playwright",
      async () => {
        await Promise.resolve();
        playwright.probe();
      },
    ]);
  }
  probes.push(["oauth_storage", async () => probeOAuthStorage(oauth.storage)]);
  return probes;
}

/** Smoke-tests the OAuth SQLite handle with a `SELECT 1` round-trip. */
async function probeOAuthStorage(
  storage: FastifyInstance["services"]["oauth"]["storage"],
): Promise<void> {
  await Promise.resolve();
  storage.db.prepare("SELECT 1").get();
}

/** Executes all probes in parallel and returns the aggregated checks map. */
async function collectProbeChecks(
  probes: Array<readonly [string, ProbeFn]>,
): Promise<{ checks: Record<string, "error" | "ok">; allOk: boolean }> {
  const settled = await Promise.all(
    probes.map(async ([name, probe]) => {
      const status = await runProbe(probe);
      return [name, status] as const;
    }),
  );

  const checks: Record<string, "error" | "ok"> = {};
  let allOk = true;
  for (const [name, status] of settled) {
    checks[name] = status;
    if (status === "error") allOk = false;
  }
  return { checks, allOk };
}

/** Handler implementation for `GET /ready`. */
async function readyHandler(app: FastifyInstance, reply: FastifyReply): Promise<void> {
  const { checks, allOk } = await collectProbeChecks(buildProbeMap(app));
  const body = { status: allOk ? "ok" : "error", checks } as const;
  void reply.code(allOk ? 200 : 503).send(body);
}

/**
 * Registers `GET /health` and `GET /ready` on the given Fastify instance.
 * Both routes are unauthenticated — the auth hook in `src/auth.ts` exempts
 * the public allowlist before invoking handlers.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/health",
    schema: {
      operationId: "getHealth",
      tags: ["public"],
      summary: "Liveness probe",
      description: "Returns 200 as long as the process is up (§15.1).",
      response: { 200: healthResponseSchema },
    },
    handler(_request, reply) {
      void reply.code(200).send({
        status: "ok",
        service: "stellara",
        version: app.config.appVersion,
      });
    },
  });

  typed.route({
    method: "GET",
    url: "/ready",
    schema: {
      operationId: "getReady",
      tags: ["public"],
      summary: "Readiness probe",
      description:
        "Probes Exa, Firecrawl, Qdrant and the embeddings provider in parallel with a 2 s per-probe timeout (§15.2).",
      response: {
        200: readyResponseSchema,
        503: readyResponseSchema,
      },
    },
    async handler(_request, reply) {
      await readyHandler(app, reply);
    },
  });
}
