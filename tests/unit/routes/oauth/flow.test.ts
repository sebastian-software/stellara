/**
 * End-to-end OAuth flow against an in-memory Fastify app.
 *
 * Walks every endpoint the MCP spec requires: discovery → DCR → authorize
 * (login form + submit + redirect) → token exchange → JWT bearer against a
 * tool route. Negative paths cover PKCE mismatch, refresh-token replay,
 * mismatched audience and unknown clients.
 */
import type { FastifyInstance } from "fastify";

import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_OAUTH_CLIENT_ID_LENGTH } from "../../../../src/oauth/client-id.js";
import { buildApp } from "../../../../src/server.js";
import { makeTestConfig, TEST_TOKEN_USER_A } from "../../helpers/test-config.js";

const REDIRECT_URI = "http://localhost:6274/callback";
const SCOPE = "mcp";
const RESOURCE = "https://stellara.example.test/mcp";

type DcrResponse = {
  client_id: string;
  redirect_uris: string[];
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function buildCimdAuthorizeUrl(clientId: string, challenge: string): string {
  return `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(
    REDIRECT_URI,
  )}&scope=${SCOPE}&state=limits&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`;
}

async function resolved<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      resolve(value);
    });
  });
}

async function registerClient(app: FastifyInstance): Promise<DcrResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { client_name: "Flow Test", redirect_uris: [REDIRECT_URI] },
  });
  expect(response.statusCode).toBe(201);
  return response.json<DcrResponse>();
}

type LoginArgs = {
  app: FastifyInstance;
  client: DcrResponse;
  challenge: string;
  state: string;
};

async function loginAndIssueCode(args: LoginArgs): Promise<string> {
  const { app, client, challenge, state } = args;
  const loginResponse = await app.inject({
    method: "POST",
    url: "/oauth/login",
    payload: {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      token: TEST_TOKEN_USER_A,
    },
  });
  expect(loginResponse.statusCode).toBe(302);
  const cookieHeader = loginResponse.cookies.find((c) => c.name === "stellara_session");
  expect(cookieHeader).toBeDefined();

  const authorizeResponse = await app.inject({
    method: "GET",
    url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI,
    )}&scope=${SCOPE}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    cookies: { stellara_session: cookieHeader?.value ?? "" },
  });
  expect(authorizeResponse.statusCode).toBe(302);
  const location = authorizeResponse.headers.location;
  expect(typeof location).toBe("string");
  const target = new URL(String(location));
  const code = target.searchParams.get("code");
  expect(code).not.toBeNull();
  expect(target.searchParams.get("state")).toBe(state);
  expect(target.searchParams.get("iss")).toBe("https://stellara.example.test");
  return String(code);
}

