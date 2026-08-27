import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCode } from "../../../src/errors.js";
import { MAX_BODY_BYTES } from "../../../src/services/http-fetch-body.js";
import { runHttpFetch } from "../../../src/services/http-fetch.js";
import { firstFetchCall, mockFetchOnce, mockFetchReject } from "../helpers/fetch-mock.js";

/** AbortSignal that is never aborted — mirrors what `withTimeout` provides. */
function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Minimal call to `runHttpFetch` with safe defaults. */
function defaultArgs(
  overrides: Partial<Parameters<typeof runHttpFetch>[0]> = {},
): Parameters<typeof runHttpFetch>[0] {
  return {
    url: "https://example.com/api",
    method: "GET",
    responseFormat: "auto",
    followRedirects: false,
    maxRedirects: 0,
    signal: neverAbortedSignal(),
    ...overrides,
  };
}

describe("runHttpFetch — request body encoding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets Content-Type: application/json for a json body", async () => {
    const spy = mockFetchOnce(
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    await runHttpFetch(defaultArgs({ method: "POST", body: { type: "json", value: { a: 1 } } }));
    const call = firstFetchCall(spy);
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.body).toBe('{"a":1}');
  });

  it("sets Content-Type: application/x-www-form-urlencoded for a form body", async () => {
    const spy = mockFetchOnce(new Response("ok", { headers: { "content-type": "text/plain" } }));
    await runHttpFetch(
      defaultArgs({ method: "POST", body: { type: "form", value: { a: "b", c: "d" } } }),
    );
    const call = firstFetchCall(spy);
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(call.body).toContain("a=b");
    expect(call.body).toContain("c=d");
  });

  it("sends a text body unmodified with text/plain content-type", async () => {
    const spy = mockFetchOnce(new Response("ok"));
    await runHttpFetch(
      defaultArgs({ method: "POST", body: { type: "text", value: "hello world" } }),
    );
    const call = firstFetchCall(spy);
    expect(call.headers["content-type"]).toMatch(/^text\/plain/);
    expect(call.body).toBe("hello world");
  });

  it("sends base64 body as decoded bytes and does NOT set an implicit Content-Type", async () => {
    // base64("hello") = "aGVsbG8="
    const spy = mockFetchOnce(new Response("ok"));
    await runHttpFetch(
      defaultArgs({ method: "POST", body: { type: "base64", value: "aGVsbG8=" } }),
    );
    const call = firstFetchCall(spy);
    // No implicit content-type for binary bodies.
    expect(call.headers["content-type"]).toBeUndefined();
  });

  it("caller-supplied Content-Type wins over the implicit type from body.type", async () => {
    const spy = mockFetchOnce(new Response('{"ok":true}'));
    await runHttpFetch(
      defaultArgs({
        method: "POST",
        headers: { "Content-Type": "application/ld+json" },
        body: { type: "json", value: {} },
      }),
    );
    const call = firstFetchCall(spy);
    expect(call.headers["Content-Type"]).toBe("application/ld+json");
  });
});

