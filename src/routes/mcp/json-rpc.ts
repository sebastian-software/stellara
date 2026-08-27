/**
 * JSON-RPC 2.0 envelope helpers used by the MCP dispatcher (concept §9).
 *
 * Provides the wire schema for the JSON-RPC request envelope plus the success
 * and failure envelope constructors. Keeping these helpers in a dedicated
 * module lets the rest of the dispatch implementation focus on MCP semantics
 * (initialize, tools/list, tools/call).
 */
import { type core, z } from "zod/v4";

/** JSON-RPC 2.0 error codes used by this dispatcher (subset of the spec). */
export const JsonRpcErrorCode = {
  PARSE_ERROR: -32_700,
  INVALID_REQUEST: -32_600,
  METHOD_NOT_FOUND: -32_601,
  INVALID_PARAMS: -32_602,
  /** Implementation-defined server error per JSON-RPC §5.1. */
  SERVER_ERROR: -32_000,
} as const;

/** A JSON-RPC request identifier (number, string or null per §4.2). */
export type JsonRpcId = null | number | string;

/** A successful JSON-RPC response envelope. */
export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

/** A JSON-RPC error response envelope. */
export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

/** Union of the two JSON-RPC response shapes. */
export type JsonRpcResponse = JsonRpcFailure | JsonRpcSuccess;

/** Wire schema used to validate incoming JSON-RPC envelopes. */
const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/**
 * Sanitized projection of a Zod issue that is safe to expose to MCP clients.
 *
 * Zod v4 issues include an `input` field (and, depending on the issue code,
 * `values`, `keys`, nested `issues`, etc.) that may carry the caller's raw
 * argument — including credentials or other secrets that landed in an invalid
 * field. Pino's log redaction handles outbound logs, but the JSON-RPC error
 * envelope is sent straight back to the client, so we strip the issue down to
 * the three fields any MCP client actually needs to localize the error.
 */
export type SanitizedZodIssue = {
  path: ReadonlyArray<number | string>;
  code: string;
  message: string;
  /**
   * For `invalid_union` issues Zod attaches the per-branch issues. We keep
   * them so clients can see which branch failed, but only after recursively
   * stripping their own `input`/`values` payloads.
   */
  issues?: ReadonlyArray<readonly SanitizedZodIssue[]>;
};

/**
 * Projects a single Zod issue onto the three caller-safe fields. `path`
 * values that are symbols (allowed by `PropertyKey[]` but not JSON-safe) are
 * coerced to their `toString()` form so the result round-trips through JSON
 * without becoming `null`.
 */
function sanitizeZodIssue(issue: core.$ZodIssue): SanitizedZodIssue {
  const safePath = issue.path.map((segment) =>
    typeof segment === "number" || typeof segment === "string" ? segment : segment.toString(),
  );
  const sanitized: SanitizedZodIssue = {
    path: safePath,
    code: issue.code,
    message: issue.message,
  };
  if (issue.code === "invalid_union") {
    sanitized.issues = issue.errors.map((branch) =>
      branch.map((nested) => sanitizeZodIssue(nested)),
    );
  }
  return sanitized;
}

/**
 * Strips every `received`/`input`/`values` payload from a list of Zod issues
 * before it crosses the JSON-RPC boundary. Used by both the envelope parser
 * and the `tools/call` dispatcher so the same redaction rules apply to every
 * `INVALID_PARAMS` and `INVALID_REQUEST` response.
 */
export function sanitizeZodIssues(issues: readonly core.$ZodIssue[]): readonly SanitizedZodIssue[] {
  return issues.map((issue) => sanitizeZodIssue(issue));
}

/** Builds a JSON-RPC success envelope. */
export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/** Body accepted by {@link jsonRpcError}. */
export type JsonRpcErrorBody = {
  /** Numeric JSON-RPC error code (see {@link JsonRpcErrorCode}). */
  code: number;
  /** Human-readable error message. */
  message: string;
  /** Optional `data` payload attached to the JSON-RPC error envelope. */
  data?: unknown;
};

/** Builds a JSON-RPC error envelope. */
export function jsonRpcError(id: JsonRpcId, body: JsonRpcErrorBody): JsonRpcFailure {
  const envelope: JsonRpcFailure = {
    jsonrpc: "2.0",
    id,
    error: { code: body.code, message: body.message },
  };
  if (body.data !== undefined) {
    envelope.error.data = body.data;
  }
  return envelope;
}

/** Outcome of {@link parseJsonRpcEnvelope}. */
export type ParsedEnvelope = {
  id: JsonRpcId;
  method: string;
  params: unknown;
  /**
   * `true` when the request omitted `id` entirely — JSON-RPC 2.0 §4.1 defines
   * these as notifications, and §4.1 requires the server to NOT respond.
   * `id: null` (explicit) is a regular request and stays a non-notification.
   */
  isNotification: boolean;
};

/**
 * Parses an unknown JSON-RPC payload. Returns a failure envelope when the
 * input is unusable (wrong `jsonrpc` value, missing `method`, etc.); returns
 * a parsed envelope on success. JSON syntax errors are handled by the caller
 * which catches them at the body-parser level and emits `PARSE_ERROR`.
 */
export function parseJsonRpcEnvelope(payload: unknown): JsonRpcFailure | ParsedEnvelope {
  const parsed = jsonRpcRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonRpcError(null, {
      code: JsonRpcErrorCode.INVALID_REQUEST,
      message: "Invalid Request",
      data: { issues: sanitizeZodIssues(parsed.error.issues) },
    });
  }
  const isNotification = parsed.data.id === undefined;
  return {
    id: parsed.data.id ?? null,
    method: parsed.data.method,
    params: parsed.data.params,
    isNotification,
  };
}