describe("OAuth flow — happy path", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(makeTestConfig());
  });

  afterEach(async () => {
    await app.close();
  });

  it("publishes RFC-8414 + RFC-9728 discovery metadata", async () => {
    const asMeta = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(asMeta.statusCode).toBe(200);
    const asBody = asMeta.json<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      jwks_uri: string;
      grant_types_supported: string[];
      code_challenge_methods_supported: string[];
      resource_indicators_supported: boolean;
      authorization_response_iss_parameter_supported: boolean;
      client_id_metadata_document_supported: boolean;
    }>();
    expect(asBody.issuer).toBe("https://stellara.example.test");
    expect(asBody.token_endpoint).toBe("https://stellara.example.test/oauth/token");
    expect(asBody.grant_types_supported).toContain("refresh_token");
    expect(asBody.code_challenge_methods_supported).toContain("S256");
    expect(asBody.resource_indicators_supported).toBe(true);
    expect(asBody.authorization_response_iss_parameter_supported).toBe(true);
    expect(asBody.client_id_metadata_document_supported).toBe(true);

    const prMeta = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(prMeta.statusCode).toBe(200);
    const prBody = prMeta.json<{ resource: string; authorization_servers: string[] }>();
    expect(prBody.resource).toBe("https://stellara.example.test/mcp");
    expect(prBody.authorization_servers).toContain("https://stellara.example.test");
    const pathMeta = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });
    expect(pathMeta.json()).toStrictEqual(prBody);
  });

  it("exposes the active signing key via JWKS", async () => {
    const response = await app.inject({ method: "GET", url: "/oauth/jwks" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ keys: Array<{ kid: string; alg: string; kty: string }> }>();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.alg).toBe("RS256");
    expect(body.keys[0]?.kty).toBe("RSA");
  });

  it("registers a client via DCR with an opaque client_id", async () => {
    const client = await registerClient(app);
    expect(client.client_id).toMatch(/^[0-9a-f]{32}$/);
    expect(client.redirect_uris).toContain(REDIRECT_URI);
  });

  it("renders a login form when no session cookie is present", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
        REDIRECT_URI,
      )}&scope=${SCOPE}&state=initial&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.body).toContain('action="/oauth/login"');
  });

  it("rejects revoked static tokens during OAuth login like unknown tokens", async () => {
    const revokedApp = await buildApp(
      makeTestConfig({ STELLARA_REVOKED_TOKENS: TEST_TOKEN_USER_A }),
    );
    try {
      const client = await registerClient(revokedApp);
      const { challenge } = generatePkcePair();
      const basePayload = {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "revoked",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      };
      const revoked = await revokedApp.inject({
        method: "POST",
        url: "/oauth/login",
        payload: { ...basePayload, token: TEST_TOKEN_USER_A },
      });
      const unknown = await revokedApp.inject({
        method: "POST",
        url: "/oauth/login",
        payload: { ...basePayload, token: "unknown-static-token" },
      });
      expect(revoked.statusCode).toBe(400);
      expect(revoked.body).toBe(unknown.body);
      expect(revoked.body).toContain("Invalid token. Please try again.");
      expect(revoked.body).not.toContain(TEST_TOKEN_USER_A);
      expect(revoked.cookies).toHaveLength(0);
    } finally {
      await revokedApp.close();
    }
  });

  it("requires resource for clients registered at or after the persistent cutover", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
        REDIRECT_URI,
      )}&scope=${SCOPE}&state=missing-resource&code_challenge=${challenge}&code_challenge_method=S256`,
    });
    expect(response.statusCode).toBe(302);
    const target = new URL(String(response.headers.location));
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("iss")).toBe("https://stellara.example.test");
  });

  it("grandfathers only DCR clients created before the persistent cutover", async () => {
    const clientId = "legacy-client";
    app.services.oauth.storage.insertClient({
      client_id: clientId,
      client_name: "Legacy Client",
      redirect_uris: JSON.stringify([REDIRECT_URI]),
      created_at: app.services.oauth.resourceRequiredSince - 1,
      last_used_at: app.services.oauth.resourceRequiredSince - 1,
    });
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(
        REDIRECT_URI,
      )}&scope=${SCOPE}&state=legacy&code_challenge=${challenge}&code_challenge_method=S256`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Legacy Client");
  });

  it("completes the full DCR → login → token → bearer round-trip", async () => {
    const client = await registerClient(app);
    const { verifier, challenge } = generatePkcePair();
    const code = await loginAndIssueCode({ app, client, challenge, state: "state-happy" });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    });
    expect(tokenResponse.statusCode).toBe(200);
    const tokens = tokenResponse.json<TokenResponse>();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token.split(".")).toHaveLength(3);
    expect(tokens.refresh_token).toMatch(/^[0-9a-f]{64}$/);

    // The JWT must authenticate calls against the protected `/tools/*` surface.
    const toolResponse = await app.inject({
      method: "POST",
      url: "/tools/search",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { query: "stellara" },
    });
    // The Exa client is not stubbed here; we only need to verify that auth
    // accepted the JWT (i.e. we did NOT get a 401). Any other status — even
    // a 500 from the unreachable upstream — proves the bearer was honored.
    expect(toolResponse.statusCode).not.toBe(401);
  });

  it("rotates the refresh token on every refresh-grant exchange", async () => {
    const client = await registerClient(app);
    const { verifier, challenge } = generatePkcePair();
    const code = await loginAndIssueCode({ app, client, challenge, state: "state-refresh" });
    const initialResponse = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    });
    const initial = initialResponse.json<TokenResponse>();

    const wrongResource = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
        resource: "https://other.example/mcp",
      },
    });
    expect(wrongResource.statusCode).toBe(400);
    expect(wrongResource.json<{ error: string }>().error).toBe("invalid_target");
    expect(
      app.services.oauth.storage.getRefreshToken(initial.refresh_token)?.rotated_to,
    ).toBeNull();

    const wrongScope = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
        resource: RESOURCE,
        scope: "mcp admin",
      },
    });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json<{ error: string }>().error).toBe("invalid_scope");
    expect(
      app.services.oauth.storage.getRefreshToken(initial.refresh_token)?.rotated_to,
    ).toBeNull();

    const refreshed = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
        resource: RESOURCE,
      },
    });
    expect(refreshed.statusCode).toBe(200);
    const tokens = refreshed.json<TokenResponse>();
    expect(tokens.refresh_token).not.toBe(initial.refresh_token);

    // Presenting the old (rotated) refresh token must now fail with invalid_grant.
    const replay = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: client.client_id,
        resource: RESOURCE,
      },
    });
    expect(replay.statusCode).toBe(400);
    const replayBody = replay.json<{ error: string }>();
    expect(replayBody.error).toBe("invalid_grant");
  });
});

