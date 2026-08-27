/**
 * Shared helpers that build a valid {@link Config} for unit tests, so each
 * test file does not have to assemble a complete env dictionary from scratch.
 *
 * The bearer tokens are deterministic 64-character hex strings: long enough
 * to pass the production entropy check (§6.3, `buildTokenMap` in
 * `src/config.ts`) while remaining stable across runs so individual test
 * files can hard-code the matching `Authorization` header value via
 * {@link TEST_TOKEN_USER_A} and {@link TEST_TOKEN_USER_B}.
 */
import { type Config, loadConfig } from "../../../src/config.js";

/**
 * 64-char hex string for the `user_a` user. All hex digits are present, so
 * unique-character count is 16 — exactly the production floor.
 */
export const TEST_TOKEN_USER_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // gitleaks:allow -- deterministic unit-test fixture

/**
 * 64-char hex string for the `user_b` user. Distinct from
 * {@link TEST_TOKEN_USER_A} (different digit order) so the production
 * "duplicate token value" guard does not fire.
 */
export const TEST_TOKEN_USER_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"; // gitleaks:allow -- deterministic unit-test fixture

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PORT: "8787",
  PUBLIC_BASE_URL: "https://stellara.example.test",
  FIRECRAWL_BASE_URL: "https://firecrawl.example.test",
  FIRECRAWL_API_KEY: "fc-key",
  EXA_API_KEY: "exa-key",
  QDRANT_BASE_URL: "https://qdrant.example.test",
  QDRANT_API_KEY: "qdrant-key",
  EMBEDDINGS_MODEL: "text-embedding-3-small",
  EMBEDDINGS_API_KEY: "embed-key",
  EMBEDDINGS_DIMENSIONS: "1536",
  LOG_LEVEL: "silent",
  // OAuth uses an in-memory SQLite for tests so the filesystem stays clean
  // and each suite starts from a pristine schema.
  STELLARA_DATA_DIR: ":memory:",
  STELLARA_TOKEN_USER_A: TEST_TOKEN_USER_A,
  STELLARA_TOKEN_USER_B: TEST_TOKEN_USER_B,
};

/** Builds a fully populated test {@link Config} with overridable fields. */
export function makeTestConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}
