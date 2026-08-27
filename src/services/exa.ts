/**
 * Exa API client wrapper used by `/tools/search` and `/tools/research`.
 *
 * Schritt 3 only needs the wrapper contract (auth header, abort-signal
 * propagation, error mapping, readiness probe). The exact Exa request body
 * shape is fine-tuned in Schritt 4 once the `/tools/search` Zod schema lands.
 */
import { type Config, ConfigError } from "../config.js";
import { mapUpstreamError } from "../errors.js";
import { ensureOk } from "./http.js";

/** Base URL for the Exa REST API. */
const EXA_API_BASE_URL = "https://api.exa.ai";

/**
 * Lifetime of a cached {@link ExaClient.probe} result in milliseconds.
 *
 * Repeated readiness checks would otherwise issue an upstream `/search` call
 * each time. Caching the probe outcome for 30 s bounds readiness traffic while
 * still detecting real outages with at most 30 s of staleness.
 */
const PROBE_CACHE_TTL_MS = 30_000;

type ProbeCacheEntry =
  | { kind: "error"; error: unknown; expiresAt: number }
  | { kind: "ok"; expiresAt: number };

/** Options accepted by {@link ExaClient.search}. */
export type ExaSearchOptions = {
  /** Maximum number of results to return — Exa caps this at 100. */
  maxResults?: number;
  /** Search type — `"auto"` lets Exa pick neural vs. keyword. */
  type?: "auto" | "keyword" | "neural";
};

/** Single result returned by {@link ExaClient.search}. */
export type ExaSearchResult = {
  /** Page title as returned by Exa (may be empty for some sources). */
  title: string;
  /** Canonical URL of the result. */
  url: string;
  /** Highlight or snippet preview from the search engine. */
  snippet: string;
  /** Relevance score (only present for neural results). */
  score?: number;
  /** ISO-8601 publication date when Exa reports one. */
  publishedAt?: string;
};

type ExaRawResult = {
  title?: null | string;
  url?: null | string;
  text?: null | string;
  highlights?: null | readonly string[];
  score?: null | number;
  publishedDate?: null | string;
};

type ExaRoot = {
  results?: readonly ExaRawResult[];
};

function isExaRoot(value: unknown): value is ExaRoot {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExaRawResult(value: unknown): value is ExaRawResult {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResult(raw: unknown): ExaSearchResult | undefined {
  if (!isExaRawResult(raw)) return undefined;
  const snippet = raw.highlights?.[0] ?? raw.text ?? "";
  const result: ExaSearchResult = {
    title: raw.title ?? "",
    url: raw.url ?? "",
    snippet,
  };
  if (typeof raw.score === "number") result.score = raw.score;
  if (typeof raw.publishedDate === "string" && raw.publishedDate !== "") {
    result.publishedAt = raw.publishedDate;
  }
  return result;
}

/** REST wrapper around Exa with abort-signal propagation and error mapping. */
export class ExaClient {
  private readonly apiKey: string;

  /**
   * In-memory cache for the latest {@link ExaClient.probe} outcome. Shared
   * across all probe callers on this instance — see {@link PROBE_CACHE_TTL_MS}.
   */
  private probeCache: ProbeCacheEntry | undefined;

  public constructor(config: Config) {
    if (config.exaApiKey === undefined) {
      // Defensive guard: callers should consult `Config.features.exa` before
      // instantiating this client. Reaching this branch indicates a
      // bootstrap-time wiring bug, so we surface it as a ConfigError instead
      // of letting an undefined credential propagate into the upstream call.
      throw new ConfigError("Exa API key missing", {
        EXA_API_KEY: ["EXA_API_KEY is required to construct ExaClient"],
      });
    }
    this.apiKey = config.exaApiKey;
  }

  /**
   * Runs a search against Exa.
   *
   * The request opts into Exa's `contents.highlights` projection so each
   * result carries a short 1–2-sentence snippet. Without this, Exa's default
   * response shape contains only `title`/`url`/`publishedDate` and Stellara's
   * `snippet` field would fall back to the empty string — see
   * {@link normalizeResult}.
   */
  public async search(
    query: string,
    opts: ExaSearchOptions,
    signal?: AbortSignal,
  ): Promise<ExaSearchResult[]> {
    try {
      const response = await fetch(`${EXA_API_BASE_URL}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          query,
          numResults: opts.maxResults,
          type: opts.type,
          contents: {
            highlights: { highlightsPerUrl: 1, numSentences: 2 },
          },
        }),
        signal,
      });
      await ensureOk(response, "exa");
      const data: unknown = await response.json();
      const rawResults = isExaRoot(data) && Array.isArray(data.results) ? data.results : [];
      const normalized: ExaSearchResult[] = [];
      for (const entry of rawResults) {
        const result = normalizeResult(entry);
        if (result !== undefined) normalized.push(result);
      }
      return normalized;
    } catch (error) {
      throw mapUpstreamError(error, { service: "exa", signal });
    }
  }

  /**
   * Lightweight readiness probe — issues a minimal search to validate API key
   * and network reachability without burning meaningful Exa quota.
   *
   * Result caching:
   * - Successful probes are cached as `ok` for {@link PROBE_CACHE_TTL_MS}
   *   (30 s). Within that window, repeat callers receive an immediate resolve
   *   without hitting Exa.
   * - Failures are cached as the original (already-mapped) error and re-thrown
   *   to subsequent callers for the same window. This is the explicit
   *   trade-off: `/ready` may report a stale Exa status for up to 30 s after a
   *   real recovery, but avoids repeating an upstream `/search` call for every
   *   readiness check.
   *
   * If a cached entry would be served but `signal` is already aborted, the
   * call short-circuits with the mapped abort error instead, matching the
   * behavior `fetch` would produce on an uncached call.
   */
  public async probe(signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const cached = this.probeCache;
    if (cached !== undefined && cached.expiresAt > now) {
      if (signal.aborted) {
        throw mapUpstreamError(signal.reason ?? new Error("aborted"), {
          service: "exa",
          signal,
        });
      }
      if (cached.kind === "ok") return;
      throw cached.error;
    }
    try {
      const response = await fetch(`${EXA_API_BASE_URL}/search`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ query: "stellara readiness probe", numResults: 1 }),
        signal,
      });
      await ensureOk(response, "exa");
      this.probeCache = { kind: "ok", expiresAt: Date.now() + PROBE_CACHE_TTL_MS };
    } catch (error) {
      const mapped = mapUpstreamError(error, { service: "exa", signal });
      this.probeCache = {
        kind: "error",
        error: mapped,
        expiresAt: Date.now() + PROBE_CACHE_TTL_MS,
      };
      throw mapped;
    }
  }

  /**
   * Gibt die HTTP-Anfrage-Header für alle Exa-API-Aufrufe zurück.
   *
   * **Aktuell verwendetes Format:** `Authorization: Bearer <apiKey>`
   *
   * Die Exa-API akzeptiert laut Dokumentation alternativ auch den Header
   * `x-api-key: <apiKey>` ohne Bearer-Präfix. Beide Varianten gelten zum
   * Zeitpunkt der Implementierung als gültig; welche bevorzugt wird, ist
   * nicht abschließend dokumentiert.
   *
   * @todo Verifizieren, welches Header-Format die Exa-API tatsächlich
   * erwartet, sobald die Integrationssuite erstmals mit Live-Credentials
   * ausgeführt wird. Bei 401-Fehlern zuerst `x-api-key` als Alternative
   * testen.
   */
  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
  }
}
