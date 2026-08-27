/**
 * Shared fetch-mock helpers reused across the service tests and the new route
 * tests in `tests/unit/routes/`. Extracting these used to be inlined per file
 * (see review finding R-0000011) — keeping a single source ensures the helpers
 * evolve in lockstep with the mocking pattern.
 */
import type { MockInstance } from "vitest";

import { expect, vi } from "vitest";

/** Spy returned by `vi.spyOn(globalThis, "fetch")` — strongly typed. */
export type FetchSpy = MockInstance<typeof fetch>;

/** Wraps `payload` in a 200 (or custom-status) JSON `Response`. */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Installs a fetch mock that always resolves with `response`. */
export function mockFetchOnce(response: Response): FetchSpy {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
}

/** Installs a fetch mock that always rejects with the given error. */
export function mockFetchReject(error: unknown): FetchSpy {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
}

/** Extracts the headers object from a fetch init payload without unsafe casts. */
export function extractRawHeaders(init: unknown): unknown {
  if (init === undefined || init === null) return undefined;
  if (typeof init !== "object") return undefined;
  if (!("headers" in init)) return undefined;
  return init.headers;
}

/** Coerces a raw headers value into a plain `Record<string, string>`. */
export function normalizeHeaders(rawHeaders: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
    return headers;
  }
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[key] = typeof value === "string" ? value : String(value);
  }
  return headers;
}

/** Reads the first recorded fetch invocation in a type-safe way. */
export function firstFetchCall(spy: FetchSpy): {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const args = calls[0] ?? [];
  const rawUrl = args[0];
  if (typeof rawUrl !== "string") {
    throw new TypeError(`Expected fetch url to be a string, got ${typeof rawUrl}`);
  }
  const init = args[1];
  const rawBody = init === undefined ? undefined : init.body;
  return {
    url: rawUrl,
    headers: normalizeHeaders(extractRawHeaders(init)),
    body: typeof rawBody === "string" ? rawBody : undefined,
  };
}
