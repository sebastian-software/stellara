import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_OAUTH_CLIENT_ID_LENGTH } from "../../../src/oauth/client-id.js";
import {
  assertConnectedAddress,
  type CimdTransport,
  ClientMetadataError,
  createClientResolver,
  createPinnedHttpsTransport,
  isPublicAddress,
} from "../../../src/oauth/client-metadata.js";
import { createClientRegistrar } from "../../../src/oauth/clients.js";
import { OAuthStorage } from "../../../src/oauth/storage.js";
import { assertKind } from "./helpers.js";

const SOURCE_IP = "203.0.114.10";

function response(
  body: unknown,
  options: { statusCode?: number; headers?: Record<string, string> } = {},
) {
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: {
      "content-type": "application/json",
      "cache-control": "max-age=60",
      ...options.headers,
    },
    statusCode: options.statusCode ?? 200,
  };
}

function documentFor(clientId: string, redirectUri = "https://client.example/callback") {
  return {
    client_id: clientId,
    client_name: "Verified Client",
    redirect_uris: [redirectUri],
  };
}

async function resolved<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    queueMicrotask(() => {
      resolve(value);
    });
  });
}

function createRedirectTransport(clientId: string): CimdTransport {
  const responses = new Map<string, ReturnType<typeof response>>([
    ["/a", response({}, { statusCode: 302, headers: { location: "/b" } })],
    ["/b", response({}, { statusCode: 302, headers: { location: "/c" } })],
    ["/c", response({}, { statusCode: 302, headers: { location: "/d" } })],
    ["/d", response(documentFor(clientId))],
  ]);
  return async (url) => resolved(responses.get(url.pathname) ?? response(documentFor(clientId)));
}

