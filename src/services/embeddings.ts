/**
 * Embedding-provider abstraction for Stellara (concept §11).
 *
 * Exports the {@link EmbeddingsProvider} interface and a concrete
 * {@link OpenAIEmbeddingsProvider} implementation that talks to the OpenAI
 * `/v1/embeddings` endpoint. The factory {@link createEmbeddingsProvider}
 * selects an implementation based on `config.embeddingsProvider`; right now
 * only `"openai"` is supported (other values throw a {@link ConfigError}).
 */
import { type Config, ConfigError } from "../config.js";
import { AppError, ErrorCode, mapUpstreamError } from "../errors.js";
import { ensureOk } from "./http.js";

/** Base URL for the OpenAI HTTP API used by {@link OpenAIEmbeddingsProvider}. */
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Provider-agnostic contract every embedding backend must satisfy.
 *
 * - `embed(text)` returns a numeric vector of length `dimensions()`.
 * - `dimensions()` returns the vector size baked into the configuration so
 *   downstream code (Qdrant collection creation, migration script) can use it
 *   without an extra round-trip.
 * - `probe(signal)` is the lightweight liveness check called by `/ready`.
 */
export type EmbeddingsProvider = {
  /** Returns the embedding vector for `text`. */
  embed: (text: string, signal?: AbortSignal) => Promise<number[]>;
  /** Returns the vector dimension this provider emits. */
  dimensions: () => number;
  /** Lightweight readiness check for `GET /ready` — throws on failure. */
  probe: (signal: AbortSignal) => Promise<void>;
};

/** Shape of the OpenAI `/v1/embeddings` response we depend on (all optional). */
type EmbeddingsRoot = {
  data?: ReadonlyArray<{ embedding?: readonly number[] }>;
};

/** Narrows `value` to {@link EmbeddingsRoot} via a runtime check. */
function isEmbeddingsRoot(value: unknown): value is EmbeddingsRoot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the first embedding vector from an OpenAI `/v1/embeddings`
 * response. Returns `undefined` when the response shape disagrees so the
 * caller can surface a clear error.
 */
function extractEmbedding(data: unknown): number[] | undefined {
  if (!isEmbeddingsRoot(data)) return undefined;
  const first = data.data?.[0];
  const embedding = first?.embedding;
  if (!Array.isArray(embedding)) return undefined;
  return embedding.filter((entry): entry is number => typeof entry === "number");
}

/**
 * OpenAI-compatible {@link EmbeddingsProvider}. Uses `fetch` so the runtime's
 * `AbortSignal` plumbing flows through naturally; all errors funnel through
 * {@link mapUpstreamError} to keep the error envelope consistent.
 */
export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensionCount: number;

  public constructor(config: Config) {
    if (config.embeddingsApiKey === undefined) {
      // Defensive guard: see ExaClient for rationale. The embeddings feature
      // flag (`Config.features.embeddings`) is the canonical gate.
      throw new ConfigError("Embeddings API key missing", {
        EMBEDDINGS_API_KEY: [
          "EMBEDDINGS_API_KEY is required to construct OpenAIEmbeddingsProvider",
        ],
      });
    }
    this.apiKey = config.embeddingsApiKey;
    this.model = config.embeddingsModel;
    this.dimensionCount = config.embeddingsDimensions;
  }

  public dimensions(): number {
    return this.dimensionCount;
  }

  public async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    try {
      const response = await fetch(`${OPENAI_API_BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        // `dimensions` is honored by `text-embedding-3-*` models and is the
        // only way to make OpenAI return a non-default vector size; without
        // it, a config like `text-embedding-3-small` + `EMBEDDINGS_DIMENSIONS=
        // 1024` would silently drift from the Qdrant collection size (§25).
        body: JSON.stringify({ input: text, model: this.model, dimensions: this.dimensionCount }),
        signal,
      });
      await ensureOk(response, "embeddings");
      const data: unknown = await response.json();
      const embedding = extractEmbedding(data);
      if (embedding === undefined) {
        throw new AppError({
          code: ErrorCode.UPSTREAM_ERROR,
          details: { service: "embeddings", reason: "missing embedding in response" },
        });
      }
      if (embedding.length !== this.dimensionCount) {
        throw new AppError({
          code: ErrorCode.UPSTREAM_ERROR,
          details: {
            service: "embeddings",
            reason: "dimension mismatch",
            expected: this.dimensionCount,
            received: embedding.length,
          },
        });
      }
      return embedding;
    } catch (error) {
      throw mapUpstreamError(error, { service: "embeddings", signal });
    }
  }

  public async probe(signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(`${OPENAI_API_BASE_URL}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
        },
        signal,
      });
      await ensureOk(response, "embeddings");
    } catch (error) {
      throw mapUpstreamError(error, { service: "embeddings", signal });
    }
  }
}

/**
 * Resolves the configured {@link EmbeddingsProvider}. Throws
 * {@link ConfigError} when `config.embeddingsProvider` names an unsupported
 * backend so misconfiguration fails fast during boot (concept §11, §25).
 */
export function createEmbeddingsProvider(config: Config): EmbeddingsProvider {
  if (config.embeddingsProvider === "openai") {
    return new OpenAIEmbeddingsProvider(config);
  }
  throw new ConfigError(`Unsupported embeddings provider: "${config.embeddingsProvider}"`, {
    EMBEDDINGS_PROVIDER: [
      `Only "openai" is supported in v1; received "${config.embeddingsProvider}".`,
    ],
  });
}
