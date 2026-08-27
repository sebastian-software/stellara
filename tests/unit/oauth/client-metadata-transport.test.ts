import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPinnedHttpsTransport } from "../../../src/oauth/client-metadata-transport.js";

const moduleMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: moduleMocks.lookup }));
vi.mock("node:https", () => ({ request: moduleMocks.request }));

function fakeRequest(onEnd?: () => void) {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    end() {
      onEnd?.();
    },
  });
}

function fakeResponse() {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    headers: { "content-type": "application/json" },
    statusCode: 200,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("pinned CIMD HTTPS transport", () => {
  it("rejects mixed public/private DNS answers before opening a socket", async () => {
    moduleMocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const transport = createPinnedHttpsTransport();

    await expect(transport(new URL("https://client.example/metadata"))).rejects.toThrow(
      /non-public/u,
    );
    expect(moduleMocks.request).not.toHaveBeenCalled();
  });

  it("destroys a stalled request at the five-second deadline", async () => {
    vi.useFakeTimers();
    moduleMocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const request = fakeRequest();
    moduleMocks.request.mockReturnValue(request);
    const transport = createPinnedHttpsTransport();
    const pending = transport(new URL("https://client.example/metadata"));
    const settled = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(5 * 1000);

    await expect(settled).resolves.toMatchObject({ message: expect.stringMatching(/timed out/u) });
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it("starts the absolute deadline before DNS and ignores a late lookup result", async () => {
    vi.useFakeTimers();
    let resolveLookup: ((value: Array<{ address: string; family: number }>) => void) | undefined;
    moduleMocks.lookup.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const transport = createPinnedHttpsTransport();
    const settled = transport(new URL("https://client.example/metadata")).catch(
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(5 * 1000);
    await expect(settled).resolves.toMatchObject({ message: expect.stringMatching(/timed out/u) });
    resolveLookup?.([{ address: "8.8.8.8", family: 4 }]);
    await vi.runAllTimersAsync();
    expect(moduleMocks.request).not.toHaveBeenCalled();
  });

  it("accepts a response exactly at the 64 KiB body limit", async () => {
    moduleMocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const response = fakeResponse();
    const request = fakeRequest(() => {
      request.emit("response", response);
      response.emit("data", Buffer.alloc(64 * 1024));
      response.emit("end");
    });
    moduleMocks.request.mockReturnValue(request);
    const transport = createPinnedHttpsTransport();

    await expect(transport(new URL("https://client.example/metadata"))).resolves.toMatchObject({
      body: expect.objectContaining({ byteLength: 64 * 1024 }),
      statusCode: 200,
    });
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it("aborts a streamed response as soon as it exceeds 64 KiB", async () => {
    moduleMocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const response = fakeResponse();
    const request = fakeRequest(() => {
      request.emit("response", response);
      response.emit("data", Buffer.alloc(64 * 1024));
      response.emit("data", Buffer.alloc(1));
    });
    moduleMocks.request.mockReturnValue(request);
    const transport = createPinnedHttpsTransport();

    await expect(transport(new URL("https://client.example/metadata"))).rejects.toThrow(
      /too large/u,
    );
    expect(response.destroy).toHaveBeenCalledTimes(1);
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });
});