describe("runHttpFetch — hop-by-hop header stripping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips host and reports it in droppedRequestHeaders (sorted, lowercased)", async () => {
    mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(
      defaultArgs({ headers: { Host: "evil.example", "X-Custom": "keep" } }),
    );
    expect(result.droppedRequestHeaders).toContain("host");
    expect(result.droppedRequestHeaders).not.toContain("x-custom");
  });

  it("strips connection, transfer-encoding, content-length, keep-alive, te, upgrade", async () => {
    mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(
      defaultArgs({
        headers: {
          Connection: "keep-alive",
          "Transfer-Encoding": "chunked",
          "Content-Length": "42",
          "Keep-Alive": "timeout=5",
          TE: "trailers",
          Upgrade: "websocket",
        },
      }),
    );
    expect(result.droppedRequestHeaders).toStrictEqual(
      ["connection", "content-length", "keep-alive", "te", "transfer-encoding", "upgrade"].sort(),
    );
  });

  it("strips cookie", async () => {
    mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(defaultArgs({ headers: { Cookie: "session=abc" } }));
    expect(result.droppedRequestHeaders).toContain("cookie");
  });

  it("strips proxy-* headers", async () => {
    mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(
      defaultArgs({
        headers: { "Proxy-Authorization": "Basic xyz", "proxy-connection": "keep-alive" },
      }),
    );
    expect(result.droppedRequestHeaders).toContain("proxy-authorization");
    expect(result.droppedRequestHeaders).toContain("proxy-connection");
  });

  it("does NOT strip Authorization — it is the primary use-case", async () => {
    const spy = mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(
      defaultArgs({ headers: { Authorization: "Bearer upstream-token" } }),
    );
    // droppedRequestHeaders must not include authorization.
    expect(result.droppedRequestHeaders).not.toContain("authorization");
    // The header must be forwarded to the upstream.
    const call = firstFetchCall(spy);
    expect(call.headers.Authorization).toBe("Bearer upstream-token");
  });

  it("returns droppedRequestHeaders sorted alphabetically", async () => {
    mockFetchOnce(new Response("ok"));
    const result = await runHttpFetch(defaultArgs({ headers: { Host: "x", Cookie: "y" } }));
    const dropped = result.droppedRequestHeaders;
    expect(dropped).toStrictEqual([...dropped].sort());
  });
});

describe("runHttpFetch — response format", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responseFormat "json" parses the response body as JSON', async () => {
    mockFetchOnce(
      new Response('{"result":42}', { headers: { "content-type": "application/json" } }),
    );
    const result = await runHttpFetch(defaultArgs({ responseFormat: "json" }));
    expect(result.format).toBe("json");
    expect(result.body).toStrictEqual({ result: 42 });
  });

  it('responseFormat "text" returns the raw text string', async () => {
    mockFetchOnce(new Response("hello text", { headers: { "content-type": "text/plain" } }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "text" }));
    expect(result.format).toBe("text");
    expect(result.body).toBe("hello text");
  });

  it('responseFormat "binary" returns a base64-encoded string', async () => {
    const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    mockFetchOnce(new Response(bytes, { headers: { "content-type": "application/octet-stream" } }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "binary" }));
    expect(result.format).toBe("binary");
    expect(result.body).toBe(Buffer.from(bytes).toString("base64"));
  });

  it('responseFormat "auto" picks JSON when Content-Type is application/json', async () => {
    mockFetchOnce(
      new Response('{"auto":true}', { headers: { "content-type": "application/json" } }),
    );
    const result = await runHttpFetch(defaultArgs({ responseFormat: "auto" }));
    expect(result.format).toBe("json");
    expect(result.body).toStrictEqual({ auto: true });
  });

  it('responseFormat "auto" falls back to text for non-JSON content types', async () => {
    mockFetchOnce(new Response("<html>", { headers: { "content-type": "text/html" } }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "auto" }));
    expect(result.format).toBe("text");
    expect(result.body).toBe("<html>");
  });

  it('responseFormat "json" throws BAD_REQUEST with reason "response_not_json" for non-JSON bodies', async () => {
    mockFetchOnce(
      new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }),
    );
    await expect(runHttpFetch(defaultArgs({ responseFormat: "json" }))).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: expect.objectContaining({ reason: "response_not_json" }),
    });
  });
});

