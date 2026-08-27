import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSessionManager, type SessionManager } from "../../../src/oauth/session.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import { assertKind } from "./helpers.js";

const TTL_SECONDS = 43_200; // 12 h
const SLIDING_THRESHOLD_MS = 3_600_000; // 1 h

function setupSessions(): {
  storage: OAuthStorage;
  manager: SessionManager;
  advance: (ms: number) => void;
  clock: () => number;
} {
  const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  let nowMs = 1_000_000;
  const manager = createSessionManager({
    ttlSeconds: TTL_SECONDS,
    slidingRenewalThresholdMs: SLIDING_THRESHOLD_MS,
    now: () => nowMs,
  });
  return {
    storage,
    manager,
    clock(): number {
      return nowMs;
    },
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

describe("oauth/session", () => {
  let env: ReturnType<typeof setupSessions>;

  beforeEach(() => {
    env = setupSessions();
  });

  afterEach(() => {
    env.storage.close();
  });

  it("creates a session with a hex id and 12 h expiry", () => {
    const session = env.manager.createSession(env.storage, "user_a");
    expect(session.sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(session.expiresAt).toBe(env.clock() + TTL_SECONDS * 1000);
    expect(env.storage.getSession(session.sessionId)?.user_id).toBe("user_a");
  });

  it("resolves an active session and returns the userId", () => {
    const created = env.manager.createSession(env.storage, "user_a");
    const resolved = env.manager.resolveSession(env.storage, created.sessionId);
    expect(resolved).toMatchObject({ kind: "ok", userId: "user_a" });
  });

  it("does NOT renew the expiry within the sliding threshold", () => {
    const created = env.manager.createSession(env.storage, "user_a");
    env.advance(SLIDING_THRESHOLD_MS / 2);
    const resolved = env.manager.resolveSession(env.storage, created.sessionId);
    assertKind(resolved, "ok");
    expect(resolved.expiresAt).toBe(created.expiresAt);
  });

  it("renews the expiry once the session ages past the sliding threshold", () => {
    const created = env.manager.createSession(env.storage, "user_a");
    env.advance(SLIDING_THRESHOLD_MS + 1000);
    const resolved = env.manager.resolveSession(env.storage, created.sessionId);
    assertKind(resolved, "ok");
    expect(resolved.expiresAt).toBe(env.clock() + TTL_SECONDS * 1000);
    expect(resolved.expiresAt).toBeGreaterThan(created.expiresAt);
  });

  it("returns 'expired' and removes the row when the session is past its TTL", () => {
    const created = env.manager.createSession(env.storage, "user_a");
    env.advance(TTL_SECONDS * 1000 + 1);
    const resolved = env.manager.resolveSession(env.storage, created.sessionId);
    expect(resolved.kind).toBe("expired");
    expect(env.storage.getSession(created.sessionId)).toBeUndefined();
  });

  it("returns 'unknown' for a session id that does not exist", () => {
    const resolved = env.manager.resolveSession(env.storage, "no-such-session");
    expect(resolved.kind).toBe("unknown");
  });

  it("destroySession removes the session and returns true on success", () => {
    const created = env.manager.createSession(env.storage, "user_a");
    expect(env.manager.destroySession(env.storage, created.sessionId)).toBe(true);
    expect(env.storage.getSession(created.sessionId)).toBeUndefined();
    // Second destroy on the same id is a no-op.
    expect(env.manager.destroySession(env.storage, created.sessionId)).toBe(false);
  });
});
