/**
 * Request-body encoding and response-body cap/decode helpers shared by
 * {@link `./http-fetch.ts`}.
 *
 * Split out so the orchestrator file stays under the project-wide per-file
 * line budget. The helpers are intentionally pure — no I/O beyond the
 * `ReadableStream` read in {@link readBodyWithCap} — so they can be tested
 * in isolation.
 */
import { AppError, ErrorCode } from "../errors.js";

/** Maximum response-body size before the streaming reader bails out (10 MB). */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Discriminated request-body shape used by the service layer. */
export type HttpFetchBody =
  | { type: "base64"; value: string }
  | { type: "form"; value: Record<string, string> }
  | { type: "json"; value: unknown }
  | { type: "text"; value: string };

/** Body shapes {@link encodeRequestBody} emits — all valid `BodyInit` values. */
export type EncodedBodyValue = string | Uint8Array;

/** Outputs of {@link encodeRequestBody}. */
export type EncodedBody = {
  body: EncodedBodyValue;
  /** Default content type — only applied when the caller has not set one. */
  contentType: string | undefined;
};

/**
 * Encodes the discriminated body union for `fetch`. Each branch sets the
 * appropriate `Content-Type` default (except `base64`, where the caller owns
 * the binary mime type). The caller-supplied `Content-Type` header always
 * overrides this default — see `buildInternalRequest` in `http-fetch.ts`.
 */
export function encodeRequestBody(body: HttpFetchBody): EncodedBody {
  switch (body.type) {
    case "json":
      return { body: JSON.stringify(body.value), contentType: "application/json" };
    case "text":
      return { body: body.value, contentType: "text/plain; charset=utf-8" };
    case "form": {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body.value)) params.append(key, value);
      return { body: params.toString(), contentType: "application/x-www-form-urlencoded" };
    }
    case "base64": {
      const bytes = Buffer.from(body.value, "base64");
      // No implicit content type — base64 is intentionally opaque, the caller
      // owns the upstream's mime type. Hand undici a fresh `Uint8Array`
      // view onto the same buffer so the bytes survive across the
      // `BodyInit`-shaped call.
      return {
        body: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        contentType: undefined,
      };
    }
  }
}

/** Outputs of {@link readBodyWithCap}. */
export type BodyReadOutcome = {
  bytes: Uint8Array;
  truncated: boolean;
};

/**
 * Reads the response body byte-by-byte through the Web Streams reader,
 * stopping as soon as the accumulated length exceeds the 10 MB cap. The cap
 * is enforced manually because `Response.arrayBuffer()` would happily buffer
 * the full body before checking any size limit.
 *
 * `signal` is honored throughout the drain loop as defense-in-depth: undici
 * already cancels the body stream when the fetch-level signal aborts, but
 * relying solely on library behavior is fragile. With an explicit race the
 * service stays bounded by the route-level `withTimeout` even if a future
 * undici release loosens that guarantee.
 */
export async function readBodyWithCap(
  response: Response,
  signal: AbortSignal,
): Promise<BodyReadOutcome> {
  const body = response.body;
  if (body === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  return drainReader(body.getReader(), signal);
}

/**
 * Drains the supplied reader into a single contiguous buffer, capped at 10 MB.
 *
 * Each `reader.read()` is raced against an abort-promise so a slow (drip-feed)
 * upstream cannot keep the loop alive past the caller's timeout. On abort the
 * reader is explicitly cancelled and a `TIMEOUT` `AppError` is raised — the
 * same shape `withTimeout` → `mapUpstreamError` would produce, so the
 * call-site error handling stays uniform.
 */
async function drainReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<BodyReadOutcome> {
  const state: DrainState = { chunks: [], total: 0 };
  const abort = waitForAbort(signal);
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), abort.promise]);
      if (result.done) break;
      if (appendChunkOrTruncate(state, result.value)) {
        await reader.cancel();
        return { bytes: concatChunks(state.chunks, state.total), truncated: true };
      }
    }
    return { bytes: concatChunks(state.chunks, state.total), truncated: false };
  } catch (error) {
    // Best-effort cancel; swallow secondary errors so the primary cause wins.
    await reader.cancel().catch(swallow);
    throw error;
  } finally {
    abort.dispose();
  }
}

/** Lint-friendly noop used as a Promise rejection sink. */
function swallow(): void {
  // Intentional: nothing to do when the secondary error is irrelevant.
}

/**
 * Returns a never-resolving promise that rejects with a `TIMEOUT` `AppError`
 * as soon as `signal` fires, plus a `dispose` callback that removes the
 * `abort` listener. The disposer is mandatory: when `Promise.race` settles via
 * the read branch we still hold a registered listener on `signal`, and a
 * long-lived signal (the route-level `withTimeout` may outlive a single fetch)
 * would otherwise accumulate listeners across requests.
 */
