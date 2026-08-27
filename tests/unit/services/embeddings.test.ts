import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchSpy } from "../helpers/fetch-mock.js";

import { ConfigError } from "../../../src/config.js";
import { ErrorCode } from "../../../src/errors.js";
import {
  createEmbeddingsProvider,
  OpenAIEmbeddingsProvider,
} from "../../../src/services/embeddings.js";
import {
  firstFetchCall,
  jsonResponse,
  mockFetchOnce,
  mockFetchReject,
} from "../helpers/fetch-mock.js";
import { makeTestConfig } from "../helpers/test-config.js";

describe("createEmbeddingsProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an OpenAIEmbeddingsProvider when configured for openai", () => {
    const provider = createEmbeddingsProvider(makeTestConfig());
    expect(provider).toBeInstanceOf(OpenAIEmbeddingsProvider);
    expect(provider.dimensions()).toBe(1536);
  });

  it("throws ConfigError for an unknown provider", () => {
    expect(() =>
      createEmbeddingsProvider(makeTestConfig({ EMBEDDINGS_PROVIDER: "anthropic" })),
    ).toThrow(ConfigError);
  });
});

describe("OpenAIEmbeddingsProvider.embed", () => {
  let fetchSpy: FetchSpy;

  beforeEach(() => {
    fetchSpy = mockFetchOnce(jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to /v1/embeddings with the bearer token and returns the vector", async () => {
    const provider = new OpenAIEmbeddingsProvider(makeTestConfig({ EMBEDDINGS_DIMENSIONS: "3" }));
    const vector = await provider.embed("hello world");

    expect(vector).toStrictEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = firstFetchCall(fetchSpy);
    expect(call.url).toBe("https://api.openai.com/v1/embeddings");
    expect(call.headers.authorization).toBe("Bearer embed-key");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        body: JSON.stringify({
          input: "hello world",
          model: "text-embedding-3-small",
          dimensions: 3,
        }),
      }),
    );
  });

  it("throws UPSTREAM_ERROR when the returned vector size does not match config", async () => {
    // Config asks for 1536, the mock returns a 3-element vector — the guard
    // in embed() must surface this as a clear UPSTREAM_ERROR rather than let
    // the mismatch silently propagate to Qdrant (concept §25).
    const provider = new OpenAIEmbeddingsProvider(makeTestConfig());
    await expect(provider.embed("hello world")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      details: { service: "embeddings", reason: "dimension mismatch" },
    });
  });

  it("maps fetch network failures to UPSTREAM_ERROR via mapUpstreamError", async () => {
    vi.restoreAllMocks();
    mockFetchReject(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    const provider = new OpenAIEmbeddingsProvider(makeTestConfig());
    await expect(provider.embed("hi")).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });
});

describe("OpenAIEmbeddingsProvider.probe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hits /v1/models on the happy path", async () => {
    const fetchSpy = mockFetchOnce(jsonResponse({ data: [] }));
    const provider = new OpenAIEmbeddingsProvider(makeTestConfig());
    await expect(provider.probe(new AbortController().signal)).resolves.toBeUndefined();
    expect(firstFetchCall(fetchSpy).url).toBe("https://api.openai.com/v1/models");
  });

  it("throws UPSTREAM_ERROR when the API returns 4xx", async () => {
    mockFetchOnce(new Response("forbidden", { status: 401 }));
    const provider = new OpenAIEmbeddingsProvider(makeTestConfig());
    await expect(provider.probe(new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM_ERROR,
    });
  });
});