function setupResolver(options: {
  transport: CimdTransport;
  rateLimitPerMinute?: number;
  maxInFlight?: number;
  cacheMaxEntries?: number;
  rateBucketMaxEntries?: number;
  now?: () => number;
}) {
  const storage = new OAuthStorage({ path: ":memory:", ttlSweepIntervalMs: 0 });
  const registrar = createClientRegistrar({ now: options.now });
  const resolver = createClientResolver({
    storage,
    registrar,
    transport: options.transport,
    rateLimitPerMinute: options.rateLimitPerMinute ?? 10,
    maxInFlight: options.maxInFlight ?? 16,
    cacheMaxEntries: options.cacheMaxEntries ?? 512,
    rateBucketMaxEntries: options.rateBucketMaxEntries,
    now: options.now,
  });
  return { storage, registrar, resolver };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("OAuth client metadata resolver", () => {
  it("resolves opaque ids locally without consuming CIMD transport", async () => {
    const transport = vi.fn<CimdTransport>();
    const setup = setupResolver({ transport });
    cleanups.push(() => {
      setup.storage.close();
    });
    const registration = setup.registrar.registerClient(
      setup.storage,
      { client_name: "Local Client", redirect_uris: ["https://client.example/callback"] },
      SOURCE_IP,
    );
    assertKind(registration, "ok");

    const client = await setup.resolver.resolveClient(registration.response.client_id, SOURCE_IP);

    expect(client).toMatchObject({ registration: "dcr", clientName: "Local Client" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("fetches, validates and positively caches an exact self-bound CIMD", async () => {
    const clientId = "https://client.example/metadata.json";
    const transport = vi.fn<CimdTransport>(async () =>
      resolved(response(documentFor(clientId), { headers: { "cache-control": "max-age=60" } })),
    );
    const setup = setupResolver({ transport });
    cleanups.push(() => {
      setup.storage.close();
    });

    const first = await setup.resolver.resolveClient(clientId, SOURCE_IP);
    const second = await setup.resolver.resolveClient(clientId, SOURCE_IP);

    expect(first).toStrictEqual(second);
    expect(first.registration).toBe("cimd");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("negative-caches invalid self-binding for 30 seconds", async () => {
    let now = 10_000;
    const clientId = "https://client.example/metadata.json";
    const transport = vi.fn<CimdTransport>(async () =>
      resolved(response(documentFor("https://client.example/other.json"))),
    );
    const setup = setupResolver({ transport, now: () => now });
    cleanups.push(() => {
      setup.storage.close();
    });

    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toMatchObject({
      kind: "invalid_client",
    });
    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toBeInstanceOf(
      ClientMetadataError,
    );
    expect(transport).toHaveBeenCalledTimes(1);

    now += 30_001;
    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toBeInstanceOf(
      ClientMetadataError,
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("requires a non-root document path and never calls the transport for a root URL", async () => {
    const transport = vi.fn<CimdTransport>();
    const setup = setupResolver({ transport });
    cleanups.push(() => {
      setup.storage.close();
    });

    await expect(
      setup.resolver.resolveClient("https://client.example/", SOURCE_IP),
    ).rejects.toThrow(/document path/u);
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects oversized client IDs before URL parsing, cache lookup or transport", async () => {
    const transport = vi.fn<CimdTransport>(async (url) =>
      resolved(response(documentFor(url.href))),
    );
    const setup = setupResolver({ transport, rateLimitPerMinute: 1 });
    cleanups.push(() => {
      setup.storage.close();
    });
    const oversized = `https://client.example/${"a".repeat(MAX_OAUTH_CLIENT_ID_LENGTH)}`;

    await expect(setup.resolver.resolveClient(oversized, SOURCE_IP)).rejects.toMatchObject({
      kind: "invalid_client",
    });
    await expect(
      setup.resolver.resolveClient("https://client.example/valid", SOURCE_IP),
    ).resolves.toMatchObject({ registration: "cimd" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("allows exactly three same-origin redirects with every hop revalidated", async () => {
    const clientId = "https://client.example/a";
    const transport = vi.fn<CimdTransport>(createRedirectTransport(clientId));
    const setup = setupResolver({ transport });
    cleanups.push(() => {
      setup.storage.close();
    });

    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).resolves.toMatchObject({
      clientId,
    });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("rejects cross-origin and fourth redirects before following them", async () => {
    const crossOrigin = vi.fn<CimdTransport>(async () =>
      resolved(
        response({}, { statusCode: 302, headers: { location: "https://attacker.example/doc" } }),
      ),
    );
    const crossSetup = setupResolver({ transport: crossOrigin });
    cleanups.push(() => {
      crossSetup.storage.close();
    });
    await expect(
      crossSetup.resolver.resolveClient("https://client.example/a", SOURCE_IP),
    ).rejects.toThrow(/changed origin/u);
    expect(crossOrigin).toHaveBeenCalledTimes(1);

    const overLimit = vi.fn<CimdTransport>(async (url) =>
      resolved(response({}, { statusCode: 302, headers: { location: `${url.pathname}x` } })),
    );
    const overSetup = setupResolver({ transport: overLimit });
    cleanups.push(() => {
      overSetup.storage.close();
    });
    await expect(
      overSetup.resolver.resolveClient("https://client.example/a", SOURCE_IP),
    ).rejects.toThrow(/Too many/u);
    expect(overLimit).toHaveBeenCalledTimes(4);
  });

  it("rejects wrong content types, oversized documents and unsafe redirect URIs", async () => {
    const clientId = "https://client.example/metadata.json";
    const wrongType = setupResolver({
      transport: async () =>
        resolved(response(documentFor(clientId), { headers: { "content-type": "text/html" } })),
    });
    cleanups.push(() => {
      wrongType.storage.close();
    });
    await expect(wrongType.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toThrow(
      /non-JSON/u,
    );

    const tooLarge = setupResolver({
      transport: async () =>
        resolved({
          body: Buffer.alloc(65 * 1024),
          headers: { "content-type": "application/json" },
          statusCode: 200,
        }),
    });
    cleanups.push(() => {
      tooLarge.storage.close();
    });
    await expect(tooLarge.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toThrow(
      /too large/u,
    );

    const unsafeRedirect = setupResolver({
      transport: async () =>
        resolved(response(documentFor(clientId, "http://attacker.example/callback"))),
    });
    cleanups.push(() => {
      unsafeRedirect.storage.close();
    });
    await expect(unsafeRedirect.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toThrow(
      /invalid redirect_uri/u,
    );
  });

  it("counts only real cache misses against the source-IP bucket", async () => {
    const transport = vi.fn<CimdTransport>(async (url) =>
      resolved(response(documentFor(url.href))),
    );
    const setup = setupResolver({ transport, rateLimitPerMinute: 2 });
    cleanups.push(() => {
      setup.storage.close();
    });
    const one = "https://client.example/one";
    const two = "https://client.example/two";
    await setup.resolver.resolveClient(one, SOURCE_IP);
    await setup.resolver.resolveClient(one, SOURCE_IP);
    await setup.resolver.resolveClient(two, SOURCE_IP);

    await expect(
      setup.resolver.resolveClient("https://client.example/three", SOURCE_IP),
    ).rejects.toMatchObject({ kind: "rate_limited", retryAfterSeconds: 60 });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not charge locally invalid client IDs against the source-IP bucket", async () => {
    const transport = vi.fn<CimdTransport>(async (url) =>
      resolved(response(documentFor(url.href))),
    );
    const setup = setupResolver({ transport, rateLimitPerMinute: 1 });
    cleanups.push(() => {
      setup.storage.close();
    });
    for (const invalidId of [
      "https://client.example/",
      "https://user@client.example/metadata",
      "https://client.example/metadata#fragment",
    ]) {
      await expect(setup.resolver.resolveClient(invalidId, SOURCE_IP)).rejects.toMatchObject({
        kind: "invalid_client",
      });
    }

    await expect(
      setup.resolver.resolveClient("https://client.example/valid", SOURCE_IP),
    ).resolves.toMatchObject({ registration: "cimd" });
    await expect(
      setup.resolver.resolveClient("https://client.example/limited", SOURCE_IP),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("single-flights identical misses and rejects distinct work when in-flight is saturated", async () => {
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    const firstId = "https://client.example/first";
    const transport = vi.fn<CimdTransport>(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const setup = setupResolver({ transport, maxInFlight: 1 });
    cleanups.push(() => {
      setup.storage.close();
    });
    const first = setup.resolver.resolveClient(firstId, SOURCE_IP);
    const duplicate = setup.resolver.resolveClient(firstId, "203.0.114.11");
    await vi.waitFor(() => {
      expect(transport).toHaveBeenCalledTimes(1);
    });

    await expect(
      setup.resolver.resolveClient("https://client.example/second", SOURCE_IP),
    ).rejects.toMatchObject({ kind: "temporarily_unavailable" });
    release?.(response(documentFor(firstId)));
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not charge a source IP when the global in-flight slot is unavailable", async () => {
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    const firstId = "https://client.example/first";
    const transport = vi
      .fn<CimdTransport>()
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockImplementation(async (url) => resolved(response(documentFor(url.href))));
    const setup = setupResolver({ transport, maxInFlight: 1, rateLimitPerMinute: 1 });
    cleanups.push(() => {
      setup.storage.close();
    });
    const first = setup.resolver.resolveClient(firstId, SOURCE_IP);
    await vi.waitFor(() => {
      expect(transport).toHaveBeenCalledTimes(1);
    });

    const secondIp = "203.0.114.11";
    await expect(
      setup.resolver.resolveClient("https://client.example/blocked", secondIp),
    ).rejects.toMatchObject({ kind: "temporarily_unavailable" });
    release?.(response(documentFor(firstId)));
    await first;
    await expect(
      setup.resolver.resolveClient("https://client.example/after-capacity", secondIp),
    ).resolves.toMatchObject({ registration: "cimd" });
  });

  it("bounds rotating source-IP buckets with least-recently-used eviction", async () => {
    const transport = vi.fn<CimdTransport>(async (url) =>
      resolved(response(documentFor(url.href))),
    );
    const setup = setupResolver({
      transport,
      rateLimitPerMinute: 1,
      rateBucketMaxEntries: 2,
    });
    cleanups.push(() => {
      setup.storage.close();
    });
    await setup.resolver.resolveClient("https://client.example/a", "2001:4860::1");
    await setup.resolver.resolveClient("https://client.example/b", "2001:4860::2");
    await setup.resolver.resolveClient("https://client.example/c", "2001:4860::3");

    await expect(
      setup.resolver.resolveClient("https://client.example/d", "2001:4860::1"),
    ).resolves.toMatchObject({ registration: "cimd" });
  });

  it("aborts active work on close, waits for settlement and rejects late cache writes", async () => {
    let release: ((value: ReturnType<typeof response>) => void) | undefined;
    const clientId = "https://client.example/shutdown";
    const transport = vi.fn<CimdTransport>(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const setup = setupResolver({ transport });
    cleanups.push(() => {
      setup.storage.close();
    });
    const pending = setup.resolver.resolveClient(clientId, SOURCE_IP);
    await vi.waitFor(() => {
      expect(transport).toHaveBeenCalledTimes(1);
    });

    const closed = setup.resolver.close();
    await expect(pending).rejects.toMatchObject({ kind: "temporarily_unavailable" });
    await closed;
    release?.(response(documentFor(clientId)));
    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toMatchObject({
      kind: "temporarily_unavailable",
    });
  });

  it.each([
    ["no-store", { "cache-control": "no-store, max-age=60" }],
    ["no-cache field list", { "cache-control": 'no-cache="set-cookie"' }],
    ["zero freshness", { "cache-control": "max-age=0" }],
    ["missing freshness", {}],
  ])("rejects CIMD responses with %s", async (_label, cacheHeaders) => {
    const clientId = "https://client.example/cache-policy";
    const headers = { "content-type": "application/json", ...cacheHeaders };
    const transport = vi.fn<CimdTransport>().mockResolvedValue({
      body: Buffer.from(JSON.stringify(documentFor(clientId))),
      headers,
      statusCode: 200,
    });
    const setup = setupResolver({
      transport,
    });
    cleanups.push(() => {
      setup.storage.close();
    });

    await expect(setup.resolver.resolveClient(clientId, SOURCE_IP)).rejects.toThrow(/cach/u);
  });

  it.each([
    [
      "host case and default port",
      "https://client.example/metadata",
      "https://CLIENT.example:443/metadata",
    ],
    ["percent-escape case", "https://client.example/a%2Fb", "https://client.example/a%2fb"],
    ["trailing slash", "https://client.example/metadata", "https://client.example/metadata/"],
  ])(
    "uses exact lexical client-id strings as separate cache keys for %s",
    async (_label, first, second) => {
      const transport = vi
        .fn<CimdTransport>()
        .mockResolvedValueOnce(response(documentFor(first)))
        .mockResolvedValueOnce(response(documentFor(second)));
      const setup = setupResolver({ transport });
      cleanups.push(() => {
        setup.storage.close();
      });

      await expect(setup.resolver.resolveClient(first, SOURCE_IP)).resolves.toMatchObject({
        clientId: first,
      });
      await expect(setup.resolver.resolveClient(second, SOURCE_IP)).resolves.toMatchObject({
        clientId: second,
      });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it("evicts the least-recently-used entry when the cache reaches its cap", async () => {
    const transport = vi.fn<CimdTransport>(async (url) =>
      resolved(response(documentFor(url.href))),
    );
    const setup = setupResolver({ transport, cacheMaxEntries: 2 });
    cleanups.push(() => {
      setup.storage.close();
    });
    const one = "https://client.example/one";
    const two = "https://client.example/two";
    const three = "https://client.example/three";

    await setup.resolver.resolveClient(one, SOURCE_IP);
    await setup.resolver.resolveClient(two, SOURCE_IP);
    await setup.resolver.resolveClient(one, SOURCE_IP);
    await setup.resolver.resolveClient(three, SOURCE_IP);
    await setup.resolver.resolveClient(two, SOURCE_IP);

    expect(transport).toHaveBeenCalledTimes(4);
  });
});

describe("CIMD connected-address policy", () => {
  it("accepts public addresses and rejects private, loopback, link-local and documentation ranges", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.1.1",
      "192.0.2.1",
      "192.88.99.1",
      "::1",
      "::ffff:127.0.0.1",
      "64:ff9b:1::1",
      "64:ff9b::7f00:1",
      "::192.168.1.1",
      "2001::1",
      "2002:7f00:1::",
      "3ffe::1",
      "3fff::1",
      "fc00::1",
      "fec0::1",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
  });

  it("rejects a socket address that differs from the pinned DNS result", () => {
    expect(() => {
      assertConnectedAddress("8.8.8.8", "1.1.1.1");
    }).toThrow(/socket address/u);
    expect(() => {
      assertConnectedAddress("127.0.0.1", "127.0.0.1");
    }).toThrow(/socket address/u);
    expect(() => {
      assertConnectedAddress("8.8.8.8", "8.8.8.8");
    }).not.toThrow();
  });

  it("fails closed before connecting to localhost", async () => {
    const transport = createPinnedHttpsTransport();
    await expect(transport(new URL("https://localhost/client-metadata.json"))).rejects.toThrow(
      /non-public/u,
    );
  });
});
