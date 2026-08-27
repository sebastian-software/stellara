/**
 * Error catalog, error envelope helpers, and upstream-error mapping for
 * Stellara (concept §16).
 *
 * Exports the {@link ErrorCode} constants, the HTTP-status mapping, the
 * {@link AppError} class plus its type guard, the response builder
 * {@link toErrorResponse} and the {@link mapUpstreamError} helper.
 */

/** Stellara-internal error codes, mirrored from the §16.2 catalog. */
export const ErrorCode = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  TIMEOUT: "TIMEOUT",
} as const;

/** Union type of all valid error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Maps each {@link ErrorCode} to its associated HTTP status. */
export const HTTP_STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  VALIDATION_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  TIMEOUT: 504,
};

/** Shape of the §16.1 error envelope returned to clients. */
export type ErrorResponseBody = {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

/** Options accepted by {@link AppError}. */
export type AppErrorOptions = {
  code: ErrorCode;
  message?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};

const DEFAULT_MESSAGE_BY_CODE: Record<ErrorCode, string> = {
  BAD_REQUEST: "Bad request",
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  PAYLOAD_TOO_LARGE: "Payload too large",
  VALIDATION_ERROR: "Validation error",
  RATE_LIMITED: "Rate limited",
  INTERNAL_ERROR: "Internal server error",
  UPSTREAM_ERROR: "Upstream service error",
  TIMEOUT: "Request timed out",
};

/**
 * Domain error carrying a Stellara {@link ErrorCode} plus the HTTP status it
 * should map to and an optional details object. Use {@link AppError.is} to
 * narrow `unknown` errors.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly details?: Record<string, unknown>;

  public constructor(options: AppErrorOptions) {
    const message = options.message ?? DEFAULT_MESSAGE_BY_CODE[options.code];
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.httpStatus = HTTP_STATUS_BY_CODE[options.code];
    this.details = options.details;
  }

  /** Type guard for narrowing `unknown` errors to {@link AppError}. */
  public static is(error: unknown): error is AppError {
    return error instanceof AppError;
  }
}

function appErrorEnvelope(error: AppError): ErrorResponseBody {
  const envelope: ErrorResponseBody = {
    error: {
      code: error.code,
      message: error.message,
    },
  };
  if (error.details !== undefined) {
    envelope.error.details = error.details;
  }
  return envelope;
}

/** Options accepted by {@link toErrorResponse}. */
export type ToErrorResponseOptions = {
  /**
   * When `true`, unknown errors include their original message under
   * `details.cause`. Callers (e.g. the global Fastify error handler) decide
   * based on the active config's `nodeEnv` so this module stays free of
   * direct `process.env` access.
   */
  includeCause?: boolean;
};

/**
 * Builds the §16.1 error envelope for any error. For {@link AppError} the
 * carried code/message/details are mirrored; unknown errors collapse into
 * a generic `INTERNAL_ERROR` envelope.
 */
export function toErrorResponse(
  error: unknown,
  options: ToErrorResponseOptions = {},
): ErrorResponseBody {
  if (AppError.is(error)) {
    return appErrorEnvelope(error);
  }

  const details: Record<string, unknown> = {};
  if (options.includeCause === true && error instanceof Error) {
    details.cause = error.message;
  }

  const envelope: ErrorResponseBody = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: DEFAULT_MESSAGE_BY_CODE.INTERNAL_ERROR,
    },
  };
  if (Object.keys(details).length > 0) {
    envelope.error.details = details;
  }
  return envelope;
}

/** Optional context to attach to upstream-error mappings. */
export type MapUpstreamErrorOptions = {
  /** Logical service name, recorded in `details.service` for debugging. */
  service?: string;
  /** Signal whose `aborted` state means the call was cancelled. */
  signal?: AbortSignal;
};

type UpstreamErrorLike = {
  name?: string;
  message?: string;
  code?: string;
  status?: number;
  statusCode?: number;
  cause?: unknown;
};

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function asErrorLike(error: unknown): UpstreamErrorLike {
  if (typeof error === "object" && error !== null) {
    return error;
  }
  return {};
}

function isAbortError(errorLike: UpstreamErrorLike, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (errorLike.name === "AbortError") return true;
  if (errorLike.code === "ABORT_ERR") return true;
  return false;
}

function upstreamStatus(errorLike: UpstreamErrorLike): number | undefined {
  return errorLike.status ?? errorLike.statusCode;
}

/**
 * Returns a network-error code from the outer error or its `cause` chain
 * (Node's `fetch` wraps the real error as `cause`, e.g. `TypeError("fetch
 * failed")` with `cause: { code: "ECONNREFUSED" }`).
 */
function networkCodeFromChain(errorLike: UpstreamErrorLike): string | undefined {
  if (typeof errorLike.code === "string" && NETWORK_ERROR_CODES.has(errorLike.code)) {
    return errorLike.code;
  }
  const cause = asErrorLike(errorLike.cause);
  if (typeof cause.code === "string" && NETWORK_ERROR_CODES.has(cause.code)) {
    return cause.code;
  }
  return undefined;
}

/**
 * Normalizes errors raised while talking to upstream services (fetch, Node
 * networking, abort signals) into a Stellara {@link AppError}.
 *
 * Mapping rules:
 * - `AbortError` (or aborted {@link AbortSignal}) → `TIMEOUT`.
 * - Plain objects with HTTP `status`/`statusCode` ≥ 400 → `UPSTREAM_ERROR`,
 *   the status is preserved in `details.status`.
 * - Known network error codes (`ECONNREFUSED`, …) → `UPSTREAM_ERROR`.
 * - Anything else collapses into a generic `UPSTREAM_ERROR`.
 */
export function mapUpstreamError(error: unknown, options: MapUpstreamErrorOptions = {}): AppError {
  if (AppError.is(error)) {
    return error;
  }

  const errorLike = asErrorLike(error);
  const baseDetails: Record<string, unknown> = {};
  if (options.service !== undefined) {
    baseDetails.service = options.service;
  }

  if (isAbortError(errorLike, options.signal)) {
    return new AppError({
      code: ErrorCode.TIMEOUT,
      details: baseDetails,
      cause: error,
    });
  }

  const status = upstreamStatus(errorLike);
  if (status !== undefined && status >= 400) {
    return new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { ...baseDetails, status },
      cause: error,
    });
  }

  const networkCode = networkCodeFromChain(errorLike);
  if (networkCode !== undefined) {
    return new AppError({
      code: ErrorCode.UPSTREAM_ERROR,
      details: { ...baseDetails, networkCode },
      cause: error,
    });
  }

  return new AppError({
    code: ErrorCode.UPSTREAM_ERROR,
    details: baseDetails,
    cause: error,
  });
}