describe("runHttpFetch — body cap (10 MB)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responseFormat "text" with a truncated body sets truncated: true', async () => {
    // Produce a body slightly larger than the cap.
    const bigBody = "x".repeat(MAX_BODY_BYTES + 1);
    mockFetchOnce(new Response(bigBody, { headers: { "content-type": "text/plain" } }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "text" }));
    expect(result.truncated).toBe(true);
    expect(typeof result.body).toBe("string");
  });

  it('responseFormat "binary" with a truncated body sets truncated: true', async () => {
    const bigBody = "x".repeat(MAX_BODY_BYTES + 1);
    mockFetchOnce(
      new Response(bigBody, { headers: { "content-type": "application/octet-stream" } }),
    );
    const result = await runHttpFetch(defaultArgs({ responseFormat: "binary" }));
    expect(result.truncated).toBe(true);
  });

  it('responseFormat "json" with a truncated body throws BAD_REQUEST with reason "response_truncated_json"', async () => {
    const bigBody = "x".repeat(MAX_BODY_BYTES + 1);
    mockFetchOnce(new Response(bigBody, { headers: { "content-type": "application/json" } }));
    await expect(runHttpFetch(defaultArgs({ responseFormat: "json" }))).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      details: expect.objectContaining({ reason: "response_truncated_json" }),
    });
  });

  it('responseFormat "auto" with a truncated JSON response downgrades to text', async () => {
    const bigBody = "x".repeat(MAX_BODY_BYTES + 1);
    mockFetchOnce(new Response(bigBody, { headers: { "content-type": "application/json" } }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "auto" }));
    expect(result.truncated).toBe(true);
    expect(result.format).toBe("text");
  });
});

describe("runHttpFetch — response header whitelist", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not include Set-Cookie in the result headers", async () => {
    mockFetchOnce(
      new Response("ok", {
        headers: {
          "content-type": "text/plain",
          "set-cookie": "session=secret; HttpOnly",
        },
      }),
    );
    const result = await runHttpFetch(defaultArgs());
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("includes allowed response headers like content-type and cache-control", async () => {
    mockFetchOnce(
      new Response("ok", {
        headers: {
          "content-type": "text/plain",
          "cache-control": "no-cache",
          "x-internal": "secret",
        },
      }),
    );
    const result = await runHttpFetch(defaultArgs());
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.headers["cache-control"]).toBe("no-cache");
    // Non-whitelisted headers are stripped.
    expect(result.headers["x-internal"]).toBeUndefined();
  });
});

describe("runHttpFetch — redirect handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws UPSTREAM_ERROR with reason redirect_blocked when a redirect targets a private IP", async () => {
    // First response redirects to a private IP; second response should never be reached.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "http://192.168.1.1/admin" },
        }),
      )
      .mockResolvedValueOnce(new Response("should not reach here"));

    await expect(
      runHttpFetch(
        defaultArgs({
          followRedirects: true,
          maxRedirects: 5,
          url: "https://example.com/redirect",
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: expect.objectContaining({ reason: "redirect_blocked" }),
    });
  });

  it("throws UPSTREAM_ERROR with reason redirect_blocked when a redirect targets localhost", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/" },
      }),
    );

    await expect(
      runHttpFetch(
        defaultArgs({
          followRedirects: true,
          maxRedirects: 5,
          url: "https://example.com/bounce",
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: expect.objectContaining({ reason: "redirect_blocked" }),
    });
  });

  it("throws UPSTREAM_ERROR with reason redirect_invalid_location for a malformed Location header", async () => {
    // `http://[bad` is an unterminated IPv6 literal — `new URL(value, base)`
    // throws `TypeError("Invalid URL")` on it. undici's manual redirect mode
    // hands the bytes through verbatim, so the service layer must produce a
    // structured reason instead of a generic upstream error envelope.
    const malformedLocation = "http://[bad";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: malformedLocation },
      }),
    );

    await expect(
      runHttpFetch(
        defaultArgs({
          followRedirects: true,
          maxRedirects: 5,
          url: "https://example.com/bounce",
        }),
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: expect.objectContaining({
        reason: "redirect_invalid_location",
        location: malformedLocation,
      }),
    });
  });
});