function waitForAbort(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let dispose: () => void = noopDispose;
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(timeoutError());
      return;
    }
    const onAbort = () => {
      reject(timeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  // Pre-attach a noop rejection handler so the race loser does not surface as
  // an unhandled-rejection when the read branch wins instead.
  promise.catch(swallow);
  return { promise, dispose };
}

/** Default `dispose` returned by {@link waitForAbort} when no listener was set. */
function noopDispose(): void {
  // Intentional: only used when `signal.aborted` was already true.
}

/** Builds the `TIMEOUT` `AppError` raised when a body read is aborted. */
function timeoutError(): AppError {
  return new AppError({
    code: ErrorCode.TIMEOUT,
    details: { service: "fetch", reason: "body_read_aborted" },
  });
}

/** Mutable accumulator threaded through {@link appendChunkOrTruncate}. */
type DrainState = {
  chunks: Uint8Array[];
  total: number;
};

/**
 * Appends `chunk` to `state` unless it would push the total past the body
 * cap. Returns `true` when the chunk had to be truncated — the caller is
 * then responsible for cancelling the reader.
 */
function appendChunkOrTruncate(state: DrainState, chunk: Uint8Array): boolean {
  const remaining = MAX_BODY_BYTES - state.total;
  if (chunk.byteLength <= remaining) {
    state.chunks.push(chunk);
    state.total += chunk.byteLength;
    return false;
  }
  const keep = Math.max(remaining, 0);
  state.chunks.push(chunk.subarray(0, keep));
  state.total += keep;
  return true;
}

/** Concatenates the accumulated chunks into a single buffer. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Inputs for {@link decodeResponseBody}. */
export type DecodeResponseBodyInput = {
  bytes: Uint8Array;
  truncated: boolean;
  requested: "auto" | "binary" | "json" | "text";
  contentType: string | undefined;
  status: number;
};

/** Output shape for {@link decodeResponseBody}. */
export type DecodeResponseBodyOutput = {
  format: "binary" | "json" | "text";
  body: unknown;
  truncated: boolean;
};

/** Returns `true` when the upstream content-type marks a JSON-shaped body. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  const semi = value.indexOf(";");
  const main = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
  return main === "application/json" || (main.startsWith("application/") && main.endsWith("+json"));
}

/**
 * Decodes the raw response bytes into the format the caller requested.
 *
 * Truncation policy (plan 0006 step 11):
 * - `json` + truncated → AppError BAD_REQUEST (body is structurally invalid)
 * - `auto` + truncated → downgrade to `text` and report `truncated: true`
 * - `text`/`binary` + truncated → return what we got with `truncated: true`
 */
export function decodeResponseBody(input: DecodeResponseBodyInput): DecodeResponseBodyOutput {
  if (input.requested === "binary") {
    return {
      format: "binary",
      body: Buffer.from(input.bytes).toString("base64"),
      truncated: input.truncated,
    };
  }
  if (input.requested === "json") {
    return decodeJsonResponse(input);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  if (input.requested === "text") {
    return { format: "text", body: text, truncated: input.truncated };
  }
  // `auto` — parse JSON when the content type matches AND the body is not
  // truncated (truncated JSON is by construction invalid). Otherwise fall
  // back to text so the caller still sees what was received.
  if (!input.truncated && isJsonContentType(input.contentType)) {
    try {
      return { format: "json", body: JSON.parse(text) as unknown, truncated: false };
    } catch {
      // Fall through to text — the upstream advertised JSON but did not
      // deliver. Reporting the raw body is more useful than a 400 here
      // because `auto` is the "best effort" mode.
    }
  }
  return { format: "text", body: text, truncated: input.truncated };
}

/**
 * Handles the `responseFormat: "json"` branch including the truncation guard.
 * A truncated body is structurally invalid JSON, so we fail-fast with
 * `BAD_REQUEST` rather than passing partial bytes to `JSON.parse` — partial
 * results under an explicit `"json"` mode would silently lose data.
 *
 * The `bodySnippet` (first 200 chars of the upstream body) is propagated to
 * the caller via `AppError.details` and is intentionally never written to
 * Stellara logs. Callers see only the snippet of the endpoint they themselves
 * invoked, so the snippet stays within the caller's existing trust boundary.
 */
function decodeJsonResponse(input: DecodeResponseBodyInput): DecodeResponseBodyOutput {
  if (input.truncated) {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      details: { reason: "response_truncated_json", status: input.status },
    });
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  try {
    return { format: "json", body: JSON.parse(text) as unknown, truncated: false };
  } catch {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      details: {
        reason: "response_not_json",
        status: input.status,
        bodySnippet: text.slice(0, 200),
      },
    });
  }
}
