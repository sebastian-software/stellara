import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildStaticTokenSnapshot,
  reconcileStaticTokenState,
} from "../../../src/oauth/static-token-state.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import { TEST_TOKEN_USER_A, TEST_TOKEN_USER_B } from "../helpers/test-config.js";

const ROTATED_TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const SNAPSHOT_KEY = "oauth_static_token_snapshot";

function tokenConfig(entries: Array<[string, string]>, revoked: string[] = []) {
  return { tokens: new Map(entries), revokedTokens: new Set(revoked) };
}

function seedAuthorization(storage: OAuthStorage, userId: string, suffix: string): void {
  storage.insertCode({
    code: `code-${suffix}`,
    client_id: "client",
    user_id: userId,
    code_challenge: "challenge",
    redirect_uri: "https://client.example.test/callback",
    scope: "mcp",
    expires_at: 100_000,
  });
  storage.insertRefreshToken({
    token: `refresh-${suffix}`,
    client_id: "client",
    user_id: userId,
    scope: "mcp",
    issued_at: 1,
    expires_at: 100_000,
    rotated_to: null,
  });
  storage.insertSession({
    session_id: `session-${suffix}`,
    user_id: userId,
    issued_at: 1,
    expires_at: 100_000,
  });
}

function expectAuthorization(storage: OAuthStorage, suffix: string, present: boolean): void {
  expect(storage.getCode(`code-${suffix}`) !== undefined).toBe(present);
  expect(storage.getRefreshToken(`refresh-${suffix}`) !== undefined).toBe(present);
  expect(storage.getSession(`session-${suffix}`) !== undefined).toBe(present);
}

