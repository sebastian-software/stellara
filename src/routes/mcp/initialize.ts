/**
 * MCP `initialize` method handler and protocol-version negotiation.
 *
 * Implements concept §9 plus the MCP spec's version-negotiation rules: when
 * the client requests a supported protocol version we echo it; otherwise we
 * reply with the server's preferred (newest) version and let the client
 * choose whether to continue.
 */
import type { FastifyInstance } from "fastify";

import { z } from "zod/v4";

import { STELLARA_SUITE_OVERVIEW } from "../../llm-instructions.js";

/** Wire schema for the `initialize` params we care about. */
const initializeParamsSchema = z.looseObject({
  protocolVersion: z.string().optional(),
});

/**
 * MCP protocol versions Stellara's server speaks. Listed newest-first; the
 * dispatcher echoes the client's version when supported and otherwise falls
 * back to the newest entry (concept §9 + MCP spec "version negotiation").
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

/** Server's preferred protocol version when no negotiation hint is supplied. */
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Resolves untrusted initialize params onto a supported, low-cardinality version. */
export function negotiateProtocolVersion(
  params: unknown,
): (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] {
  const parsed = initializeParamsSchema.safeParse(params ?? {});
  const requested = parsed.success ? parsed.data.protocolVersion : undefined;
  return isSupportedProtocolVersion(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
}

/** Type-guard checking whether `value` is one of the supported protocol versions. */
export function isSupportedProtocolVersion(
  value: string | undefined,
): value is (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] {
  if (value === undefined) return false;
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** Builds the `initialize` payload, negotiating the protocol version per MCP spec. */
export function initialize(app: FastifyInstance, params: unknown): Record<string, unknown> {
  // The MCP spec says the server picks the version: if the client asks for
  // one we support we echo it; otherwise we reply with our preferred one and
  // let the client choose to disconnect. A bogus params shape falls back to
  // the default for the same reason — extra/unknown fields are explicitly
  // allowed by the spec, so we never reject an `initialize` over them.
  const negotiated = negotiateProtocolVersion(params);
  return {
    protocolVersion: negotiated,
    capabilities: { tools: {} },
    serverInfo: {
      name: "stellara",
      version: app.config.appVersion,
    },
    // Tool-suite overview rendered by MCP clients (Claude Desktop,
    // Codex, …) so LLMs see "what is each tool family for" before
    // calling anything (plan 0011). Spec 2024-11-05+; older clients
    // ignore the field.
    instructions: STELLARA_SUITE_OVERVIEW,
  };
}
