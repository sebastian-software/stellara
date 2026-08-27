/**
 * Shared helpers for the integration suite — resolve the bearer token plus
 * the matching userId straight from `process.env` so each test file does not
 * have to duplicate the lookup logic.
 *
 * Convention: tests use `STELLARA_TOKEN_INTEGRATION`. The userId is derived
 * from the env-var suffix to stay aligned with `TOKEN_ENV_PREFIX` in
 * `src/config.ts` — the gateway lowercases suffixes to build its token map, so
 * the integration tests do the same.
 */
import { TOKEN_ENV_PREFIX } from "../../../src/config.js";

/**
 * Env-var name carrying the integration suite's bearer token. Exists as a
 * named export so a future test could swap users without touching every file.
 */
export const INTEGRATION_TOKEN_ENV = `${TOKEN_ENV_PREFIX}INTEGRATION` as const;

/** The lowercased userId the gateway derives from {@link INTEGRATION_TOKEN_ENV}. */
export const INTEGRATION_USER_ID = INTEGRATION_TOKEN_ENV.slice(
  TOKEN_ENV_PREFIX.length,
).toLowerCase();

/**
 * Returns the bearer token configured for the integration user. Throws when
 * the env var is missing — `loadConfig()` would fail anyway, but surfacing the
 * problem here gives a clearer error message and saves the test fixture work.
 */
export function getIntegrationToken(): string {
  const token = process.env[INTEGRATION_TOKEN_ENV];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `Integration tests require ${INTEGRATION_TOKEN_ENV} to be set (see README → Tests).`,
    );
  }
  return token;
}

/**
 * Returns the `Authorization` and `Content-Type` headers used by every
 * integration test. The bearer scheme matches RFC 6750 and the gateway's
 * `createAuthHook`.
 */
export function getIntegrationHeaders(): { authorization: string; "content-type": string } {
  return {
    authorization: `Bearer ${getIntegrationToken()}`,
    "content-type": "application/json",
  };
}
