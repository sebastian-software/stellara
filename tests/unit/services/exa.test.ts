import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorCode } from "../../../src/errors.js";
import { ExaClient } from "../../../src/services/exa.js";
import {
  firstFetchCall,
  jsonResponse,
  mockFetchOnce,
  mockFetchReject,
} from "../helpers/fetch-mock.js";
import { makeTestConfig } from "../helpers/test-config.js";

describe("ExaClient.search", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to https://api.exa.ai/search and normalizes results", async () => {
    const fetchSpy = mockFetchOnce(
      jsonResponse({
        results: [
          {
            title: "Hello",
            url: "https://example.org/hello",
            highlights: ["a snippet"],
            score: 0.42,
            publishedDate: "2025-01-02T00:00:00Z",
          },
          { title: null, url: "https://example.org/2", text: "fallback text" },
        ],
      }),
    );
    const client = new ExaClient(makeTestConfig());
    const results = await client.search("hello world", { maxResults: 2 });

    expect(results).toStrictEqual([
      {
        title: "Hello",
        url: "https://example.org/hello",
        snippet: "a snippet",
        score: 0.42,
        publishedAt: "2025-01-02T00:00:00Z",
      },
      { title: "", url: "https://example.org/2", snippet: "fallback text" },
    ]);

    const call = firstFetchCall(fetchSpy);
    expect(call.url).toBe("https://api.exa.ai/search");
    expect(call.headers.authorization).toBe("Bearer exa-key");
    // Stellara opts into Exa's `contents.highlights` projection so each result
    // carries a 1–2-sentence snippet; without this the default Exa response
    // shape would leave `snippet` empty (see ExaClient.search docstring).
    expect(call.body).toBeDefined();
    const body: unknown = JSON.parse(String(call.body));
    expect(body).toMatchObject({
      contents: { highlights: { highlightsPerUrl: 1, numSentences: 2 } },
    });
  });

  it("maps HTTP 4xx to UPSTREAM_ERROR with the status in details", async () => {
    mockFetchOnce(new Response("bad query", { status: 400 }));
    const client = new ExaClient(makeTestConfig());
    await expect(client.search("nope", {})).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
      details: expect.objectContaining({ service: "exa", status: 400 }),
    });
  });

  it("maps an aborted signal to TIMEOUT", async () => {
    mockFetchReject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const controller = new AbortController();
    controller.abort();
    const client = new ExaClient(makeTestConfig());
    await expect(client.search("any", {}, controller.signal)).rejects.toMatchObject({
      code: ErrorCode.TIMEOUT,
      details: expect.objectContaining({ service: "exa" }),
    });
  });
});

describe("ExaClient.probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves on a 200 response", async () => {
    mockFetchOnce(jsonResponse({ results: [] }));
    const client = new ExaClient(makeTestConfig());
    await expect(client.probe(new AbortController().signal)).resolves.toBeUndefined();
  });

  it("throws UPSTREAM_ERROR on 5xx", async () => {
    mockFetchOnce(new Response("boom", { status: 500 }));
    const client = new ExaClient(makeTestConfig());
    await expect(client.probe(new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });

  it("caches a successful probe so repeat calls within TTL only hit fetch once", async () => {
    const fetchSpy = mockFetchOnce(jsonResponse({ results: [] }));
    const client = new ExaClient(makeTestConfig());

    await expect(client.probe(new AbortController().signal)).resolves.toBeUndefined();
    await expect(client.probe(new AbortController().signal)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
