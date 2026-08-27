/** Resource-indicator policy shared by authorize, code and refresh flows. */
import { createHash } from "node:crypto";

import type { ResolvedClient } from "./client-metadata.js";
import type { OAuthStorage } from "./storage.js";

export const RESOURCE_CUTOVER_META_KEY = "oauth_resource_required_since";

export type ResourceValidation =
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; resource: string; usedLegacyDefault: boolean };

/** Initializes the one-way cutover marker exactly once and validates its shape. */
export function initializeResourceCutover(storage: OAuthStorage, now = Date.now()): number {
  const persisted = storage.getOrInitializeMeta(RESOURCE_CUTOVER_META_KEY, String(now));
  const cutover = Number(persisted);
  if (!Number.isSafeInteger(cutover) || cutover <= 0) {
    throw new Error(`Invalid ${RESOURCE_CUTOVER_META_KEY} value`);
  }
  return cutover;
}

/** Validates resource after the client metadata and redirect are authoritative. */
export function validateResolvedClientResource(args: {
  client: ResolvedClient;
  requestedResource: string | undefined;
  canonicalResource: string;
  cutover: number;
}): ResourceValidation {
  const { client, requestedResource, canonicalResource, cutover } = args;
  if (requestedResource !== undefined) {
    return requestedResource === canonicalResource
      ? { kind: "ok", resource: canonicalResource, usedLegacyDefault: false }
      : { kind: "invalid", reason: "resource does not match the protected MCP resource" };
  }
  if (
    client.registration === "dcr" &&
    client.createdAt !== undefined &&
    client.createdAt < cutover
  ) {
    return { kind: "ok", resource: canonicalResource, usedLegacyDefault: true };
  }
  return { kind: "invalid", reason: "resource is required" };
}

/**
 * Token endpoints never fetch CIMD again. URL identifiers are known CIMD and
 * remain strict; opaque identifiers consult only their persisted DCR row.
 */
export function validateBoundTokenResource(args: {
  storage: OAuthStorage;
  clientId: string;
  requestedResource: string | undefined;
  canonicalResource: string;
  cutover: number;
}): ResourceValidation {
  const { storage, clientId, requestedResource, canonicalResource, cutover } = args;
  if (requestedResource !== undefined) {
    return requestedResource === canonicalResource
      ? { kind: "ok", resource: canonicalResource, usedLegacyDefault: false }
      : { kind: "invalid", reason: "resource does not match the protected MCP resource" };
  }
  if (isHttpsIdentifier(clientId)) {
    return { kind: "invalid", reason: "resource is required" };
  }
  const client = storage.getClient(clientId);
  if (client !== undefined && client.created_at < cutover) {
    return { kind: "ok", resource: canonicalResource, usedLegacyDefault: true };
  }
  return { kind: "invalid", reason: "resource is required" };
}

/** Low-cardinality-safe log correlation for untrusted client identifiers. */
export function hashClientId(clientId: string): string {
  return createHash("sha256").update(clientId, "utf8").digest("hex").slice(0, 16);
}

function isHttpsIdentifier(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return value.toLowerCase().startsWith("https:");
  }
}
