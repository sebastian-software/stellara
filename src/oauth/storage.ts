/**
 * SQLite-backed persistence for the OAuth subsystem (plan 0004, concept §6.6).
 *
 * Wraps `better-sqlite3` with a small set of typed accessors for the five
 * OAuth tables (clients, codes, refresh-tokens, sessions, signing-keys).
 * Synchronous API by design — `better-sqlite3` is a synchronous driver, and
 * OAuth flows are short single-round-trip exchanges where the simplicity wins
 * over async ergonomics.
 *
 * On construction the wrapper applies the schema migration idempotently and
 * starts a periodic TTL sweep that purges expired auth codes, refresh-tokens
 * and sessions. The sweep timer is `.unref()`ed so it never holds the process
 * alive on its own.
 */
import Database, { type Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { reconcileSnapshotInTransaction } from "./storage-reconciliation.js";

/** Default cadence at which expired rows are swept from SQLite (60s). */
const DEFAULT_TTL_SWEEP_INTERVAL_MS = 60_000;

/** Schema version baked into the `oauth_meta` table so migrations stay traceable. */
const SCHEMA_VERSION = 1;

/** Construction options accepted by {@link OAuthStorage}. */
export type OAuthStorageOptions = {
  /**
   * Filesystem path to the SQLite database. Use `":memory:"` for tests; the
   * parent directory is auto-created for on-disk paths.
   */
  path: string;
  /**
   * Sweep cadence in milliseconds. Defaults to {@link DEFAULT_TTL_SWEEP_INTERVAL_MS}.
   * Set to `0` to disable the periodic sweep entirely (tests use this to keep
   * timer assertions deterministic).
   */
  ttlSweepIntervalMs?: number;
};

/** Row shape for the `oauth_clients` table. */
export type OAuthClientRow = {
  client_id: string;
  client_name: null | string;
  redirect_uris: string;
  created_at: number;
  last_used_at: number;
};

/** Row shape for the `oauth_codes` table. */
export type OAuthCodeRow = {
  code: string;
  client_id: string;
  user_id: string;
  code_challenge: string;
  redirect_uri: string;
  scope: string;
  expires_at: number;
};

/** Row shape for the `oauth_refresh_tokens` table. */
export type OAuthRefreshTokenRow = {
  token: string;
  client_id: string;
  user_id: string;
  scope: string;
  issued_at: number;
  expires_at: number;
  rotated_to: null | string;
};

/** Row shape for the `oauth_sessions` table. */
export type OAuthSessionRow = {
  session_id: string;
  user_id: string;
  issued_at: number;
  expires_at: number;
};

/** Row shape for the `oauth_keys` table. */
export type OAuthKeyRow = {
  kid: string;
  public_jwk: string;
  private_pkcs8: string;
  algorithm: string;
  created_at: number;
  retired_at: null | number;
};

/**
 * Synchronous SQLite wrapper for the OAuth subsystem. All methods complete
 * within a single tick — callers do not need to await.
 */
export class OAuthStorage {
  /**
   * Underlying `better-sqlite3` connection. Exposed for the few cases where
   * route handlers need a raw transaction (notably the code-exchange flow in
   * `src/oauth/codes.ts`).
   */
  public readonly db: DatabaseType;
  private readonly sweepTimer: NodeJS.Timeout | undefined;

  public constructor(options: OAuthStorageOptions) {
    if (options.path !== ":memory:") {
      // Ensure the parent directory exists; useful for first-boot when the
      // data volume mount is empty.
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new Database(options.path);
    // WAL keeps the writer non-blocking for the periodic sweep while OAuth
    // requests read; foreign_keys is on so cascades behave intuitively.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.applyMigrations();

    const intervalMs = options.ttlSweepIntervalMs ?? DEFAULT_TTL_SWEEP_INTERVAL_MS;
    if (intervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.sweepExpired(Date.now());
      }, intervalMs);
      // `unref` so the timer alone cannot keep the process alive — graceful
      // shutdown via `close()` still cancels it explicitly.
      this.sweepTimer.unref();
    }
  }

  /** Closes the SQLite connection and stops the TTL sweep timer. */
  public close(): void {
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer);
    }
    this.db.close();
  }

  /**
   * Removes every row whose `expires_at` is in the past, across the three
   * TTL-bearing tables. Exposed publicly so the periodic timer can call it
   * and tests can trigger it deterministically.
   */
  public sweepExpired(now: number): void {
    this.db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM oauth_sessions WHERE expires_at < ?").run(now);
  }

  // ----- oauth_meta -----------------------------------------------------

  /** Returns an opaque metadata value without interpreting unknown keys. */
  public getMeta(key: string): string | undefined {
    return this.db
      .prepare<[string], { value: string }>("SELECT value FROM oauth_meta WHERE key = ?")
      .get(key)?.value;
  }

  /** Atomically initializes a metadata value and returns the persisted winner. */
  public getOrInitializeMeta(key: string, value: string): string {
    return this.db.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO oauth_meta (key, value) VALUES (?, ?)")
        .run(key, value);
      const persisted = this.getMeta(key);
      if (persisted === undefined) {
        throw new Error(`Failed to initialize OAuth metadata key: ${key}`);
      }
      return persisted;
    })();
  }

  /**
   * Reconciles persisted OAuth authorization state with a static-token
   * snapshot. The previous read, all three authorization-table deletions,
   * and metadata replacement share one SQLite transaction. A `null` decision
   * means the previous snapshot cannot be trusted and all authorization state
   * must be invalidated; clients, signing keys, and other metadata remain.
   */
  public reconcileStaticTokenSnapshot(
    nextSnapshot: string,
    removedUsers: (previousSnapshot: string | undefined) => null | ReadonlySet<string>,
  ) {
    return this.db.transaction(() =>
      reconcileSnapshotInTransaction(this.db, nextSnapshot, removedUsers),
    )();
  }

  // ----- oauth_clients --------------------------------------------------

  public insertClient(row: OAuthClientRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.client_id, row.client_name, row.redirect_uris, row.created_at, row.last_used_at);
  }

  public getClient(clientId: string): OAuthClientRow | undefined {
    return this.db
      .prepare<[string], OAuthClientRow>("SELECT * FROM oauth_clients WHERE client_id = ?")
      .get(clientId);
  }

  public touchClient(clientId: string, now: number): void {
    this.db
      .prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?")
      .run(now, clientId);
  }

  /** Deletes clients whose `last_used_at` is older than `cutoff`. */
  public sweepStaleClients(cutoff: number): number {
    const result = this.db.prepare("DELETE FROM oauth_clients WHERE last_used_at < ?").run(cutoff);
    return result.changes;
  }

  // ----- oauth_codes ----------------------------------------------------

  public insertCode(row: OAuthCodeRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_codes (code, client_id, user_id, code_challenge, redirect_uri, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.code,
        row.client_id,
        row.user_id,
        row.code_challenge,
        row.redirect_uri,
        row.scope,
        row.expires_at,
      );
  }

  public getCode(code: string): OAuthCodeRow | undefined {
    return this.db
      .prepare<[string], OAuthCodeRow>("SELECT * FROM oauth_codes WHERE code = ?")
      .get(code);
  }

  public deleteCode(code: string): boolean {
    const result = this.db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(code);
    return result.changes > 0;
  }

  // ----- oauth_refresh_tokens ------------------------------------------

  public insertRefreshToken(row: OAuthRefreshTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, issued_at, expires_at, rotated_to)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.token,
        row.client_id,
        row.user_id,
        row.scope,
        row.issued_at,
        row.expires_at,
        row.rotated_to,
      );
  }

  public getRefreshToken(token: string): OAuthRefreshTokenRow | undefined {
    return this.db
      .prepare<[string], OAuthRefreshTokenRow>("SELECT * FROM oauth_refresh_tokens WHERE token = ?")
      .get(token);
  }

  public markRefreshTokenRotated(oldToken: string, newToken: string): void {
    this.db
      .prepare("UPDATE oauth_refresh_tokens SET rotated_to = ? WHERE token = ?")
      .run(newToken, oldToken);
  }

  /**
   * Deletes every refresh token belonging to `(userId, clientId)`. Used both
   * for replay-detection invalidation and for forced logout. Returns the
   * number of rows removed.
   */
  public deleteRefreshTokenChain(userId: string, clientId: string): number {
    const result = this.db
      .prepare("DELETE FROM oauth_refresh_tokens WHERE user_id = ? AND client_id = ?")
      .run(userId, clientId);
    return result.changes;
  }

  /**
   * Deletes every refresh token belonging to `userId`. Used when the user's
   * `STELLARA_TOKEN_<USERID>` value is rotated so dangling refresh sessions
   * cannot outlive the credential rotation (plan 0004, security finding F1).
   */
  public deleteRefreshTokensForUser(userId: string): number {
    const result = this.db
      .prepare("DELETE FROM oauth_refresh_tokens WHERE user_id = ?")
      .run(userId);
    return result.changes;
  }

  // ----- oauth_sessions -------------------------------------------------

  public insertSession(row: OAuthSessionRow): void {
    this.db
      .prepare(
        "INSERT INTO oauth_sessions (session_id, user_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(row.session_id, row.user_id, row.issued_at, row.expires_at);
  }

  public getSession(sessionId: string): OAuthSessionRow | undefined {
    return this.db
      .prepare<[string], OAuthSessionRow>("SELECT * FROM oauth_sessions WHERE session_id = ?")
      .get(sessionId);
  }

  public extendSession(sessionId: string, expiresAt: number): void {
    this.db
      .prepare("UPDATE oauth_sessions SET expires_at = ? WHERE session_id = ?")
      .run(expiresAt, sessionId);
  }

  public deleteSession(sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM oauth_sessions WHERE session_id = ?")
      .run(sessionId);
    return result.changes > 0;
  }

  public deleteSessionsForUser(userId: string): number {
    const result = this.db.prepare("DELETE FROM oauth_sessions WHERE user_id = ?").run(userId);
    return result.changes;
  }

  // ----- oauth_keys -----------------------------------------------------

  public insertKey(row: OAuthKeyRow): void {
    this.db
      .prepare(
        `INSERT INTO oauth_keys (kid, public_jwk, private_pkcs8, algorithm, created_at, retired_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.kid,
        row.public_jwk,
        row.private_pkcs8,
        row.algorithm,
        row.created_at,
        row.retired_at,
      );
  }

  /** Returns the active (not retired) keys, newest first. */
  public listActiveKeys(): OAuthKeyRow[] {
    return this.db
      .prepare<
        unknown[],
        OAuthKeyRow
      >("SELECT * FROM oauth_keys WHERE retired_at IS NULL ORDER BY created_at DESC")
      .all();
  }

  /**
   * Picks the most recently created active key. Returns `undefined` when no
   * key has been bootstrapped yet (first boot).
   */
  public getActiveKey(): OAuthKeyRow | undefined {
    return this.listActiveKeys()[0];
  }

  // ----- migrations ----------------------------------------------------

  private applyMigrations(): void {
    // The `oauth_meta` table holds the schema version. Idempotent: every
    // boot runs the same `CREATE TABLE IF NOT EXISTS`, and the version row
    // is `INSERT OR IGNORE` so subsequent boots don't duplicate it.
    this.db.exec(SCHEMA_DDL);
    this.db
      .prepare("INSERT OR IGNORE INTO oauth_meta (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
  }
}

/**
 * Idempotent DDL for the five OAuth tables plus the `oauth_meta` registry.
 * Lifted out of {@link OAuthStorage} so the class method stays under the
 * project-wide per-function statement budget — the schema itself is one logical
 * unit, splitting it across helpers would obscure the table layout.
 */
const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS oauth_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes (expires_at);

  CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    rotated_to TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_refresh_expires ON oauth_refresh_tokens (expires_at);
  CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user_client
    ON oauth_refresh_tokens (user_id, client_id);

  CREATE TABLE IF NOT EXISTS oauth_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires ON oauth_sessions (expires_at);

  CREATE TABLE IF NOT EXISTS oauth_keys (
    kid TEXT PRIMARY KEY,
    public_jwk TEXT NOT NULL,
    private_pkcs8 TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  );
`;
