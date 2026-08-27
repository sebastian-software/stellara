/**
 * MCP tool-registry types, helpers and re-exports (concept §9).
 *
 * The actual registry (`MCP_TOOLS`) lives in `./mcp-tools.ts` so this
 * file stays inside the per-file line cap; the wrapper schemas used by
 * the registry live in `./mcp-wrappers.ts`. Consumers (`routes/mcp/*`,
 * `tests/*`) import everything from `./mcp.js` — the split is an
 * internal organisation detail.
 *
 * JSON-Schema conversion runs through Zod 4's built-in
 * {@link z.toJSONSchema}; `fastify-type-provider-zod`'s
 * `jsonSchemaTransform` operates on Fastify routes rather than standalone
 * schemas, so it is not a drop-in fit here.
 */
import { z } from "zod/v4";

import type { ConfigFeatures } from "../config.js";

import { MCP_TOOLS } from "./mcp-tools.js";

// Re-export the registry and the flat MCP-only wrappers so callers can
// keep importing from `./mcp.js`.
export { MCP_TOOLS } from "./mcp-tools.js";
export {
  mcpBrowserCookiesRequestSchema,
  mcpBrowserHarRequestSchema,
  mcpBrowserStorageRequestSchema,
  mcpBrowserTabsRequestSchema,
  mcpMemoryDeleteRequestSchema,
} from "./mcp-wrappers.js";

/** Zod schema accepted as an MCP tool's input — always an object at the top. */
export type McpInputSchema = z.ZodType;

/** Zod schema describing the structured result advertised by an MCP tool. */
export type McpOutputSchema = z.ZodType;

/**
 * Feature flag that gates whether a tool is exposed via MCP.
 *
 * Aligns 1:1 with `ConfigFeatures` so the dispatcher can hide tools whose
 * backend is not configured. Tools that depend on multiple features list the
 * narrowest one — `web_search` only needs Exa, while `web_research` could
 * also benefit from Firecrawl but degrades gracefully without it.
 */
export type ToolFeature = keyof ConfigFeatures;

/**
 * MCP tool annotations (spec 2025-03-26+). Hints for clients to render
 * appropriate UI (confirm prompts, read-only badges) — never enforcement.
 * Older MCP clients ignore the field.
 */
export type ToolAnnotations = {
  /** Tool does not modify state. */
  readOnlyHint?: boolean;
  /** Tool may perform destructive operations (deletes, overwrites). */
  destructiveHint?: boolean;
  /** Calling with the same input twice has the same effect as once. */
  idempotentHint?: boolean;
  /** Tool interacts with external systems / open world. */
  openWorldHint?: boolean;
  /** Human-friendly UI label for the tool. */
  title?: string;
};

/** Single entry in the MCP tool registry. */
export type ToolRegistryEntry = {
  /** Canonical MCP tool name from concept §9 (snake_case, area prefix). */
  name: string;
  /**
   * Multi-sentence description (2-4 sentences) used by MCP clients and
   * mirrored into OpenAPI route-schema `description` via
   * {@link describeMcpTool}. Includes cross-references to sibling tools
   * where the choice is non-obvious.
   */
  description: string;
  /** Feature flag that must be active for this tool to be exposed. */
  feature: ToolFeature;
  /** Zod schema validating the tool's arguments. */
  inputSchema: McpInputSchema;
  /** Canonical REST response schema reused for MCP `structuredContent`. */
  outputSchema: McpOutputSchema;
  /** Optional MCP 2025-03-26+ annotations — see {@link ToolAnnotations}. */
  annotations?: ToolAnnotations;
};

/** Returns the subset of `MCP_TOOLS` whose feature flag is active. */
export function enabledTools(features: ConfigFeatures): readonly ToolRegistryEntry[] {
  return MCP_TOOLS.filter((entry) => features[entry.feature]);
}

/**
 * Returns the registry entry for `name`, or `undefined` when the name is
 * unknown or the matching feature is currently deactivated. Both cases map
 * onto the same MCP `METHOD_NOT_FOUND` response so a client cannot tell
 * "tool removed in v2" from "tool not enabled in this deployment".
 */
export function findTool(name: string, features: ConfigFeatures): ToolRegistryEntry | undefined {
  return enabledTools(features).find((entry) => entry.name === name);
}

/**
 * Returns the canonical MCP description for `name` so REST route schemas
 * can mirror it into OpenAPI (plan 0011). Throws on unknown names —
 * surfaces typos as a build-time failure rather than a silently empty
 * description.
 */
export function describeMcpTool(name: string): string {
  const entry = MCP_TOOLS.find((t) => t.name === name);
  if (entry === undefined) {
    throw new Error(`Unknown MCP tool: ${name}`);
  }
  return entry.description;
}

/**
 * Converts a tool's Zod input schema to a JSON-Schema object suitable for
 * MCP's `tools/list` response. Uses Zod 4's built-in `toJSONSchema` so we
 * avoid an additional runtime dependency.
 *
 * `unrepresentable: "any"` keeps wide types like `z.unknown()` representable
 * (mirrors how `fastify-type-provider-zod` configures the same call), and
 * `target: "draft-2020-12"` matches the MCP spec's expected JSON-Schema
 * dialect.
 */
export function inputJsonSchema(entry: ToolRegistryEntry): Record<string, unknown> {
  return z.toJSONSchema(entry.inputSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  });
}

/** Converts a tool's canonical output schema to MCP JSON Schema 2020-12. */
export function outputJsonSchema(entry: ToolRegistryEntry): Record<string, unknown> {
  return z.toJSONSchema(entry.outputSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  });
}
