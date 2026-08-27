/**
 * Per-route body-size limits per concept §7.2.
 *
 * Mirrors {@link ./timeouts.ts} so route handlers and the global Fastify
 * factory share a single source of truth. The Fastify `bodyLimit` option is a
 * number of bytes; the constants exported here are imported by the server
 * bootstrap and by routes that override the default (e.g. memory upsert).
 */

/** Default per-request body limit (§7.2). 1 MB. */
export const DEFAULT_BODY_LIMIT = 1_048_576;

/** Body limit for `/tools/memory/upsert` per concept §7.2 (256 KB). */
export const MEMORY_UPSERT_BODY_LIMIT = 262_144;