describe("static token snapshot", () => {
  it("writes sorted lowercase users and unique sorted fingerprints without raw tokens", () => {
    const snapshot = buildStaticTokenSnapshot(
      new Map([
        [TEST_TOKEN_USER_B, "User_B"],
        [ROTATED_TOKEN, "USER_A"],
        [TEST_TOKEN_USER_A, "user_a"],
      ]),
      new Set([TEST_TOKEN_USER_B]),
    );
    const a = createHash("sha256").update(TEST_TOKEN_USER_A).digest("hex");
    const rotated = createHash("sha256").update(ROTATED_TOKEN).digest("hex");
    expect(snapshot).toStrictEqual({ version: 1, users: { user_a: [a, rotated].sort() } });
    expect(JSON.stringify(snapshot)).not.toContain(TEST_TOKEN_USER_A);
  });

  it("retains a prototype-named user as an own snapshot entry", () => {
    const snapshot = buildStaticTokenSnapshot(
      new Map([[TEST_TOKEN_USER_A, "__proto__"]]),
      new Set(),
    );
    expect(Object.hasOwn(snapshot.users, "__proto__")).toBe(true);
    expect(JSON.stringify(snapshot)).toContain('"__proto__"');
  });

  it("persists numeric-looking user IDs in lexical order", () => {
    const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      reconcileStaticTokenState(
        storage,
        tokenConfig([
          [TEST_TOKEN_USER_A, "10"],
          [TEST_TOKEN_USER_B, "2"],
        ]),
      );
      const snapshot = String(storage.getMeta(SNAPSHOT_KEY));
      expect(snapshot.indexOf('"10"')).toBeLessThan(snapshot.indexOf('"2"'));
    } finally {
      storage.close();
    }
  });

  it("clears legacy authorization state once while retaining clients, keys, and metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "stellara-token-state-"));
    const path = join(directory, "stellara.db");
    let storage = new OAuthStorage({ path, ttlSweepIntervalMs: 0 });
    try {
      storage.insertClient({
        client_id: "client",
        client_name: "Test",
        redirect_uris: "[]",
        created_at: 1,
        last_used_at: 1,
      });
      storage.insertKey({
        kid: "key",
        public_jwk: "{}",
        private_pkcs8: "private",
        algorithm: "RS256",
        created_at: 1,
        retired_at: null,
      });
      storage.getOrInitializeMeta("unrelated", "retained");
      seedAuthorization(storage, "user_a", "a");
      const config = tokenConfig([[TEST_TOKEN_USER_A, "user_a"]]);

      const first = reconcileStaticTokenState(storage, config);
      expect(first).toMatchObject({
        globallyReset: true,
        deletedCodes: 1,
        deletedRefreshTokens: 1,
        deletedSessions: 1,
      });
      expectAuthorization(storage, "a", false);
      expect(storage.getClient("client")).toBeDefined();
      expect(storage.getActiveKey()?.kid).toBe("key");
      expect(storage.getMeta("unrelated")).toBe("retained");
      const snapshot = storage.getMeta(SNAPSHOT_KEY);
      expect(snapshot).toBe(
        JSON.stringify(buildStaticTokenSnapshot(config.tokens, config.revokedTokens)),
      );

      seedAuthorization(storage, "user_a", "second");
      storage.close();
      storage = new OAuthStorage({ path, ttlSweepIntervalMs: 0 });
      expect(reconcileStaticTokenState(storage, config)).toMatchObject({
        globallyReset: false,
        invalidatedUsers: 0,
      });
      expectAuthorization(storage, "second", true);
      expect(storage.getMeta(SNAPSHOT_KEY)).toBe(snapshot);
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("invalidates only the affected user on rotation and removal", () => {
    const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      const initial = tokenConfig([
        [TEST_TOKEN_USER_A, "user_a"],
        [TEST_TOKEN_USER_B, "user_b"],
      ]);
      reconcileStaticTokenState(storage, initial);
      seedAuthorization(storage, "user_a", "a");
      seedAuthorization(storage, "user_b", "b");
      const rotated = tokenConfig([
        [ROTATED_TOKEN, "user_a"],
        [TEST_TOKEN_USER_B, "user_b"],
      ]);
      expect(reconcileStaticTokenState(storage, rotated)).toMatchObject({
        globallyReset: false,
        invalidatedUsers: 1,
        deletedCodes: 1,
        deletedRefreshTokens: 1,
        deletedSessions: 1,
      });
      expectAuthorization(storage, "a", false);
      expectAuthorization(storage, "b", true);
      expect(
        reconcileStaticTokenState(storage, tokenConfig([[ROTATED_TOKEN, "user_a"]]))
          .invalidatedUsers,
      ).toBe(1);
      expectAuthorization(storage, "b", false);
    } finally {
      storage.close();
    }
  });

  it("preserves state for add-only and normalized multi-token changes", () => {
    const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      reconcileStaticTokenState(storage, tokenConfig([[TEST_TOKEN_USER_A, "user_a"]]));
      seedAuthorization(storage, "user_a", "a");
      const additional = tokenConfig([
        [TEST_TOKEN_USER_A, "USER_A"],
        [ROTATED_TOKEN, "user_a"],
      ]);
      expect(reconcileStaticTokenState(storage, additional).invalidatedUsers).toBe(0);
      expectAuthorization(storage, "a", true);
      expect(reconcileStaticTokenState(storage, additional).invalidatedUsers).toBe(0);
      expectAuthorization(storage, "a", true);
      expect(
        reconcileStaticTokenState(storage, tokenConfig([[ROTATED_TOKEN, "user_a"]]))
          .invalidatedUsers,
      ).toBe(1);
      expectAuthorization(storage, "a", false);
    } finally {
      storage.close();
    }
  });

  it("applies current and retained revocation once and ignores unknown revoked tokens", () => {
    const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      const initial = tokenConfig([
        [TEST_TOKEN_USER_A, "user_a"],
        [TEST_TOKEN_USER_B, "user_b"],
      ]);
      reconcileStaticTokenState(storage, initial);
      seedAuthorization(storage, "user_a", "a");
      seedAuthorization(storage, "user_b", "b");
      const revoked = tokenConfig([...initial.tokens], [TEST_TOKEN_USER_A, ROTATED_TOKEN]);
      expect(reconcileStaticTokenState(storage, revoked).invalidatedUsers).toBe(1);
      expectAuthorization(storage, "a", false);
      expectAuthorization(storage, "b", true);
      seedAuthorization(storage, "user_a", "again");
      expect(reconcileStaticTokenState(storage, revoked).invalidatedUsers).toBe(0);
      expectAuthorization(storage, "again", true);
    } finally {
      storage.close();
    }
  });

  it.each(["not json", '{"version":2,"users":{}}', '{"version":1,"users":{"USER_A":[]}}'])(
    "globally resets malformed or unsupported previous snapshot %s",
    (previous) => {
      const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
      try {
        const config = tokenConfig([[TEST_TOKEN_USER_A, "user_a"]]);
        reconcileStaticTokenState(storage, config);
        storage.db
          .prepare("UPDATE oauth_meta SET value = ? WHERE key = ?")
          .run(previous, SNAPSHOT_KEY);
        seedAuthorization(storage, "user_a", "a");
        expect(reconcileStaticTokenState(storage, config).globallyReset).toBe(true);
        expectAuthorization(storage, "a", false);
      } finally {
        storage.close();
      }
    },
  );

  it("rolls back all deletions and snapshot replacement after an injected SQL failure", () => {
    const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
    try {
      const initial = tokenConfig([[TEST_TOKEN_USER_A, "user_a"]]);
      reconcileStaticTokenState(storage, initial);
      const previous = storage.getMeta(SNAPSHOT_KEY);
      seedAuthorization(storage, "user_a", "a");
      storage.db.exec(
        "CREATE TRIGGER reject_session_delete BEFORE DELETE ON oauth_sessions BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      );
      expect(() =>
        reconcileStaticTokenState(storage, tokenConfig([[ROTATED_TOKEN, "user_a"]])),
      ).toThrow("injected failure");
      expectAuthorization(storage, "a", true);
      expect(storage.getMeta(SNAPSHOT_KEY)).toBe(previous);
    } finally {
      storage.close();
    }
  });
});
