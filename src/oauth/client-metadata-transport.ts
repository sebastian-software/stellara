/** Connect-pinned HTTPS transport for OAuth client metadata documents. */
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export const CIMD_TIMEOUT_MS = 5 * 1000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const NOOP = (): void => {
  // Replaced with the operation-specific listener cleanup before I/O starts.
};

/** One absolute operation deadline shared across DNS and every redirect hop. */
export type CimdOperationContext = {
  deadlineAt: number;
  signal: AbortSignal;
};

/** A single already-address-validated HTTP response used by the resolver. */
export type CimdTransportResponse = {
  body: Uint8Array;
  headers: IncomingHttpHeaders;
  statusCode: number;
};

/** Injectable one-hop transport; redirects remain policy-owned by the resolver. */
export type CimdTransport = (
  url: URL,
  operation?: CimdOperationContext,
) => Promise<CimdTransportResponse>;

/** Default transport with DNS pinning plus post-connect remote-address checks. */
export function createPinnedHttpsTransport(): CimdTransport {
  return async (url, suppliedOperation) => {
    if (suppliedOperation !== undefined) return fetchPinned(url, suppliedOperation);
    const controller = new AbortController();
    const operation = { deadlineAt: Date.now() + CIMD_TIMEOUT_MS, signal: controller.signal };
    const timer = setTimeout(() => {
      controller.abort(new Error("CIMD request timed out"));
    }, CIMD_TIMEOUT_MS);
    timer.unref();
    try {
      return await fetchPinned(url, operation);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function fetchPinned(
  url: URL,
  operation: CimdOperationContext,
): Promise<CimdTransportResponse> {
  assertOperationActive(operation);
  const addresses = await waitForCimdOperation(
    lookup(url.hostname, { all: true, verbatim: true }),
    operation,
  );
  assertOperationActive(operation);
  const selected = addresses[0];
  if (selected === undefined || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("CIMD hostname resolves to a non-public address");
  }
  return waitForCimdOperation(
    requestPinned({
      url,
      address: selected.address,
      family: selected.family,
      operation,
    }),
    operation,
  );
}

async function requestPinned(args: {
  url: URL;
  address: string;
  family: number;
  operation: CimdOperationContext;
}): Promise<CimdTransportResponse> {
  return new Promise((resolve, reject) => {
    const request = createRequest(args);
    let detachAbort = NOOP;
    const guard = createSettlementGuard(request, reject, () => {
      detachAbort();
    });
    const onAbort = (): void => {
      guard.fail(operationAbortError(args.operation));
    };
    args.operation.signal.addEventListener("abort", onAbort, { once: true });
    detachAbort = () => {
      args.operation.signal.removeEventListener("abort", onAbort);
    };
    attachSocketGuard(request, args.address, guard.fail);
    request.once("error", () => {
      guard.fail(new Error("Unable to fetch client metadata"));
    });
    request.once("response", (response) => {
      collectResponse(response, guard, resolve);
    });
    request.end();
  });
}

function createRequest(args: {
  url: URL;
  address: string;
  family: number;
  operation: CimdOperationContext;
}): ClientRequest {
  return httpsRequest(args.url, {
    agent: false,
    headers: { accept: "application/json" },
    signal: args.operation.signal,
    lookup(_hostname, _options, callback) {
      callback(null, args.address, args.family === 6 ? 6 : 4);
    },
  });
}

function createSettlementGuard(
  request: ClientRequest,
  reject: (reason: Error) => void,
  cleanup: () => void,
): {
  fail: (error: Error) => void;
  isSettled: () => boolean;
  settle: () => void;
} {
  let settled = false;
  return {
    fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      request.destroy();
      reject(error);
    },
    isSettled() {
      return settled;
    },
    settle() {
      settled = true;
      cleanup();
    },
  };
}

function attachSocketGuard(
  request: ClientRequest,
  pinnedAddress: string,
  fail: (error: Error) => void,
): void {
  request.once("socket", (socket: Socket) => {
    socket.once("secureConnect", () => {
      try {
        assertConnectedAddress(pinnedAddress, socket.remoteAddress);
      } catch (error) {
        fail(error instanceof Error ? error : new Error("CIMD socket validation failed"));
      }
    });
  });
}

function collectResponse(
  response: IncomingMessage,
  guard: ReturnType<typeof createSettlementGuard>,
  resolve: (value: CimdTransportResponse) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  response.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      response.destroy();
      guard.fail(new Error("CIMD document is too large"));
      return;
    }
    chunks.push(chunk);
  });
  response.once("error", () => {
    guard.fail(new Error("Unable to read client metadata"));
  });
  response.once("end", () => {
    if (guard.isSettled()) return;
    guard.settle();
    resolve({
      body: Buffer.concat(chunks),
      headers: response.headers,
      statusCode: response.statusCode ?? 0,
    });
  });
}

/** Rejects a late asynchronous result after timeout or resolver shutdown. */
export async function waitForCimdOperation<T>(
  work: Promise<T>,
  operation: CimdOperationContext,
): Promise<T> {
  assertOperationActive(operation);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(operationAbortError(operation));
    };
    operation.signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        operation.signal.removeEventListener("abort", onAbort);
        if (operation.signal.aborted || Date.now() >= operation.deadlineAt) {
          reject(operationAbortError(operation));
          return;
        }
        resolve(value);
      },
      (error: unknown) => {
        operation.signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("CIMD operation failed"));
      },
    );
  });
}

function assertOperationActive(operation: CimdOperationContext): void {
  if (operation.signal.aborted || Date.now() >= operation.deadlineAt) {
    throw operationAbortError(operation);
  }
}

function operationAbortError(operation: CimdOperationContext): Error {
  return operation.signal.reason instanceof Error
    ? operation.signal.reason
    : new Error("CIMD request timed out");
}

const BLOCKED_IPV4 = buildBlockedIpv4List();
const GLOBAL_UNICAST_IPV6 = buildGlobalUnicastIpv6List();
const BLOCKED_GLOBAL_IPV6 = buildBlockedGlobalIpv6List();

/**
 * Returns whether an address is globally routable under the CIMD egress
 * policy. IPv4 follows the IANA special-purpose exclusions. IPv6 fails closed
 * to 2000::/3 and then removes special sub-ranges, which also excludes mapped,
 * compatible, NAT64, site-local, unique-local and link-local forms.
 */
export function isPublicAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const family = isIP(address);
  if (family === 4) return !BLOCKED_IPV4.check(address, "ipv4");
  if (family !== 6 || !GLOBAL_UNICAST_IPV6.check(address, "ipv6")) return false;
  return !BLOCKED_GLOBAL_IPV6.check(address, "ipv6");
}

/** Verifies that the connected peer is exactly the public address pinned before connect. */
export function assertConnectedAddress(pinned: string, connected: string | undefined): void {
  if (connected !== pinned || !isPublicAddress(connected)) {
    throw new Error("CIMD socket address failed validation");
  }
}

function buildBlockedIpv4List(): BlockList {
  const list = new BlockList();
  const ranges: ReadonlyArray<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, "ipv4");
  return list;
}

function buildGlobalUnicastIpv6List(): BlockList {
  const list = new BlockList();
  list.addSubnet("2000::", 3, "ipv6");
  return list;
}

function buildBlockedGlobalIpv6List(): BlockList {
  const list = new BlockList();
  const ranges: ReadonlyArray<[string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3ffe::", 16],
    ["3fff::", 20],
  ];
  for (const [network, prefix] of ranges) list.addSubnet(network, prefix, "ipv6");
  return list;
}
