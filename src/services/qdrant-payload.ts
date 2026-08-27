/**
 * Payload-level helpers shared by the Qdrant memory store.
 *
 * Contains the per-user filter builder, payload-coercion helpers, and the
 * cursor codec. Extracted from `qdrant.ts` to keep individual modules under
 * the project-wide line budget.
 */
import type { Schemas } from "@qdrant/js-client-rest";

import type { MemoryFilter, MemoryPoint } from "./qdrant-types.js";

/** Payload key carrying the owning user — single source of isolation per §8.9. */
export const USER_ID_KEY = "userId";

/**
 * Builds a Qdrant filter that scopes every read/update to a single user and
 * optionally narrows further by tags / source.
 */
export function buildFilter(userId: string, extra?: MemoryFilter): Schemas["Filter"] {
  const must: Array<Schemas["FieldCondition"]> = [{ key: USER_ID_KEY, match: { value: userId } }];
  if (extra?.source !== undefined) {
    must.push({ key: "source", match: { value: extra.source } });
  }
  if (extra?.tags !== undefined && extra.tags.length > 0) {
    // Qdrant matches array payloads element-wise — use `any` semantics so the
    // request returns points that carry at least one of the requested tags.
    must.push({ key: "tags", match: { any: extra.tags } });
  }
  return { must };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") result.push(entry);
  }
  return result.length === 0 ? undefined : result;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectLike(value) ? value : undefined;
}

/** Reads the payload-stored `id` (caller id) preferring it over the internal point id. */
function callerIdFromPayload(
  payload: Record<string, unknown> | undefined,
  fallback: string,
): string {
  return asString(payload?.id) ?? fallback;
}

/** Maps a raw Qdrant payload onto the public {@link MemoryPoint} shape. */
export function toMemoryPoint(
  pointId: string,
  payload: Record<string, unknown> | undefined,
): MemoryPoint {
  const safePayload = payload ?? {};
  const result: MemoryPoint = {
    id: callerIdFromPayload(safePayload, pointId),
    text: asString(safePayload.text) ?? "",
    createdAt: asString(safePayload.createdAt) ?? "",
    updatedAt: asString(safePayload.updatedAt) ?? "",
  };
  const source = asString(safePayload.source);
  if (source !== undefined) result.source = source;
  const tags = asStringArray(safePayload.tags);
  if (tags !== undefined) result.tags = tags;
  const metadata = asRecord(safePayload.metadata);
  if (metadata !== undefined) result.metadata = metadata;
  return result;
}

// cspell:disable
/**
 * Cursor-Codec für Qdrant-Scroll-Offsets.
 *
 * ## Opakheits-Vertrag
 *
 * Der Cursor ist aus Sicht des Aufrufers vollständig opak: Er trägt keinen
 * semantischen Inhalt, der außerhalb von Stellara interpretiert werden darf.
 * Intern serialisiert er den Qdrant-Scroll-Offset (UUID-String oder numerische
 * ID), damit eine Seite die nächste anfragen kann. Konzept §8.7 legt die
 * Anforderungen an Cursor-Tamper-Schutz fest; die kryptografische Absicherung
 * folgt in einem späteren Schritt.
 *
 * ## Encoding-Wahl
 *
 * Für die Base64url-Kodierung wird `Buffer` verwendet. Das ist absichtlich:
 * Stellara läuft ausschließlich als Container auf Node 24, wo `Buffer` ohne
 * Einschränkungen zur Verfügung steht. Eine Umstellung auf die Web-API
 * `btoa`/`atob` brächte keinen Vorteil – `atob`/`btoa` kennen kein
 * Base64url-Alphabet und würden einen manuellen Zeichentausch erfordern.
 * Solange Stellara container-only bleibt, ist `Buffer` die klarere Wahl.
 */
// cspell:enable

/** Decodes the opaque base64url cursor produced by {@link encodeCursor}. */
export function decodeCursor(cursor: string | undefined): number | string | undefined {
  if (cursor === undefined) return undefined;
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Encodes a Qdrant scroll offset as an opaque base64url cursor. */
export function encodeCursor(offset: unknown): string | undefined {
  if (offset === undefined || offset === null) return undefined;
  if (typeof offset !== "string" && typeof offset !== "number") return undefined;
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

/**
 * Reads the vector size out of a Qdrant `CollectionInfo`. The Qdrant schema
 * keeps `vectors` polymorphic (anonymous `VectorParams` vs. a map of named
 * `VectorParams`), so we walk both branches at runtime without unsafe casts.
 */
export function extractVectorSize(info: Schemas["CollectionInfo"]): number | undefined {
  const vectorsCandidate: unknown = info.config.params.vectors;
  const vectors = asRecord(vectorsCandidate);
  if (vectors === undefined) return undefined;
  const directSize = vectors.size;
  if (typeof directSize === "number") return directSize;
  for (const value of Object.values(vectors)) {
    const inner = asRecord(value);
    const innerSize = inner?.size;
    if (typeof innerSize === "number") return innerSize;
  }
  return undefined;
}

/**
 * Promise that rejects with a synthetic `AbortError` as soon as `signal`
 * fires. Used by the Qdrant `probe` to race against the underlying client
 * which (in v1.x) does not accept a per-call `AbortSignal`.
 */
export async function abortPromise(signal: AbortSignal): Promise<never> {
  await Promise.resolve();
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError(): Error {
  const error = new Error("Probe aborted");
  error.name = "AbortError";
  return error;
}
