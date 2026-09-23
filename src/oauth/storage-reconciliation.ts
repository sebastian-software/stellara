/** SQL operations that run inside OAuthStorage's reconciliation transaction. */
import type { Database } from "better-sqlite3";

const SNAPSHOT_KEY = "oauth_static_token_snapshot";
type AuthorizationTable = "oauth_codes" | "oauth_refresh_tokens" | "oauth_sessions";

export type AuthorizationReconciliationResult = {
  globallyReset: boolean;
  invalidatedUsers: number;
  deletedCodes: number;
  deletedRefreshTokens: number;
  deletedSessions: number;
};

function deleteAuthorizationRows(
  db: Database,
  table: AuthorizationTable,
  userIds: null | readonly string[],
): number {
  if (userIds === null) {
    return db.prepare(`DELETE FROM ${table}`).run().changes;
  }
  const statement = db.prepare(`DELETE FROM ${table} WHERE user_id = ?`);
  let deleted = 0;
  for (const userId of userIds) {
    deleted += statement.run(userId).changes;
  }
  return deleted;
}

/** Caller must hold one better-sqlite3 transaction around this entire call. */
export function reconcileSnapshotInTransaction(
  db: Database,
  nextSnapshot: string,
  removedUsers: (previousSnapshot: string | undefined) => null | ReadonlySet<string>,
): AuthorizationReconciliationResult {
  const previous = db
    .prepare<[string], { value: string }>("SELECT value FROM oauth_meta WHERE key = ?")
    .get(SNAPSHOT_KEY)?.value;
  const removed = removedUsers(previous);
  const userIds = removed === null ? null : [...removed];
  const deletedCodes = deleteAuthorizationRows(db, "oauth_codes", userIds);
  const deletedRefreshTokens = deleteAuthorizationRows(db, "oauth_refresh_tokens", userIds);
  const deletedSessions = deleteAuthorizationRows(db, "oauth_sessions", userIds);
  db.prepare(
    `INSERT INTO oauth_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SNAPSHOT_KEY, nextSnapshot);
  return {
    globallyReset: userIds === null,
    invalidatedUsers: userIds?.length ?? 0,
    deletedCodes,
    deletedRefreshTokens,
    deletedSessions,
  };
}
