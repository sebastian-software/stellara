/** MCP server factory for the modern 2026 protocol edge. */
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  type AuthInfo,
  type CallToolResult,
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";

import { AppError, toErrorResponse } from "../../errors.js";
import { STELLARA_SUITE_OVERVIEW } from "../../llm-instructions.js";
import { enabledTools, type ToolRegistryEntry } from "../../schemas/mcp.js";
import { TOOL_ADAPTERS, type ToolCallContext } from "./tools-adapters.js";

/** Modern revision served by the per-request MCP handler. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

const CATALOG_CACHE_HINT = { cacheScope: "private", ttlMs: 300_000 } as const;

/** Token-free request data carried through the SDK's `AuthInfo.extra` seam. */
export type StellaraMcpRequestContext = {
  request: FastifyRequest;
  userId: string;
};

function readStellaraContext(ctx: McpRequestContext): StellaraMcpRequestContext {
  const value = ctx.authInfo?.extra?.stellara;
  if (typeof value !== "object" || value === null) {
    throw new Error("Stellara MCP request context missing");
  }
  const candidate = value as Partial<StellaraMcpRequestContext>;
  if (typeof candidate.userId !== "string" || candidate.request === undefined) {
    throw new Error("Stellara MCP request context invalid");
  }
  return { request: candidate.request, userId: candidate.userId };
}

function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(toErrorResponse(error)) }],
    isError: true,
  };
}

function successResult(
  requestContext: StellaraMcpRequestContext,
  entry: ToolRegistryEntry,
  output: unknown,
): CallToolResult {
  const validated = entry.outputSchema.safeParse(output);
  if (!validated.success) {
    requestContext.request.log.error(
      { issues: validated.error.issues, tool: entry.name },
      "mcp tool output validation failed",
    );
    return errorResult(new Error("Tool execution failed"));
  }
  return {
    content: [{ type: "text", text: JSON.stringify(validated.data) }],
    structuredContent: validated.data,
  };
}

async function executeTool(
  requestContext: StellaraMcpRequestContext,
  entry: ToolRegistryEntry,
  args: unknown,
): Promise<CallToolResult> {
  const app = requestContext.request.server;
  const adapter = TOOL_ADAPTERS.get(entry.name);
  if (adapter === undefined) {
    requestContext.request.log.error({ tool: entry.name }, "mcp tool adapter missing");
    return errorResult(new Error("Tool execution failed"));
  }

  const toolContext: ToolCallContext = {
    app,
    request: requestContext.request,
    userId: requestContext.userId,
  };
  try {
    const output = await adapter(toolContext, args);
    return successResult(requestContext, entry, output);
  } catch (error) {
    if (!AppError.is(error)) {
      requestContext.request.log.error(
        { err: error, tool: entry.name },
        "mcp tool execution failed",
      );
    }
    return errorResult(error);
  }
}

function buildMcpServer(app: FastifyInstance, ctx: McpRequestContext): McpServer {
  const requestContext = readStellaraContext(ctx);
  const server = new McpServer(
    { name: "stellara", version: app.config.appVersion },
    {
      cacheHints: {
        "server/discover": CATALOG_CACHE_HINT,
        "tools/list": CATALOG_CACHE_HINT,
      },
      instructions: STELLARA_SUITE_OVERVIEW,
    },
  );

  for (const entry of enabledTools(app.config.features)) {
    server.registerTool(
      entry.name,
      {
        annotations: entry.annotations,
        description: entry.description,
        inputSchema: entry.inputSchema,
        outputSchema: entry.outputSchema,
        title: entry.annotations?.title,
      },
      async (args) => executeTool(requestContext, entry, args),
    );
  }
  return server;
}

/** Creates the process-wide strict handler for modern protocol requests. */
export function createStellaraMcpHandler(app: FastifyInstance): McpHttpHandler {
  return createMcpHandler((ctx) => buildMcpServer(app, ctx), {
    legacy: "reject",
    responseMode: "json",
    onerror(error) {
      app.log.error({ err: error }, "mcp protocol error");
    },
  });
}

/** Builds the SDK AuthInfo without copying the bearer token. */
export function createSdkAuthInfo(request: FastifyRequest): AuthInfo {
  const auth = request.mcpAuth;
  if (auth === undefined) {
    throw new Error("MCP auth context missing");
  }
  return {
    token: "",
    clientId: auth.clientId,
    scopes: [...auth.scopes],
    expiresAt: auth.expiresAt,
    resource: new URL(`${request.server.config.publicBaseUrl}/mcp`),
    extra: {
      stellara: {
        request,
        userId: auth.userId,
      } satisfies StellaraMcpRequestContext,
    },
  };
}
