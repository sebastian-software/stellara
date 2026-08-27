/**
 * Orchestration for the lightweight HTTP-fetch tools `web_fetch` and
 * `web_graphql` (concept §8.17/§8.18, plan 0006).
 *
 * Lives in its own file so `src/tools/web.ts` stays under the per-file line
 * budget — the Firecrawl-backed tools and the generic-fetch tools share no
 * implementation detail beyond `withTimeout`, so splitting along that
 * seam is the natural cut.
 */
import type { FastifyInstance } from "fastify";

import type {
  FetchRequest,
  FetchResponse,
  GetRequest,
  GraphqlQueryRequest,
  GraphqlRequest,
  GraphqlResponse,
} from "../schemas/web.js";

import { assertQueryOnly } from "../services/graphql-guard.js";
import { runHttpFetch } from "../services/http-fetch.js";
import { PER_ROUTE_TIMEOUTS_MS, withTimeout } from "../timeouts.js";

/** Response shape returned by {@link runWebFetch}. */
export type WebFetchResult = FetchResponse;

/** Response shape returned by {@link runWebGraphql}. */
export type WebGraphqlResult = GraphqlResponse;

/** Response shape returned by {@link runWebGet} (read-only sibling of fetch). */
export type WebGetResult = FetchResponse;

/** Response shape returned by {@link runWebGraphqlQuery} (read-only GraphQL). */
export type WebGraphqlQueryResult = GraphqlResponse;

/**
 * Executes `web_fetch` — a generic HTTP request with SSRF guard, header
 * sanitization and a 10 MB body cap.
 *
 * The REST route logs structured audit info (method, host, path, status)
 * but never the request/response body or headers — see `routes/fetch.ts`.
 */
export async function runWebFetch(
  _app: FastifyInstance,
  input: FetchRequest,
): Promise<WebFetchResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.fetch, async (signal) =>
    runHttpFetch({
      url: input.url,
      method: input.method,
      headers: input.headers,
      body: input.body,
      responseFormat: input.responseFormat,
      followRedirects: input.followRedirects,
      maxRedirects: input.maxRedirects,
      signal,
    }),
  );
}

/**
 * Executes `web_get` — the read-only sibling of `web_fetch`. Restricted to
 * the HTTP safe methods (`GET`, `HEAD`, `OPTIONS`) at the schema level and
 * never carrying a request body, so the MCP tool can honestly declare
 * `readOnlyHint: true`. Shares the exact `runHttpFetch` path (SSRF guard,
 * header sanitization, 10 MB body cap) with `web_fetch`.
 */
export async function runWebGet(_app: FastifyInstance, input: GetRequest): Promise<WebGetResult> {
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.get, async (signal) =>
    runHttpFetch({
      url: input.url,
      method: input.method,
      headers: input.headers,
      responseFormat: input.responseFormat,
      followRedirects: input.followRedirects,
      maxRedirects: input.maxRedirects,
      signal,
    }),
  );
}

/**
 * Executes `web_graphql` — a thin wrapper that assembles the GraphQL POST
 * body and surfaces errors-in-200-body as-is. Non-JSON upstream responses
 * (e.g. HTML error pages from API gateways) collapse to a synthetic
 * `errors` array so the caller never has to disambiguate the failure
 * shape.
 */
export async function runWebGraphql(
  _app: FastifyInstance,
  input: GraphqlRequest,
): Promise<WebGraphqlResult> {
  const requestBody = buildGraphqlBody(input);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.graphql, async (signal) => {
    const response = await runHttpFetch({
      url: input.endpoint,
      method: "POST",
      headers: input.headers,
      body: { type: "json", value: requestBody },
      responseFormat: "auto",
      followRedirects: true,
      maxRedirects: 5,
      signal,
    });
    return toGraphqlResult(response);
  });
}

/**
 * Executes `web_graphql_query` — the read-only sibling of `web_graphql`.
 * Parses the `query` string first via {@link assertQueryOnly} and rejects any
 * document carrying a `mutation`/`subscription` operation with `BAD_REQUEST`,
 * then runs the identical path as `runWebGraphql`
 * (`buildGraphqlBody` → `runHttpFetch` → `toGraphqlResult`). This lets the
 * MCP tool honestly declare `readOnlyHint: true`.
 */
export async function runWebGraphqlQuery(
  _app: FastifyInstance,
  input: GraphqlQueryRequest,
): Promise<WebGraphqlQueryResult> {
  assertQueryOnly(input.query);
  const requestBody = buildGraphqlBody(input);
  return withTimeout(PER_ROUTE_TIMEOUTS_MS.graphqlQuery, async (signal) => {
    const response = await runHttpFetch({
      url: input.endpoint,
      method: "POST",
      headers: input.headers,
      body: { type: "json", value: requestBody },
      responseFormat: "auto",
      followRedirects: true,
      maxRedirects: 5,
      signal,
    });
    return toGraphqlResult(response);
  });
}

/** Builds the canonical `{ query, variables, operationName }` GraphQL body. */
function buildGraphqlBody(input: GraphqlRequest): {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
} {
  const body: { query: string; variables?: Record<string, unknown>; operationName?: string } = {
    query: input.query,
  };
  if (input.variables !== undefined) body.variables = input.variables;
  if (input.operationName !== undefined) body.operationName = input.operationName;
  return body;
}

/**
 * Projects a generic fetch result onto the GraphQL response shape. Anything
 * that does not parse as a JSON object becomes a synthetic error so the
 * caller does not have to special-case HTML error pages from reverse
 * proxies.
 */
function toGraphqlResult(response: FetchResponse): GraphqlResponse {
  if (response.format === "json" && isPlainObject(response.body)) {
    const body = response.body;
    const result: GraphqlResponse = { status: response.status };
    if ("data" in body) result.data = body.data;
    if (Array.isArray(body.errors)) result.errors = body.errors;
    if (isPlainObject(body.extensions)) result.extensions = body.extensions;
    return result;
  }
  return {
    status: response.status,
    errors: [{ message: "endpoint did not return JSON", status: response.status }],
  };
}

/** Type guard narrowing `unknown` to a plain object literal. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
