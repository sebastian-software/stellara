/**
 * MCP-only flat wrapper schemas used by `tools/list` for tools whose REST
 * payload is a discriminated union. The MCP spec rejects union roots
 * (`anyOf`/`oneOf`) — every `Tool.inputSchema` must serialise as a
 * top-level `object`. The wrappers list every field optionally; structural
 * validation still runs against the canonical discriminated unions in
 * `./browser.ts` and `./memory.ts` through the adapter layer.
 *
 * Extracted from `./mcp.ts` so the registry in `./mcp-tools.ts` can
 * import these schemas without creating a runtime import cycle.
 */
import { z } from "zod/v4";

import { memoryFilterSchema } from "./memory.js";

/**
 * MCP-only `memory_delete` input. The REST counterpart is a
 * discriminated union (`{id}` XOR `{filter}`); this wrapper uses both
 * fields optional plus an XOR `refine`, and the adapter branches on
 * which field is set before calling `qdrant.delete`.
 */
export const mcpMemoryDeleteRequestSchema = z
  .object({
    id: z.uuidv4().optional(),
    filter: memoryFilterSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.id !== undefined) !== (value.filter !== undefined),
    "Provide exactly one of `id` or `filter` (concept §8.8).",
  );

export const mcpBrowserCookiesRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.enum(["get", "set", "clear"]),
    urls: z.array(z.string().min(1)).optional(),
    cookies: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export const mcpBrowserStorageRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.enum(["get", "set", "clear"]),
    target: z.enum(["local", "session"]).optional(),
    keys: z.array(z.string().min(1)).optional(),
    entries: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const mcpBrowserHarRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.enum(["start", "stop"]),
  })
  .strict();

export const mcpBrowserTabsRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.enum(["list", "switch", "close", "new"]),
    index: z.number().int().min(0).optional(),
    url: z.string().min(1).optional(),
  })
  .strict();
