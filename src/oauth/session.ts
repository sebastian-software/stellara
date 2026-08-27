/**
 * Login-session helpers for `/oauth/authorize` (plan 0004 § Session-Cookies).
 *
 * After the user submits the login form once, Stellara sets an opaque
 * 12-hour HttpOnly cookie. Subsequent `/oauth/authorize` calls within that
 * window skip the form: the cookie value is looked up in `oauth_sessions`,
 * mapped to a userId, and the flow proceeds straight to code issuance.
 *
 * Sliding renewal: when a session is older than `slidingRenewalThresholdMs`
 * (default 1h) at lookup time, its `expires_at` is pushed forward by the
 * full `ttlSeconds` so an active operator does not get logged out mid-day.
 * Below that threshold the expiry stays put to avoid hammering SQLite on
 * every single request.
 */
import { randomBytes } from "node:crypto";

import type { OAuthStorage } from "./storage.js";

/** Length of the opaque session id in bytes before hex encoding. */
const SESSION_ID_BYTES = 32;

/** Default sliding-renewal threshold: 1 hour. */
const DEFAULT_SLIDING_RENEWAL_MS = 3_600_000;

/** Construction options accepted by {@link createSessionManager}. */
export type SessionManagerOptions = {
  /** Session lifetime in seconds; default 12 h (43_200). */
  ttlSeconds: number;
  /** Re-extend the expiry only if `expires_at - now < ttl - slidingRenewalThresholdMs`. */
  slidingRenewalThresholdMs?: number;
  /** Time source override; defaults to `Date.now`. */
  now?: () => number;
};

/** Outcome of {@link SessionManager.resolveSession}. */
export type ResolveSessionResult =
  | { kind: "expired" }
  | { kind: "ok"; userId: string; sessionId: string; expiresAt: number }
  | { kind: "unknown" };

/** Public surface returned by {@link createSessionManager}. */
export type SessionManager = {
  /** Creates a new session and returns its cookie value + expiry. */
  createSession: (
    storage: OAuthStorage,
    userId: string,
  ) => { sessionId: string; expiresAt: number };
  /** Looks up a session and (if active) applies sliding renewal. */
  resolveSession: (storage: OAuthStorage, sessionId: string) => ResolveSessionResult;
  /** Forcibly invalidates a session. */
  destroySession: (storage: OAuthStorage, sessionId: string) => boolean;
};

/**
 * Creates a session manager bound to a specific TTL policy. Each app
 * instantiates one; the storage handle is injected per call so the same
 * manager can be reused in tests that swap storage between cases.
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const ttlMs = options.ttlSeconds * 1000;
  const slidingThresholdMs = options.slidingRenewalThresholdMs ?? DEFAULT_SLIDING_RENEWAL_MS;
  const now = options.now ?? Date.now;

  return {
    createSession(storage, userId) {
      const sessionId = randomBytes(SESSION_ID_BYTES).toString("hex");
      const nowMs = now();
      const expiresAt = nowMs + ttlMs;
      storage.insertSession({
        session_id: sessionId,
        user_id: userId,
        issued_at: nowMs,
        expires_at: expiresAt,
      });
      return { sessionId, expiresAt };
    },

    resolveSession(storage, sessionId) {
      const row = storage.getSession(sessionId);
      if (row === undefined) return { kind: "unknown" };
      const nowMs = now();
      if (row.expires_at <= nowMs) {
        storage.deleteSession(sessionId);
        return { kind: "expired" };
      }
      const remaining = row.expires_at - nowMs;
      // Only renew when the cookie has aged past the configured threshold —
      // avoids one SQLite UPDATE per request during active sessions.
      if (remaining < ttlMs - slidingThresholdMs) {
        const renewedExpiresAt = nowMs + ttlMs;
        storage.extendSession(sessionId, renewedExpiresAt);
        return { kind: "ok", userId: row.user_id, sessionId, expiresAt: renewedExpiresAt };
      }
      return { kind: "ok", userId: row.user_id, sessionId, expiresAt: row.expires_at };
    },

    destroySession(storage, sessionId) {
      return storage.deleteSession(sessionId);
    },
  };
}
