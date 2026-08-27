/** Fetch and validation policy for OAuth client metadata documents. */
import { z } from "zod/v4";

import type {
  CimdOperationContext,
  CimdTransport,
  CimdTransportResponse,
} from "./client-metadata-transport.js";

import { waitForCimdOperation } from "./client-metadata-transport.js";
import { validateRedirectUris } from "./clients.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_POSITIVE_TTL_MS = 60 * 60_000;

const documentSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.url()).min(1).max(10),
});

export type ValidatedClientDocument = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  ttlMs: number;
};

/** Follows the bounded redirect chain and validates the final document. */
export async function fetchClientDocument(args: {
  originalClientId: string;
  transport: CimdTransport;
  nowMs: number;
  operation: CimdOperationContext;
}): Promise<ValidatedClientDocument> {
  const { originalClientId, transport, nowMs, operation } = args;
  const response = await fetchFinalResponse(originalClientId, transport, operation);
  return validateDocumentResponse(originalClientId, response, nowMs);
}

async function fetchFinalResponse(
  originalClientId: string,
  transport: CimdTransport,
  operation: CimdOperationContext,
): Promise<CimdTransportResponse> {
  const original = parseDocumentUrl(originalClientId);
  let current = original;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    validateDocumentUrl(current);
    const response = await waitForCimdOperation(transport(current, operation), operation);
    if (!isRedirect(response.statusCode)) return response;
    if (redirects === MAX_REDIRECTS) throw new Error("Too many CIMD redirects");
    current = resolveRedirect(response.headers.location, current, original.origin);
  }
  throw new Error("Too many CIMD redirects");
}

function validateDocumentResponse(
  originalClientId: string,
  response: CimdTransportResponse,
  nowMs: number,
): ValidatedClientDocument {
  if (response.statusCode !== 200) throw new Error("CIMD endpoint did not return HTTP 200");
  validateResponseMedia(response);
  const parsed: unknown = JSON.parse(Buffer.from(response.body).toString("utf8"));
  const document = documentSchema.safeParse(parsed);
  if (!document.success) throw new Error("CIMD document is invalid");
  if (document.data.client_id !== originalClientId) throw new Error("CIMD self-binding mismatch");
  if (validateRedirectUris(document.data.redirect_uris).kind !== "ok") {
    throw new Error("CIMD document contains an invalid redirect_uri");
  }
  return {
    clientId: originalClientId,
    clientName: document.data.client_name,
    redirectUris: document.data.redirect_uris,
    ttlMs: computePositiveTtl(response.headers, nowMs),
  };
}

function validateResponseMedia(response: CimdTransportResponse): void {
  const contentType = firstHeader(response.headers["content-type"]);
  if (contentType === undefined || !isJsonContentType(contentType)) {
    throw new Error("CIMD endpoint returned a non-JSON content type");
  }
  if (response.body.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("CIMD document is too large");
  }
}

export function parseClientDocumentUrl(clientId: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    throw new Error("client_id is not a valid CIMD URL");
  }
  validateDocumentUrl(parsed);
  return parsed;
}

const parseDocumentUrl = parseClientDocumentUrl;

function validateDocumentUrl(url: URL): void {
  if (url.protocol !== "https:") throw new Error("CIMD client_id must use HTTPS");
  if (url.username !== "" || url.password !== "") {
    throw new Error("CIMD client_id must not contain credentials");
  }
  if (url.hash !== "") throw new Error("CIMD client_id must not contain a fragment");
  if (url.pathname === "" || url.pathname === "/") {
    throw new Error("CIMD client_id must contain a document path");
  }
}

function resolveRedirect(
  location: string | string[] | undefined,
  current: URL,
  origin: string,
): URL {
  const raw = firstHeader(location);
  if (raw === undefined) throw new Error("CIMD redirect is missing Location");
  const target = new URL(raw, current);
  validateDocumentUrl(target);
  if (target.origin !== origin) throw new Error("CIMD redirect changed origin");
  return target;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function computePositiveTtl(headers: CimdTransportResponse["headers"], nowMs: number): number {
  const directives = cacheControlDirectives(headers["cache-control"]);
  assertCacheStorageAllowed(directives);
  const maxAgeTtl = readMaxAgeTtl(directives);
  if (maxAgeTtl !== undefined) return maxAgeTtl;
  const expires = firstHeader(headers.expires);
  const expiryMs = expires === undefined ? Number.NaN : Date.parse(expires);
  if (Number.isFinite(expiryMs) && expiryMs > nowMs) {
    return Math.min(expiryMs - nowMs, MAX_POSITIVE_TTL_MS);
  }
  throw new Error("CIMD response has no positive cache freshness");
}

function cacheControlDirectives(value: string | string[] | undefined): readonly string[] {
  const joined = Array.isArray(value) ? value.join(",") : value;
  return (
    joined
      ?.split(",")
      .map((directive) => directive.trim().toLowerCase())
      .filter((directive) => directive.length > 0) ?? []
  );
}

function assertCacheStorageAllowed(directives: readonly string[]): void {
  const forbidden = directives.some((directive) => {
    const name = directive.split("=", 1)[0];
    return name === "no-store" || name === "no-cache";
  });
  if (forbidden) {
    throw new Error("CIMD response forbids positive caching");
  }
}

function readMaxAgeTtl(directives: readonly string[]): number | undefined {
  const directive = directives.find((candidate) => candidate.startsWith("max-age"));
  if (directive === undefined) return undefined;
  const match = /^max-age=(?:"(\d+)"|(\d+))$/u.exec(directive);
  const seconds = Number(match?.[1] ?? match?.[2]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("CIMD response has no positive cache freshness");
  }
  return Math.min(seconds * 1000, MAX_POSITIVE_TTL_MS);
}
