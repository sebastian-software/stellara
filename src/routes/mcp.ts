/**
 * MCP route registration (`GET /mcp` → 405, `POST /mcp` → JSON-RPC).
 *
 * Implements Phase 2 of the MCP rollout: a stateless Streamable-HTTP transport
 * that exposes the eight Stellara tools via JSON-RPC. Auth, rate-limit and
 * logging are inherited from the Fastify plumbing in `src/server.ts`; the
 * route handler itself only parses, dispatches and serializes JSON-RPC
 * envelopes. Heavy lifting lives in {@link `./mcp-dispatch.ts`} which
 * delegates to the shared tool layer in `src/tools/`.
 *
 * `/mcp` is intentionally hidden from the OpenAPI document (concept §20): the
 * spec describes the REST surface only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  type NodeMcpRequestHandler,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import { isLegacyRequest, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { requireUserId } from "../auth.js";
import { AppError, ErrorCode, toErrorResponse } from "../errors.js";
import { dispatchMethod, JsonRpcErrorCode, parseJsonRpcEnvelope } from "./mcp-dispatch.js";
import { isSupportedProtocolVersion, negotiateProtocolVersion } from "./mcp/initialize.js";
import {
  createSdkAuthInfo,
  createStellaraMcpHandler,
  MODERN_PROTOCOL_VERSION,
} from "./mcp/server.js";

const MCP_TELEMETRY_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "server/discover",
  "tools/call",
  "tools/list",
]);

type ProtocolEra = "legacy" | "modern";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...value }
    : undefined;
}

function telemetryMethod(body: unknown): string {
  const method = asRecord(body)?.method;
  return typeof method === "string" && MCP_TELEMETRY_METHODS.has(method) ? method : "unknown";
}

function modernTelemetryVersion(request: FastifyRequest): string {
  if (request.headers["mcp-protocol-version"] !== MODERN_PROTOCOL_VERSION) return "unknown";
  const params = asRecord(asRecord(request.body)?.params);
  const meta = asRecord(params?._meta);
  return meta?.[PROTOCOL_VERSION_META_KEY] === MODERN_PROTOCOL_VERSION
    ? MODERN_PROTOCOL_VERSION
    : "unknown";
}

function legacyTelemetryVersion(request: FastifyRequest): string {
  const claimed = request.headers["mcp-protocol-version"];
  return typeof claimed === "string" && isSupportedProtocolVersion(claimed) ? claimed : "unknown";
}

function logMcpRequest(
  request: FastifyRequest,
  protocolEra: ProtocolEra,
  protocolVersion: string,
): void {
  request.log.info(
    {
      event: "mcp_request_classified",
      mcpMethod: telemetryMethod(request.body),
      protocolEra,
      protocolVersion,
    },
    "mcp request classified",
  );
}

function publicOrigin(request: FastifyRequest): string | undefined {
  try {
    return new URL(`${request.protocol}://${request.host}`).origin;
  } catch {
    return undefined;
  }
}

function hasValidPublicOrigin(request: FastifyRequest): boolean {
  const expected = new URL(request.server.config.publicBaseUrl).origin;
  if (publicOrigin(request) !== expected) return false;
  const browserOrigin = request.headers.origin;
  if (browserOrigin === undefined) return true;
  try {
    return new URL(browserOrigin).origin === expected;
  } catch {
    return false;
  }
}

function rejectInvalidOrigin(reply: FastifyReply): void {
  void reply.code(421).send({
    jsonrpc: "2.0",
    id: null,
    error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: "Invalid request origin" },
  });
}

async function dispatchLegacyRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = parseJsonRpcEnvelope(request.body);
  const protocolVersion =
    !("error" in parsed) && parsed.method === "initialize"
      ? negotiateProtocolVersion(parsed.params)
      : legacyTelemetryVersion(request);
  logMcpRequest(request, "legacy", protocolVersion);
  if ("error" in parsed) {
    void reply.code(200).send(parsed);
  } else if (parsed.isNotification) {
    void reply.code(202).send();
  } else {
    const response = await dispatchMethod(request, requireUserId(request), parsed);
    void reply.code(200).send(response);
  }
}

async function serveMcpPost(
  request: FastifyRequest,
  reply: FastifyReply,
  nodeHandler: NodeMcpRequestHandler,
): Promise<void> {
  if (!hasValidPublicOrigin(request)) {
    rejectInvalidOrigin(reply);
    return;
  }
  const webRequest = await toWebRequest(request.raw, request.body);
  if (await isLegacyRequest(webRequest, request.body)) {
    await dispatchLegacyRequest(request, reply);
    return;
  }
  logMcpRequest(request, "modern", modernTelemetryVersion(request));
  const raw = request.raw as { auth?: ReturnType<typeof createSdkAuthInfo> } & typeof request.raw;
  raw.auth = createSdkAuthInfo(request);
  void reply.hijack();
  await nodeHandler(raw, reply.raw, request.body);
}

/** Registers `GET /mcp` (405 Method Not Allowed). */
function registerMcpGetRoute(app: FastifyInstance): void {
  app.route({
    method: "GET",
    url: "/mcp",
    schema: { hide: true },
    handler(_request, reply) {
      const error = new AppError({
        code: ErrorCode.BAD_REQUEST,
        message: "GET /mcp not supported in v1 (stateless MCP, see concept §9)",
      });
      // The §16.2 catalog does not carry a dedicated METHOD_NOT_ALLOWED code,
      // so we use BAD_REQUEST as the closest semantic match and ship the
      // §16.1 envelope with HTTP 405 + `Allow: POST` for protocol-correct
      // method discovery.
      void reply.code(405).header("allow", "POST").send(toErrorResponse(error));
    },
  });
}

