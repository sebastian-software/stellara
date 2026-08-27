import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

// Two deterministic 64-char hex strings that pass the production entropy
// floor (32 chars / 16 unique chars). Distinct digit orderings ensure the
// duplicate-token guard does not fire across the two suite users.
const USER_A_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow -- deterministic unit-test fixture
const USER_B_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"; // gitleaks:allow -- deterministic unit-test fixture

function makeValidEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PORT: "9000",
    PUBLIC_BASE_URL: "https://stellara.example.test",
    FIRECRAWL_BASE_URL: "https://firecrawl.example.test",
    FIRECRAWL_API_KEY: "fc-key",
    EXA_API_KEY: "exa-key",
    QDRANT_BASE_URL: "https://qdrant.example.test",
    QDRANT_API_KEY: "qdrant-key",
    EMBEDDINGS_MODEL: "text-embedding-3-small",
    EMBEDDINGS_API_KEY: "embed-key",
    EMBEDDINGS_DIMENSIONS: "1536",
    STELLARA_TOKEN_USER_A: USER_A_TOKEN,
    STELLARA_TOKEN_USER_B: USER_B_TOKEN,
    ...extra,
  };
}

describe("loadConfig", () => {
  it("parses a valid environment with two STELLARA_TOKEN entries", () => {
    const config = loadConfig(makeValidEnv());

    expect(config.tokens.size).toBe(2);
    expect(config.tokens.get(USER_A_TOKEN)).toBe("user_a");
    expect(config.tokens.get(USER_B_TOKEN)).toBe("user_b");
  });

  it("coerces PORT and EMBEDDINGS_DIMENSIONS to numbers", () => {
    const config = loadConfig(makeValidEnv({ PORT: "1234", EMBEDDINGS_DIMENSIONS: "512" }));

    expect(config.port).toBe(1234);
    expect(config.embeddingsDimensions).toBe(512);
  });

  it("throws when no STELLARA_TOKEN_* variables are present", () => {
    const env = makeValidEnv();
    delete env.STELLARA_TOKEN_USER_A;
    delete env.STELLARA_TOKEN_USER_B;

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("throws when a required upstream URL is missing", () => {
    // FIRECRAWL_BASE_URL remains required even after Exa/Qdrant/Embeddings
    // became optional, so dropping it must still produce a ConfigError.
    const env = makeValidEnv();
    delete env.FIRECRAWL_BASE_URL;

    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("treats empty-string env values as absent (dotenv compatibility)", () => {
    // Docker `--env-file` and dotenv both materialize missing values as
    // empty strings. The config loader must coalesce them to `undefined`
    // so optional features don't trip `.min(1)` / `.url()` validators.
    const config = loadConfig(
      makeValidEnv({
        EXA_API_KEY: "",
        QDRANT_BASE_URL: "",
        QDRANT_API_KEY: "",
        EMBEDDINGS_API_KEY: "",
      }),
    );
    expect(config.exaApiKey).toBeUndefined();
    expect(config.qdrantBaseUrl).toBeUndefined();
    expect(config.qdrantApiKey).toBeUndefined();
    expect(config.embeddingsApiKey).toBeUndefined();
    expect(config.features).toStrictEqual({
      exa: false,
      firecrawl: true,
      embeddings: false,
      memory: false,
      fetch: true,
      playwright: true,
      domain: true,
    });
  });

  it("activates every feature when all credentials are present", () => {
    const config = loadConfig(makeValidEnv());
    expect(config.features).toStrictEqual({
      exa: true,
      firecrawl: true,
      embeddings: true,
      memory: true,
      fetch: true,
      playwright: true,
      domain: true,
    });
  });

  it("rejects a half-configured Qdrant trio", () => {
    const baseOnly = makeValidEnv();
    delete baseOnly.QDRANT_API_KEY;
    expect(() => loadConfig(baseOnly)).toThrow(ConfigError);

    const keyOnly = makeValidEnv();
    delete keyOnly.QDRANT_BASE_URL;
    expect(() => loadConfig(keyOnly)).toThrow(ConfigError);
  });

  it("rejects Qdrant without EMBEDDINGS_API_KEY (memory needs both)", () => {
    const env = makeValidEnv();
    delete env.EMBEDDINGS_API_KEY;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("applies sensible OpenAI defaults for EMBEDDINGS_MODEL/DIMENSIONS", () => {
    const env = makeValidEnv();
    delete env.EMBEDDINGS_MODEL;
    delete env.EMBEDDINGS_DIMENSIONS;
    const config = loadConfig(env);
    expect(config.embeddingsModel).toBe("text-embedding-3-small");
    expect(config.embeddingsDimensions).toBe(1536);
  });

  it("throws when PUBLIC_BASE_URL is not a URL", () => {
    expect(() => loadConfig(makeValidEnv({ PUBLIC_BASE_URL: "not-a-url" }))).toThrow(ConfigError);
  });

  it("throws when two users share the same bearer token value", () => {
    const env = makeValidEnv({ STELLARA_TOKEN_USER_B: USER_A_TOKEN });
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("applies defaults for optional fields", () => {
    const env = makeValidEnv();
    delete env.PORT;
    delete env.LOG_LEVEL;
    delete env.QDRANT_COLLECTION;
    delete env.RATE_LIMIT_MAX;

    const config = loadConfig(env);
    expect(config.port).toBe(8787);
    expect(config.logLevel).toBe("info");
    expect(config.qdrantCollection).toBe("stellara-memory");
    expect(config.rateLimitMax).toBe(60);
    expect(config.oauth.cimdRateLimitPerMinute).toBe(10);
    expect(config.oauth.cimdMaxInFlight).toBe(16);
    expect(config.oauth.cimdCacheMaxEntries).toBe(512);
  });

  it("parses positive CIMD egress limits", () => {
    const config = loadConfig(
      makeValidEnv({
        STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE: "7",
        STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT: "4",
        STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES: "128",
      }),
    );
    expect(config.oauth).toMatchObject({
      cimdRateLimitPerMinute: 7,
      cimdMaxInFlight: 4,
      cimdCacheMaxEntries: 128,
    });
  });

  it.each([
    "STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE",
    "STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT",
    "STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES",
  ])("rejects non-positive %s", (key) => {
    expect(() => loadConfig(makeValidEnv({ [key]: "0" }))).toThrow(ConfigError);
  });

  it("defaults trustedProxyCidrs to loopback only", () => {
    const env = makeValidEnv();
    delete env.TRUSTED_PROXY_CIDRS;

    const config = loadConfig(env);
    expect(config.trustedProxyCidrs).toStrictEqual(["127.0.0.1/8", "::1/128"]);
  });

  it("parses TRUSTED_PROXY_CIDRS as a trimmed array of entries", () => {
    const config = loadConfig(
      makeValidEnv({ TRUSTED_PROXY_CIDRS: " 172.18.0.0/16 , 10.0.0.0/8 ,::1/128 " }),
    );
    expect(config.trustedProxyCidrs).toStrictEqual(["172.18.0.0/16", "10.0.0.0/8", "::1/128"]);
  });

  it("rejects whitespace-only TRUSTED_PROXY_CIDRS as ConfigError", () => {
    // Empty string is now coalesced to undefined by `normalizeEnv`, which
    // falls back onto the loopback default — that path stays covered by the
    // "defaults trustedProxyCidrs to loopback only" test above. Whitespace-
    // only values are still rejected because they survive normalization.
    expect(() => loadConfig(makeValidEnv({ TRUSTED_PROXY_CIDRS: " , " }))).toThrow(ConfigError);
  });

  it("rejects syntactically invalid CIDR entries", () => {
    expect(() => loadConfig(makeValidEnv({ TRUSTED_PROXY_CIDRS: "not-a-cidr" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(makeValidEnv({ TRUSTED_PROXY_CIDRS: "127.0.0.1/8,bogus" }))).toThrow(
      ConfigError,
    );
  });

  it("rejects bearer tokens that are too short (§6.3 entropy floor)", () => {
    expect(() => loadConfig(makeValidEnv({ STELLARA_TOKEN_ALICE: "abc" }))).toThrow(ConfigError);
  });

  it("rejects bearer tokens with too few unique characters", () => {
    // 40 chars but only one distinct character — trivially guessable.
    const lowEntropy = "a".repeat(40);
    expect(() => loadConfig(makeValidEnv({ STELLARA_TOKEN_ALICE: lowEntropy }))).toThrow(
      ConfigError,
    );
  });

  it("surfaces the userId in the ConfigError issues", () => {
    expect(() => loadConfig(makeValidEnv({ STELLARA_TOKEN_ALICE: "abc" }))).toThrow(
      expect.objectContaining({
        name: "ConfigError",
        issues: expect.objectContaining({
          STELLARA_TOKEN_: expect.arrayContaining([expect.stringContaining("alice")]),
        }),
      }),
    );
  });

  it("includes a `openssl rand -hex` hint in the ConfigError issues", () => {
    expect(() => loadConfig(makeValidEnv({ STELLARA_TOKEN_ALICE: "abc" }))).toThrow(
      expect.objectContaining({
        name: "ConfigError",
        issues: expect.objectContaining({
          STELLARA_TOKEN_: expect.arrayContaining([
            expect.stringContaining("openssl rand -hex 48"),
          ]),
        }),
      }),
    );
  });

  it("accepts a 64-char hex bearer token (openssl rand -hex 32 output)", () => {
    // Distinct from USER_A_TOKEN/USER_B_TOKEN so the duplicate-token guard
    // does not fire when this token is added alongside the suite defaults.
    const strong = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const config = loadConfig(makeValidEnv({ STELLARA_TOKEN_BOB: strong }));
    expect(config.tokens.get(strong)).toBe("bob");
  });

  // ---------------------------------------------------------------------------
  // Plan 0012 — STELLARA_PLAYWRIGHT_STEALTH
  // ---------------------------------------------------------------------------

  it("defaults playwright.stealth to true when STELLARA_PLAYWRIGHT_STEALTH is absent", () => {
    const env = makeValidEnv();
    delete env.STELLARA_PLAYWRIGHT_STEALTH;
    const config = loadConfig(env);
    expect(config.playwright.stealth).toBe(true);
  });

  it("parses STELLARA_PLAYWRIGHT_STEALTH=false as false", () => {
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "false" }));
    expect(config.playwright.stealth).toBe(false);
  });

  it("parses STELLARA_PLAYWRIGHT_STEALTH=0 as false", () => {
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "0" }));
    expect(config.playwright.stealth).toBe(false);
  });

  it("parses STELLARA_PLAYWRIGHT_STEALTH=true as true", () => {
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "true" }));
    expect(config.playwright.stealth).toBe(true);
  });

  it("parses STELLARA_PLAYWRIGHT_STEALTH=FALSE (uppercase) as false", () => {
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "FALSE" }));
    expect(config.playwright.stealth).toBe(false);
  });

  it("parses any non-false/non-zero string as true (transform pattern)", () => {
    // The .string().transform() pattern in config.ts treats every value that
    // is not "false" or "0" as truthy — consistent with the other bool env vars.
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "anything-else" }));
    expect(config.playwright.stealth).toBe(true);
  });

  it("parses STELLARA_PLAYWRIGHT_STEALTH=1 as true", () => {
    const config = loadConfig(makeValidEnv({ STELLARA_PLAYWRIGHT_STEALTH: "1" }));
    expect(config.playwright.stealth).toBe(true);
  });
});
