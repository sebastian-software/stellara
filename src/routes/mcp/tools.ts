/**
 * MCP `tools/list` + `tools/call` handlers.
 *
 * Both methods rely on the registry in {@link `../../schemas/mcp.ts`}; the
 * actual dispatch table lives in {@link ./tools-adapters} so this file stays
 * within the per-file line budget. Both transports (REST and MCP) consume
 * the same `runX` tool layer in `src/tools/` so the surface cannot drift.
 */
import { z, type ZodError } from "zod/v4";

import type { ConfigFeatures } from "../../config.js";
import type { ToolRegistryEntry } from "../../schemas/mcp.js";

import { AppError, ErrorCode, toErrorResponse } from "../../errors.js";
import { enabledTools, findTool, inputJsonSchema, outputJsonSchema } from "../../schemas/mcp.js";
import {
  jsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcId,
  type JsonRpcResponse,
  jsonRpcSuccess,
  sanitizeZodIssues,
} from "./json-rpc.js";
import { TOOL_ADAPTERS, type ToolCallContext, type ToolCallResult } from "./tools-adapters.js";

export type { ToolCallContext } from "./tools-adapters.js";

/** Wire schema for `tools/call` params. */
const toolsCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
});

/**
 * Cache of the JSON-Schema projection per tool name.
 *
 * `inputJsonSchema` performs a non-trivial Zod→JSON-Schema conversion. The
 * canonical Stellara tools never change at runtime, so caching the
 * conversion keeps `tools/list` cheap while still allowing the surfaced
 * payload to be filtered against the configured feature flags on every
 * request.
 */
const TOOL_PAYLOAD_CACHE: ReadonlyMap<string, Record<string, unknown>> = new Map(
  enabledTools({
    exa: true,
    firecrawl: true,
    embeddings: true,
    memory: true,
    fetch: true,
    playwright: true,
    domain: true,
  }).map((entry) => {
    // `annotations` is an MCP 2025-03-26+ optional surface (plan 0011).
    // Omit the key entirely when no annotations are configured so the
    // payload stays minimal for tools that genuinely have no hints.
    const payload: Record<string, unknown> = {
      name: entry.name,
      description: entry.description,
      inputSchema: inputJsonSchema(entry),
      outputSchema: outputJsonSchema(entry),
    };
    if (entry.annotations !== undefined) {
      payload.annotations = entry.annotations;
    }
    return [entry.name, payload];
  }),
);

/**
 * Returns the `tools/list` payload (concept §9) filtered to the tools whose
 * feature is currently active. Disabled tools are removed from both the
 * advertised catalog and `tools/call` dispatch.
 */
export function listTools(features: ConfigFeatures): { tools: Array<Record<string, unknown>> } {
  const tools: Array<Record<string, unknown>> = [];
  for (const entry of enabledTools(features)) {
    const cached = TOOL_PAYLOAD_CACHE.get(entry.name);
    if (cached !== undefined) tools.push(cached);
  }
  return { tools };
}

/** Encodes a tool-call result per MCP's `tools/call` response shape. */
function encodeToolResult(output: ToolCallResult): Record<string, unknown> {
  // MCP 2024-11-05+ accepts `structuredContent` alongside the text envelope.
  // Older clients fall back to `content[0].text`, so we emit both. Typing
  // `output` as the {@link ToolCallResult} union makes drift between the
  // dispatcher and the shared `runX` tool layer a compile-time error.
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

type ZodValidationError = ZodError;

function isZodValidationError(error: unknown): error is ZodValidationError {
  return error instanceof z.ZodError;
}

async function runToolCall(
  ctx: ToolCallContext,
  entry: ToolRegistryEntry,
  args: unknown,
): Promise<ToolCallResult> {
  const adapter = TOOL_ADAPTERS.get(entry.name);
  if (adapter === undefined) {
    // Defensive — the registry lookup in `handleToolsCall` already filters
    // unknown names, so this branch only fires when the registry and the
    // dispatch table fall out of sync.
    throw new AppError({
      code: ErrorCode.INTERNAL_ERROR,
      message: `MCP tool "${entry.name}" has no adapter wired up`,
    });
  }
  return adapter(ctx, args);
}

function encodeToolError(error: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(toErrorResponse(error)) }],
    isError: true,
  };
}

function toolCallError(ctx: ToolCallContext, id: JsonRpcId, error: unknown): JsonRpcResponse {
  if (isZodValidationError(error)) {
    return jsonRpcError(id, {
      code: JsonRpcErrorCode.INVALID_PARAMS,
      message: "Invalid params",
      data: { issues: sanitizeZodIssues(error.issues) },
    });
  }
  if (!AppError.is(error)) ctx.request.log.error({ err: error }, "MCP tool call failed");
  return jsonRpcSuccess(id, encodeToolError(error));
}

/** Handles the JSON-RPC `tools/call` method, dispatching to {@link runToolCall}. */
export async function handleToolsCall(
  ctx: ToolCallContext,
  id: JsonRpcId,
  params: unknown,
): Promise<JsonRpcResponse> {
  const parsedParams = toolsCallParamsSchema.safeParse(params ?? {});
  if (!parsedParams.success) {
    return jsonRpcError(id, {
      code: JsonRpcErrorCode.INVALID_PARAMS,
      message: "Invalid params",
      data: { issues: sanitizeZodIssues(parsedParams.error.issues) },
    });
  }
  const entry = findTool(parsedParams.data.name, ctx.app.config.features);
  if (entry === undefined) {
    return jsonRpcError(id, {
      code: JsonRpcErrorCode.METHOD_NOT_FOUND,
      message: "Unknown tool",
      data: { tool: parsedParams.data.name },
    });
  }
  try {
    const output = await runToolCall(ctx, entry, parsedParams.data.arguments);
    return jsonRpcSuccess(id, encodeToolResult(output));
  } catch (error) {
    return toolCallError(ctx, id, error);
  }
}