describe("runHttpFetch — signal / timeout propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps an AbortError to a TIMEOUT AppError", async () => {
    mockFetchReject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();

    await expect(runHttpFetch(defaultArgs({ signal: controller.signal }))).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
    });
  });

  it("maps an already-aborted signal to TIMEOUT even when fetch resolves", async () => {
    // Simulate undici throwing an AbortError on an already-aborted signal.
    const controller = new AbortController();
    controller.abort();
    mockFetchReject(Object.assign(new Error("abort"), { name: "AbortError" }));

    await expect(runHttpFetch(defaultArgs({ signal: controller.signal }))).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
    });
  });
});

describe("runHttpFetch — body-read signal awareness (R-0000066)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts a slow drip-feed body read with TIMEOUT when the signal fires mid-stream", async () => {
    // Build a ReadableStream that emits one chunk, then stalls indefinitely.
    // Without active signal awareness in the drain loop, this would hang
    // forever (or rely on undici to cancel the stream on signal-abort).
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        // Emit one small chunk immediately so the loop enters the second read.
        streamController.enqueue(encoder.encode("first-chunk"));
        // Then never enqueue again; rely on the signal to break the loop.
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream, { headers: { "content-type": "text/plain" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    // Trigger the abort on the next tick so fetch resolves first and the
    // drain loop is already pulling chunks when the signal fires.
    setTimeout(() => {
      controller.abort();
    }, 10);

    await expect(
      runHttpFetch(defaultArgs({ signal: controller.signal, responseFormat: "text" })),
    ).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      details: expect.objectContaining({ service: "fetch", reason: "body_read_aborted" }),
    });
    expect(cancelled).toBe(true);
  });

  it("does not leak the abort listener after a successful read", async () => {
    // Verify defense-in-depth: when the drain loop completes normally the
    // listener is removed, so a long-lived signal does not accumulate
    // listeners across requests.
    const controller = new AbortController();
    const signal = controller.signal;
    const addSpy = vi.spyOn(signal, "addEventListener");
    const removeSpy = vi.spyOn(signal, "removeEventListener");

    mockFetchOnce(new Response("hello", { headers: { "content-type": "text/plain" } }));
    const result = await runHttpFetch(defaultArgs({ signal, responseFormat: "text" }));
    expect(result.body).toBe("hello");
    // The drain loop registered an `abort` listener and must have removed it
    // again. Count matched add/remove calls for the `abort` event.
    const abortAdds = addSpy.mock.calls.filter((call) => call[0] === "abort").length;
    const abortRemoves = removeSpy.mock.calls.filter((call) => call[0] === "abort").length;
    expect(abortAdds).toBeGreaterThan(0);
    expect(abortRemoves).toBe(abortAdds);
  });
});

describe("runHttpFetch — result shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns status, statusText, headers, format, body, url and droppedRequestHeaders", async () => {
    mockFetchOnce(
      new Response('{"x":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await runHttpFetch(defaultArgs({ responseFormat: "json" }));
    expect(result.status).toBe(200);
    expect(typeof result.statusText).toBe("string");
    expect(typeof result.headers).toBe("object");
    expect(result.format).toBe("json");
    expect(result.body).toStrictEqual({ x: 1 });
    expect(result.url).toBe("https://example.com/api");
    expect(Array.isArray(result.droppedRequestHeaders)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("exposes upstream 4xx/5xx status codes 1:1 (not mapped to UPSTREAM_ERROR)", async () => {
    mockFetchOnce(new Response("forbidden", { status: 403 }));
    const result = await runHttpFetch(defaultArgs({ responseFormat: "text" }));
    expect(result.status).toBe(403);
  });

  it("handles an empty response body gracefully for auto format", async () => {
    mockFetchOnce(new Response("", { headers: { "content-type": "application/json" } }));
    // Empty body is not valid JSON; auto falls back to text.
    const result = await runHttpFetch(defaultArgs({ responseFormat: "auto" }));
    expect(result.format).toBe("text");
    expect(result.body).toBe("");
  });
});
