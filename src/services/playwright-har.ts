/**
 * Custom HAR recorder used by `browser_har` (plan 0010 §8.29).
 *
 * Playwright exposes `recordHar` only as a `BrowserContext` constructor
 * option, which is incompatible with the "turn recording on mid-session"
 * semantics the MCP tool needs. We therefore build a thin recorder on top
 * of `page.on("request" | "response" | "requestfinished")` events and
 * serialise the result into a HAR 1.2 envelope on stop.
 *
 * The recorder keeps every captured entry in memory — there is no on-disk
 * spill, so the session-level output cap (10 MB) also caps HAR size on
 * `browser_har stop`. Per-entry data is intentionally limited to the
 * fields LLM clients typically reason about (status, headers, mime, body
 * preview); fields like cookies and timings are emitted with the
 * conservative zero/empty defaults rather than fabricated values.
 *
 * **Privacy:** captured request headers are passed through verbatim, so
 * `Authorization` and `Cookie` values **do** end up in the HAR. The
 * concept (§8.29) makes this explicit; callers control whether a HAR is
 * ever started.
 */
import type { Page, Request, Response } from "playwright";

/** Single HAR 1.2 `log.entries[*]` row. */
type HarEntry = {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
};

type HarHeader = { name: string; value: string };

type HarRequest = {
  method: string;
  url: string;
  httpVersion: string;
  cookies: never[];
  headers: HarHeader[];
  queryString: never[];
  headersSize: number;
  bodySize: number;
  postData?: { mimeType: string; text: string };
};

type HarResponse = {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: never[];
  headers: HarHeader[];
  content: { size: number; mimeType: string; text?: string };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
};

/** Tag attached to the recorder's listeners so they can be detached cleanly. */
type AttachedListener = {
  request: (request: Request) => void;
  requestfinished: (request: Request) => void;
};

/**
 * In-memory HAR 1.2 recorder bound to one or more `Page` instances inside
 * a single `BrowserContext`. New tabs opened via `browser_tabs new` after
 * the recorder is started are **not** retrofitted — the recorder snapshots
 * the live tab list at `start` time so the lifetime stays predictable.
 */
export class HarBuffer {
  /** Wall-clock when recording started — populates the HAR `pages[0]` row. */
  public readonly startedAt: number = Date.now();

  private readonly entries: HarEntry[] = [];
  private readonly listeners = new Map<Page, AttachedListener>();
  private stopped = false;

  /**
   * Attaches request/response listeners to every page in `pages`.
   *
   * Subsequent navigations on the same tab continue to be captured
   * because the listeners ride with the `Page` object, not the
   * navigated URL.
   */
  public start(pages: readonly Page[]): void {
    for (const page of pages) {
      const finishedHandler = (request: Request): void => {
        void this.captureFinished(request);
      };
      page.on("request", noopRequestHandler);
      page.on("requestfinished", finishedHandler);
      this.listeners.set(page, {
        request: noopRequestHandler,
        requestfinished: finishedHandler,
      });
    }
  }

  /**
   * Detaches every listener attached by {@link HarBuffer.start} and
   * returns the accumulated HAR 1.2 envelope. Idempotent — calling
   * `serialize` a second time returns the same envelope and is a no-op
   * on the underlying listeners.
   */
  public serialize(): HarEnvelope {
    if (!this.stopped) {
      this.stopped = true;
      for (const [page, attached] of this.listeners) {
        page.off("request", attached.request);
        page.off("requestfinished", attached.requestfinished);
      }
    }
    return {
      log: {
        version: "1.2",
        creator: { name: "stellara", version: "0.1" },
        pages: [
          {
            startedDateTime: new Date(this.startedAt).toISOString(),
            id: "page_1",
            title: "Stellara HAR",
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          },
        ],
        entries: this.entries,
      },
    };
  }

  /** Total accumulated entry count — exposed for the output-size check. */
  public size(): number {
    return this.entries.length;
  }

  private async captureFinished(request: Request): Promise<void> {
    if (this.stopped) return;
    let response: null | Response;
    try {
      response = await request.response();
    } catch {
      response = null;
    }
    this.entries.push({
      startedDateTime: new Date(Date.now()).toISOString(),
      time: 0,
      request: toHarRequest(request),
      response: response === null ? emptyResponse() : await toHarResponse(response),
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    });
  }
}

/** Caller-visible HAR 1.2 envelope returned by `browser_har stop`. */
export type HarEnvelope = {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: { onContentLoad: number; onLoad: number };
    }>;
    entries: HarEntry[];
  };
};

function toHarRequest(request: Request): HarRequest {
  const headers = headerMapToList(request.headers());
  const postData = request.postData();
  return {
    method: request.method(),
    url: request.url(),
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers,
    queryString: [],
    headersSize: -1,
    bodySize: postData === null ? 0 : Buffer.byteLength(postData, "utf8"),
    ...(postData === null
      ? {}
      : { postData: { mimeType: headerOf(headers, "content-type") ?? "", text: postData } }),
  };
}

async function toHarResponse(response: Response): Promise<HarResponse> {
  const headers = headerMapToList(await response.allHeaders());
  let bodyText: string | undefined;
  try {
    const buffer = await response.body();
    bodyText = buffer.toString("utf8");
  } catch {
    bodyText = undefined;
  }
  const mimeType = headerOf(headers, "content-type") ?? "";
  return {
    status: response.status(),
    statusText: response.statusText(),
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers,
    content: {
      size: bodyText === undefined ? 0 : Buffer.byteLength(bodyText, "utf8"),
      mimeType,
      ...(bodyText === undefined ? {} : { text: bodyText }),
    },
    redirectURL: headerOf(headers, "location") ?? "",
    headersSize: -1,
    bodySize: bodyText === undefined ? 0 : Buffer.byteLength(bodyText, "utf8"),
  };
}

function emptyResponse(): HarResponse {
  return {
    status: 0,
    statusText: "",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    content: { size: 0, mimeType: "" },
    redirectURL: "",
    headersSize: -1,
    bodySize: 0,
  };
}

function headerMapToList(headers: Record<string, string>): HarHeader[] {
  const list: HarHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    list.push({ name, value });
  }
  return list;
}

function headerOf(headers: HarHeader[], name: string): string | undefined {
  const target = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === target) return header.value;
  }
  return undefined;
}

/**
 * Shared no-op for the `request` event listeners — per-request bookkeeping
 * happens on `requestfinished` so we have both halves of the round-trip,
 * but Playwright requires the listener to be attached for the event flow
 * to start delivering. Hoisting it out of `HarBuffer.start` keeps the
 * listener identity stable so detach (`page.off`) actually finds it.
 */
function noopRequestHandler(): void {
  // intentionally empty
}
