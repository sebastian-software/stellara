import { describe, expect, it } from "vitest";

import {
  AppError,
  ErrorCode,
  HTTP_STATUS_BY_CODE,
  mapUpstreamError,
  toErrorResponse,
} from "../../src/errors.js";

describe("AppError.is", () => {
  it("returns true for AppError instances", () => {
    const error = new AppError({ code: ErrorCode.NOT_FOUND });
    expect(AppError.is(error)).toBe(true);
  });

  it("returns false for plain Error instances", () => {
    expect(AppError.is(new Error("boom"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(AppError.is(undefined)).toBe(false);
    expect(AppError.is({ code: "FOO" })).toBe(false);
    expect(AppError.is("string")).toBe(false);
  });
});

describe("HTTP_STATUS_BY_CODE", () => {
  it("matches the §16.2 catalog", () => {
    expect(HTTP_STATUS_BY_CODE.UNAUTHORIZED).toBe(401);
    expect(HTTP_STATUS_BY_CODE.PAYLOAD_TOO_LARGE).toBe(413);
    expect(HTTP_STATUS_BY_CODE.VALIDATION_ERROR).toBe(422);
    expect(HTTP_STATUS_BY_CODE.RATE_LIMITED).toBe(429);
    expect(HTTP_STATUS_BY_CODE.UPSTREAM_ERROR).toBe(502);
    expect(HTTP_STATUS_BY_CODE.TIMEOUT).toBe(504);
  });
});

describe("toErrorResponse", () => {
  it("mirrors AppError fields into the §16.1 envelope", () => {
    const error = new AppError({
      code: ErrorCode.VALIDATION_ERROR,
      message: "invalid payload",
      details: { field: "query" },
    });

    const body = toErrorResponse(error);
    expect(body).toStrictEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "invalid payload",
        details: { field: "query" },
      },
    });
  });

  it("omits details when the AppError has none", () => {
    const body = toErrorResponse(new AppError({ code: ErrorCode.UNAUTHORIZED }));
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.details).toBeUndefined();
  });

  it("collapses unknown errors into INTERNAL_ERROR without leaking the cause", () => {
    const body = toErrorResponse(new Error("kapow"));
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(body.error.details).toBeUndefined();
  });

  it("includes the original message under details.cause when opted in", () => {
    const body = toErrorResponse(new Error("kapow"), { includeCause: true });
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.details).toStrictEqual({ cause: "kapow" });
  });
});

describe("mapUpstreamError", () => {
  it("maps AbortError to TIMEOUT", () => {
    const error = Object.assign(new Error("aborted"), { name: "AbortError" });
    const mapped = mapUpstreamError(error, { service: "exa" });
    expect(mapped.code).toBe(ErrorCode.TIMEOUT);
    expect(mapped.details).toStrictEqual({ service: "exa" });
  });

  it("maps an aborted signal to TIMEOUT", () => {
    const controller = new AbortController();
    controller.abort();
    const mapped = mapUpstreamError(new Error("network"), { signal: controller.signal });
    expect(mapped.code).toBe(ErrorCode.TIMEOUT);
  });

  it("maps HTTP 4xx/5xx responses to UPSTREAM_ERROR with status in details", () => {
    const mapped = mapUpstreamError({ status: 503 }, { service: "qdrant" });
    expect(mapped.code).toBe(ErrorCode.UPSTREAM_ERROR);
    expect(mapped.details).toStrictEqual({ service: "qdrant", status: 503 });
  });

  it("maps known network error codes to UPSTREAM_ERROR", () => {
    const mapped = mapUpstreamError({ code: "ECONNREFUSED" });
    expect(mapped.code).toBe(ErrorCode.UPSTREAM_ERROR);
    expect(mapped.details).toStrictEqual({ networkCode: "ECONNREFUSED" });
  });

  it("unwraps network error codes from an undici-style cause chain", () => {
    // Node 24's global fetch wraps real network failures as
    // TypeError("fetch failed") with the actual error attached as `cause`.
    const error = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const mapped = mapUpstreamError(error, { service: "exa" });
    expect(mapped.code).toBe(ErrorCode.UPSTREAM_ERROR);
    expect(mapped.details).toStrictEqual({ service: "exa", networkCode: "ECONNREFUSED" });
  });

  it("returns existing AppError instances unchanged", () => {
    const original = new AppError({ code: ErrorCode.NOT_FOUND });
    const mapped = mapUpstreamError(original);
    expect(mapped).toBe(original);
  });

  it("falls back to UPSTREAM_ERROR for unknown shapes", () => {
    const mapped = mapUpstreamError("weird");
    expect(mapped.code).toBe(ErrorCode.UPSTREAM_ERROR);
  });
});
