/**
 * Shared HTTP helpers for service-client wrappers.
 *
 * Provider clients ({@link ../services/embeddings.ts}, {@link ../services/exa.ts},
 * {@link ../services/firecrawl.ts}) all need the same two utilities when
 * talking to upstream REST APIs via `fetch`:
 *
 * - {@link readBodySafely} — best-effort body extraction for error enrichment.
 * - {@link ensureOk} — turns non-2xx responses into an {@link AppError}
 *   carrying `UPSTREAM_ERROR` plus the body for debugging.
 *
 * Keeping them in one module avoids the drift risk of three identical copies
 * (Konzept §16, §25).
 */
import { AppError, ErrorCode } from "../errors.js";

/**
 * Reads the response body without throwing. Returns the text body when
 * non-empty, otherwise `undefined`. Used to enrich `UPSTREAM_ERROR` details
 * with the upstream message without masking the original failure when the
 * body cannot be consumed.
 */
export async function readBodySafely(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * Throws an {@link AppError} carrying `UPSTREAM_ERROR` when `response` is not
 * 2xx. Reads the body opportunistically via {@link readBodySafely} so the
 * error envelope can carry the upstream message for debugging. The `service`
 * argument identifies the upstream provider (e.g. `"embeddings"`, `"exa"`,
 * `"firecrawl"`) so downstream log lines remain attributable.
 */
export async function ensureOk(response: Response, service: string): Promise<void> {
  if (response.ok) return;
  const body = await readBodySafely(response);
  throw new AppError({
    code: ErrorCode.UPSTREAM_ERROR,
    details: { service, status: response.status, body },
  });
}