describe("OAuth flow — error paths", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(makeTestConfig());
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects code exchange with a wrong code_verifier (PKCE mismatch)", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const code = await loginAndIssueCode({ app, client, challenge, state: "state-pkce" });
    const response = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: base64UrlEncode(randomBytes(32)),
        resource: RESOURCE,
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string; error_description: string }>();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/code_verifier/);
  });

  it("rejects a wrong resource before consuming an authorization code", async () => {
    const client = await registerClient(app);
    const { verifier, challenge } = generatePkcePair();
    const code = await loginAndIssueCode({ app, client, challenge, state: "state-resource" });
    const wrong = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: "https://other.example/mcp",
      },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>().error).toBe("invalid_target");
    expect(app.services.oauth.storage.getCode(code)).toBeDefined();

    const correct = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    });
    expect(correct.statusCode).toBe(200);
  });

  it("rejects authorize for an unknown client_id with 400", async () => {
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=does-not-exist&redirect_uri=${encodeURIComponent(
        REDIRECT_URI,
      )}&scope=${SCOPE}&state=x&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects oversized client IDs at authorize, login and token schema boundaries", async () => {
    const oversized = "a".repeat(MAX_OAUTH_CLIENT_ID_LENGTH + 1);
    const { verifier, challenge } = generatePkcePair();
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/oauth/authorize?response_type=code&client_id=${oversized}&redirect_uri=${encodeURIComponent(
          REDIRECT_URI,
        )}&scope=${SCOPE}&state=x&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
      }),
      app.inject({
        method: "POST",
        url: "/oauth/login",
        payload: {
          response_type: "code",
          client_id: oversized,
          redirect_uri: REDIRECT_URI,
          scope: SCOPE,
          state: "x",
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: RESOURCE,
          token: TEST_TOKEN_USER_A,
        },
      }),
      app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: {
          grant_type: "authorization_code",
          code: "unused",
          redirect_uri: REDIRECT_URI,
          client_id: oversized,
          code_verifier: verifier,
          resource: RESOURCE,
        },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toStrictEqual([422, 422, 422]);
  });

  it("rejects authorize with a redirect_uri not bound to the client", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(
        "https://attacker.example.test/cb",
      )}&scope=${SCOPE}&state=x&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("re-renders the login form with an inline error on bad token", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "POST",
      url: "/oauth/login",
      payload: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "x",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        token: "not-a-real-token-but-long-enough-to-pass-min-length-validator",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.body).toContain("Invalid token");
  });

  it("accepts an application/x-www-form-urlencoded body from the browser login form", async () => {
    // The HTML login form (`src/oauth/login-form.ts`) submits with the
    // default browser content type, not JSON. Without a form-body parser
    // registered on Fastify, the POST hits the global error handler and
    // returns INTERNAL_ERROR. This test pins the real browser pathway.
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      state: "form-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      token: TEST_TOKEN_USER_A,
    }).toString();
    const response = await app.inject({
      method: "POST",
      url: "/oauth/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: body,
    });
    expect(response.statusCode).toBe(302);
    expect(response.cookies.find((c) => c.name === "stellara_session")).toBeDefined();
  });

  it("rejects manipulated login hidden fields before creating a session", async () => {
    const client = await registerClient(app);
    const { challenge } = generatePkcePair();
    const response = await app.inject({
      method: "POST",
      url: "/oauth/login",
      payload: {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://attacker.example/callback",
        scope: SCOPE,
        state: "tampered",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        token: TEST_TOKEN_USER_A,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).not.toContain("attacker.example");
    expect(
      app.services.oauth.storage.db.prepare("SELECT COUNT(*) AS count FROM oauth_sessions").get(),
    ).toMatchObject({ count: 0 });
  });

  it("uses CIMD for authorization but never re-fetches it during code or refresh exchange", async () => {
    await app.close();
    const clientId = "https://client.example/metadata.json";
    const transport = vi.fn(async () =>
      resolved({
        body: Buffer.from(
          JSON.stringify({
            client_id: clientId,
            client_name: "CIMD Flow Client",
            redirect_uris: [REDIRECT_URI],
          }),
        ),
        headers: { "content-type": "application/json", "cache-control": "max-age=60" },
        statusCode: 200,
      }),
    );
    const testApp = await buildApp(makeTestConfig(), { clientMetadataTransport: transport });
    const { verifier, challenge } = generatePkcePair();

    const form = await testApp.inject({
      method: "GET",
      url: `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(
        REDIRECT_URI,
      )}&scope=${SCOPE}&state=cimd-form&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
    });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain("CIMD Flow Client");
    expect(form.body).toContain("localhost:6274");
    expect(form.body).toContain("Warning");

    const code = await loginAndIssueCode({
      app: testApp,
      client: { client_id: clientId, redirect_uris: [REDIRECT_URI] },
      challenge,
      state: "cimd",
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const token = await testApp.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      },
    });
    expect(token.statusCode).toBe(200);
    const initial = token.json<TokenResponse>();
    expect(transport).toHaveBeenCalledTimes(1);
    const refreshed = await testApp.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: clientId,
        resource: RESOURCE,
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
    await testApp.close();
  });

  it("returns local 429 for CIMD cache-miss budget exhaustion", async () => {
    await app.close();
    const transport = vi.fn(async (url: URL) =>
      resolved({
        body: Buffer.from(
          JSON.stringify({
            client_id: url.href,
            client_name: "Rate Test",
            redirect_uris: [REDIRECT_URI],
          }),
        ),
        headers: { "content-type": "application/json", "cache-control": "max-age=60" },
        statusCode: 200,
      }),
    );
    const testApp = await buildApp(
      makeTestConfig({ STELLARA_OAUTH_CIMD_RATE_LIMIT_PER_MINUTE: "1" }),
      { clientMetadataTransport: transport },
    );
    const { challenge } = generatePkcePair();
    const firstAllowed = await testApp.inject({
      method: "GET",
      url: buildCimdAuthorizeUrl("https://client.example/one", challenge),
    });
    expect(firstAllowed.statusCode).toBe(200);
    const blocked = await testApp.inject({
      method: "GET",
      url: buildCimdAuthorizeUrl("https://client.example/two", challenge),
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.headers.location).toBeUndefined();
    expect(blocked.json<{ error: string }>().error).toBe("temporarily_unavailable");
    const blockedLogin = await testApp.inject({
      method: "POST",
      url: "/oauth/login",
      payload: {
        response_type: "code",
        client_id: "https://client.example/login-two",
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "limits",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        token: TEST_TOKEN_USER_A,
      },
    });
    expect(blockedLogin.statusCode).toBe(429);
    expect(blockedLogin.headers["retry-after"]).toBe("60");
    expect(blockedLogin.headers.location).toBeUndefined();
    await testApp.close();
  });

  it("returns local 503 without queueing when the CIMD process cap is exhausted", async () => {
    await app.close();
    let release:
      | ((value: { body: Buffer; headers: Record<string, string>; statusCode: number }) => void)
      | undefined;
    const transport = vi.fn(
      async () =>
        new Promise<{ body: Buffer; headers: Record<string, string>; statusCode: number }>(
          (resolve) => {
            release = resolve;
          },
        ),
    );
    const testApp = await buildApp(makeTestConfig({ STELLARA_OAUTH_CIMD_MAX_IN_FLIGHT: "1" }), {
      clientMetadataTransport: transport,
    });
    const { challenge } = generatePkcePair();
    const firstId = "https://client.example/first";
    const first = testApp.inject({ method: "GET", url: buildCimdAuthorizeUrl(firstId, challenge) });
    await vi.waitFor(() => {
      expect(transport).toHaveBeenCalledTimes(1);
    });
    const blocked = await testApp.inject({
      method: "GET",
      url: buildCimdAuthorizeUrl("https://client.example/second", challenge),
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.headers.location).toBeUndefined();
    expect(blocked.json<{ error: string }>().error).toBe("temporarily_unavailable");
    const blockedLogin = await testApp.inject({
      method: "POST",
      url: "/oauth/login",
      payload: {
        response_type: "code",
        client_id: "https://client.example/login-second",
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: "limits",
        code_challenge: challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
        token: TEST_TOKEN_USER_A,
      },
    });
    expect(blockedLogin.statusCode).toBe(503);
    expect(blockedLogin.headers.location).toBeUndefined();
    release?.({
      body: Buffer.from(
        JSON.stringify({
          client_id: firstId,
          client_name: "First Client",
          redirect_uris: [REDIRECT_URI],
        }),
      ),
      headers: { "content-type": "application/json", "cache-control": "max-age=60" },
      statusCode: 200,
    });
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    await testApp.close();
  });

  it("rejects DCR with a non-loopback HTTP redirect URI", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: ["http://example.test/cb"] },
    });
    expect(response.statusCode).toBe(400);
  });
});