/** Registers `POST /mcp` — JSON-RPC dispatcher. */
function registerMcpPostRoute(app: FastifyInstance): void {
  const mcpHandler = createStellaraMcpHandler(app);
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror(error) {
      app.log.error({ err: error }, "mcp node adapter error");
    },
  });
  app.addHook("onClose", async () => mcpHandler.close());
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.route({
    method: "POST",
    url: "/mcp",
    // JSON-RPC envelopes vary by method, so we deliberately do NOT enforce the
    // body shape via Fastify's Zod compiler — that would force every malformed
    // envelope through the REST `VALIDATION_ERROR` path rather than the
    // JSON-RPC `INVALID_REQUEST` envelope the spec mandates. We validate
    // manually inside the handler instead.
    schema: { hide: true, body: z.unknown() },
    async handler(request, reply) {
      await serveMcpPost(request, reply, nodeHandler);
    },
    errorHandler(error, _request, reply) {
      // Map Fastify-level HTTP errors onto JSON-RPC envelopes so MCP clients
      // never see Stellara's REST §16.1 error envelope on the /mcp surface.
      const statusCode = typeof error.statusCode === "number" ? error.statusCode : undefined;
      // Body-parser failures (malformed JSON, wrong content-type) → PARSE_ERROR.
      if (statusCode === 400) {
        void reply.code(200).send({
          jsonrpc: "2.0",
          id: null,
          error: { code: JsonRpcErrorCode.PARSE_ERROR, message: "Parse error" },
        });
        return;
      }
      // Body too large (default 1 MB, see `DEFAULT_BODY_LIMIT` in server.ts) →
      // INVALID_REQUEST so the client sees a structured JSON-RPC failure.
      if (statusCode === 413) {
        void reply.code(200).send({
          jsonrpc: "2.0",
          id: null,
          error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: "Request body too large" },
        });
        return;
      }
      // Anything else — including aborts and unexpected exceptions — bubbles
      // back up to the global error handler registered in `src/server.ts` by
      // rethrowing here.
      throw error;
    },
  });
}

/** Registers both MCP routes on the given Fastify instance. */
export function registerMcpRoute(app: FastifyInstance): void {
  registerMcpGetRoute(app);
  registerMcpPostRoute(app);
}
