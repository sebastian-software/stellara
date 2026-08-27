import type { FastifyInstance } from "fastify";

function injectMethod(method: string): "DELETE" | "GET" | "POST" {
  if (method === "DELETE" || method === "GET" || method === "POST") return method;
  throw new Error(`Unsupported MCP test method: ${method}`);
}

function responseHeaders(source: Record<string, number | string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") headers.set(name, value);
    else if (typeof value === "number") headers.set(name, String(value));
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

/** Adapts the official MCP client's FetchLike interface onto Fastify inject. */
export function createMcpInjectFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
    const payload = request.method === "POST" ? await request.text() : undefined;
    const response = await app.inject({
      method: injectMethod(request.method),
      url: `${url.pathname}${url.search}`,
      headers,
      payload,
    });
    return new Response(response.rawPayload, {
      status: response.statusCode,
      headers: responseHeaders(response.headers),
    });
  };
}
