/** Boot-time reconciliation of OAuth authorization state with static tokens. */
import { createHash } from "node:crypto";

import type { Config } from "../config.js";
import type { AuthorizationReconciliationResult } from "./storage-reconciliation.js";
import type { OAuthStorage } from "./storage.js";

type TokenSnapshot = {
  version: 1;
  users: Record<string, string[]>;
};

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Builds a canonical snapshot without ever persisting raw token values. */
export function buildStaticTokenSnapshot(
  tokens: ReadonlyMap<string, string>,
  revokedTokens: ReadonlySet<string>,
): TokenSnapshot {
  const grouped = new Map<string, Set<string>>();
  for (const [token, rawUserId] of tokens) {
    if (revokedTokens.has(token)) continue;
    const userId = rawUserId.toLowerCase();
    const values = grouped.get(userId) ?? new Set<string>();
    values.add(fingerprint(token));
    grouped.set(userId, values);
  }
  const users = Object.fromEntries(
    [...grouped.keys()].sort().map((userId) => [userId, [...(grouped.get(userId) ?? [])].sort()]),
  );
  return { version: 1, users };
}

function isValidUsers(users: unknown): users is Record<string, string[]> {
  if (!isRecord(users)) return false;
  for (const [userId, values] of Object.entries(users)) {
    if (
      userId === "" ||
      userId !== userId.toLowerCase() ||
      !Array.isArray(values) ||
      values.length === 0
    ) {
      return false;
    }
    if (
      values.some((value) => typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) ||
      new Set(values).size !== values.length
    ) {
      return false;
    }
  }
  return true;
}

/** Returns undefined when metadata is malformed or from another version. */
function parseSnapshot(raw: string | undefined): TokenSnapshot | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const candidate = parsed;
  if (candidate.version !== 1 || Object.keys(candidate).sort().join(",") !== "users,version") {
    return undefined;
  }
  return isValidUsers(candidate.users) ? { version: 1, users: candidate.users } : undefined;
}

/**
 * An existing user loses OAuth authorization only if at least one previously
 * effective fingerprint is absent now. Added tokens leave existing state
 * intact, and repeated revocation has no effect after the first reconciliation.
 */
function usersWithRemovedTokens(
  previousRaw: string | undefined,
  current: TokenSnapshot,
): null | ReadonlySet<string> {
  const previous = parseSnapshot(previousRaw);
  if (previous === undefined) return null;
  const removed = new Set<string>();
  for (const [userId, fingerprints] of Object.entries(previous.users)) {
    const effectiveNow = new Set(Object.hasOwn(current.users, userId) ? current.users[userId] : []);
    if (fingerprints.some((value) => !effectiveNow.has(value))) {
      removed.add(userId);
    }
  }
  return removed;
}

/** JSON.stringify reorders integer-like object keys, so write keys explicitly. */
function serializeSnapshot(snapshot: TokenSnapshot): string {
  const users = Object.keys(snapshot.users)
    .sort()
    .map((userId) => `${JSON.stringify(userId)}:${JSON.stringify(snapshot.users[userId])}`)
    .join(",");
  return `{"version":1,"users":{${users}}}`;
}

/** Reconciles at each boot before OAuth routes can accept requests. */
export function reconcileStaticTokenState(
  storage: OAuthStorage,
  config: Pick<Config, "revokedTokens" | "tokens">,
): AuthorizationReconciliationResult {
  const current = buildStaticTokenSnapshot(config.tokens, config.revokedTokens);
  const nextSnapshot = serializeSnapshot(current);
  return storage.reconcileStaticTokenSnapshot(nextSnapshot, (previous) =>
    usersWithRemovedTokens(previous, current),
  );
}
