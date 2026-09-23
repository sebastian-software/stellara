# Runtime configuration

This is the operator reference for Stellara's runtime environment. Copy
`.env.example` to an untracked `.env`, replace its credential placeholders, and
start or recreate the process or container. `src/config.ts` validates these
values at startup. **Every runtime environment change requires a process or
container restart; there is no hot reload.** An exact empty value is treated
as absent. Whitespace-only values are still supplied values: they may fail URL,
credential, or numeric validation, rather than selecting a default.

The fixed keys below are the keys accepted by the configuration schema. The
default column describes the application default; the container may supply a
different value, notably `NODE_ENV=production` and `STELLARA_DATA_DIR=/data`.
“Optional” means the key can be omitted, though a dependency in the last
column may make it required for a selected feature. Positive integers are
decimal values greater than zero. Secrets must stay out of version control and
logs.

<!-- runtime-config-keys:start -->
| Key | Default | Requirement and accepted form | Effect, dependency, or security note |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` | Set `production` for deployment; the container does so. Controls secure OAuth cookies and development error detail. |
| `PORT` | `8787` | Positive integer | Container and proxy forwarding must use the same port. |
| `PUBLIC_BASE_URL` | None | Required URL | Public origin used for OAuth discovery, redirects, JWT issuer, and resource audience. Use the client-facing HTTPS origin in production. |
| `FIRECRAWL_BASE_URL` | None | Required URL | Firecrawl endpoint; required even when other tool families are unused. |
| `FIRECRAWL_API_KEY` | None | Required nonempty string | Upstream secret; protect it as a credential. |
| `EXA_API_KEY` | None | Optional nonempty string | Enables Exa search and research tools when present. |
| `QDRANT_BASE_URL` | None | Optional URL | Must be supplied with `QDRANT_API_KEY` and `EMBEDDINGS_API_KEY` for memory tools. |
| `QDRANT_API_KEY` | None | Optional nonempty string | Must be supplied with `QDRANT_BASE_URL`; protect it as a credential. |
| `QDRANT_COLLECTION` | `stellara-memory` | Nonempty string | Collection must match the embedding dimensions; a mismatch fails the boot-time probe. |
| `EMBEDDINGS_PROVIDER` | `openai` | Nonempty string; only `openai` is implemented | An unsupported provider fails when embeddings are enabled. |
| `EMBEDDINGS_MODEL` | `text-embedding-3-small` | Nonempty string | Choose a model that supports the configured dimensions; changing model or dimensions may require a Qdrant collection migration. |
| `EMBEDDINGS_API_KEY` | None | Optional nonempty string | Enables embeddings; required when Qdrant is configured. Protect it as a credential. |
| `EMBEDDINGS_DIMENSIONS` | `1536` | Positive integer | Must match model output and the Qdrant collection vector size. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` | More verbose logging can expose operational context; tokens are redacted by application logging. |
| `REQUEST_TIMEOUT_MS` | `90000` | Positive integer milliseconds | Deadline for **graceful shutdown** before forced exit; this is not a per-request or per-tool timeout. |
| `RATE_LIMIT_MAX` | `60` | Positive integer | Maximum authenticated requests per `RATE_LIMIT_WINDOW_MS` window, keyed by user ID. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Positive integer milliseconds | Authenticated request rate-limit window. |
| `UNAUTH_RATE_LIMIT_MAX` | `10` | Positive integer | Maximum requests with no usable Bearer header per source IP and window. Invalid or revoked Bearer attempts are not counted by this tier. |
| `UNAUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Positive integer milliseconds | No-Bearer request rate-limit window. The counter is in process memory and resets on restart. |
| `STELLARA_REVOKED_TOKENS` | Empty | Comma-separated exact token values; empty fragments ignored | Rejects listed static tokens for direct Bearer and OAuth login after restart. Exact listed JWT values are rejected too. Treat the list as secret. |
| `STELLARA_DATA_DIR` | `/data` | Nonempty directory path | Holds `stellara.db` with clients, signing keys, sessions, refresh tokens, and token fingerprints. Persist and protect the directory and backups. |
| `STELLARA_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Positive integer seconds | Lifetime of newly issued access JWTs. Existing JWT expiry is unchanged by a later TTL edit. |
| `STELLARA_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Positive integer seconds | Lifetime of newly issued refresh tokens. Existing rows keep their recorded expiry. |
| `STELLARA_OAUTH_SESSION_TTL_SECONDS` | `43200` | Positive integer seconds | Lifetime for new login sessions, with sliding renewal after approximately one hour of use. Existing expiry is not rewritten at boot. |
| `STELLARA_OAUTH_DCR_RATE_LIMIT_PER_HOUR` | `5` | Positive integer | Per-IP dynamic client registration limit. |
| `STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE` | `10` | Positive integer | Per-IP limit for real Client ID Metadata Document cache misses. |
| `STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT` | `16` | Positive integer | Process-wide concurrent CIMD fetch limit. |
| `STELLARA_OAUTH_CIMD_CACHE_MAX_ENTRIES` | `512` | Positive integer | Shared positive and negative CIMD cache capacity. |
| `STELLARA_FETCH_ENABLED` | `true` | String flag; `false` or `0` disables | Controls `web_fetch`, `web_get`, `web_graphql`, and `web_graphql_query`. Matching is case-insensitive but does not trim whitespace. |
| `STELLARA_PLAYWRIGHT_ENABLED` | `true` | String flag; `false` or `0` disables | Controls browser routes, MCP tools, and Chromium startup. Matching is case-insensitive but does not trim whitespace. |
| `STELLARA_DOMAIN_ENABLED` | `true` | String flag; trimmed `false` or `0` disables | Controls RDAP/WHOIS availability tools; WHOIS needs outbound TCP port 43. |
| `STELLARA_PLAYWRIGHT_MAX_SESSIONS` | `3` | Positive integer | Global browser-session cap; each session can consume substantial memory. |
| `STELLARA_PLAYWRIGHT_MAX_SESSIONS_PER_USER` | `1` | Positive integer | Per-user browser-session cap, also bounded by the global cap. |
| `STELLARA_PLAYWRIGHT_STEALTH` | `true` | String flag; trimmed `false` or `0` disables | Controls bundled stealth patches and browser identity; the plugin is selected during module import, so restart is essential. |
| `TRUSTED_PROXY_CIDRS` | `127.0.0.1/8,::1/128` | Nonempty comma-separated IPv4/IPv6 CIDRs | Trust only direct, controlled proxy peers. Broad ranges let clients spoof forwarded IPs, affecting audit and IP limits. |
<!-- runtime-config-keys:end -->

Feature flags treat an exact empty value as absent and use their default.
`STELLARA_FETCH_ENABLED` and `STELLARA_PLAYWRIGHT_ENABLED` lowercase the
supplied value without trimming it; `STELLARA_DOMAIN_ENABLED` and
`STELLARA_PLAYWRIGHT_STEALTH` trim before testing for `false` or `0`. Other
nonempty flag values enable the feature. This reflects the current parser and
is not a recommended way to encode booleans.

## Per-user static tokens

At least one `STELLARA_TOKEN_<USERID>` variable must contain a token. The suffix
is lowercased into the user ID; names that differ only by case can give one user
multiple tokens. Token values must have at least 32 characters and 16 distinct
characters. Generate unpredictable, high-entropy values, for example with
`openssl rand -hex 48`; the length and character checks do not prove entropy.
Do not reuse a token across users. Store token values and the revocation list as
secrets, including in environment backups.

At startup Stellara stores a versioned snapshot of **SHA-256 fingerprints** of
effective, non-revoked static tokens in `oauth_meta`. Fingerprints prevent
accidental raw-token persistence in this snapshot; SHA-256 is not password
hashing and weak tokens can be guessed offline from a database copy. The SQLite
database and its backups also contain OAuth credentials and the private signing
key, so protect both as sensitive material.

Removing or rotating a token, or newly adding its value to
`STELLARA_REVOKED_TOKENS`, invalidates that user's pending authorization codes,
refresh tokens, and login sessions at the next boot. Adding another valid token
for a user does not invalidate that user's OAuth state. Unaffected users and
OAuth clients retain their state. The first boot of the version with snapshots,
or a boot with missing, malformed, or unsupported snapshot metadata, clears all
pending codes, refresh tokens, and sessions once. It preserves registered
clients and signing keys; users must authorize again. Subsequent unchanged
boots do not repeat the invalidation.

Issued access JWTs are verified against their original `exp` and signing key.
Removing or revoking a static token does **not** immediately revoke already
issued access JWTs; they remain valid until expiry. An exact JWT value listed
in `STELLARA_REVOKED_TOKENS` is rejected at once after restart. Changing a TTL
does not retroactively change existing JWTs or stored expiry timestamps.

## Deployment, backup, and rollback

`STELLARA_PROXY_NETWORK` in `.env.example` is a **Docker Compose-only**
substitution. It names an existing external proxy network; `src/config.ts` does
not read it. Confirm the network and proxy trust before deployment. Persist
`STELLARA_DATA_DIR` across container replacement; discarding its SQLite file
removes OAuth clients and the signing key. Stop the service before copying its
SQLite database and associated WAL files, or use a SQLite-consistent backup
method. Protect and test restoration of the backup.

For this security upgrade, back up the data directory, deploy the fixed image,
and expect existing OAuth sessions and refresh tokens to require
reauthorization on the first boot. Check startup logs for the value-free
`oauth_static_token_reconciled` event and verify direct and OAuth login with
one valid token and one revoked token. A reconciliation SQL error aborts startup
without partially deleting authorization state or replacing the snapshot.

Rolling back to an older build keeps the SQLite volume and clients, but the
older code ignores the snapshot and restores its former static-token
revocation gap for OAuth login and existing OAuth state. Roll forward to the
fixed build to reconcile again. Preserve the revocation list during rollback;
do not assume the older build enforces the new behavior.

## Build metadata

`APP_VERSION` is accepted by the schema for local development (default
`0.0.0-dev`), but the production image sets it at build time. It is excluded
from the operator runtime-key inventory and `.env.example`. Do not set it in
the deployment environment as a substitute for selecting the intended image.
