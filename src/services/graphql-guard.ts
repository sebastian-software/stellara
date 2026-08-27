/**
 * Read-only guard for `web_graphql_query` (concept §8.31/§8.32, plan 0014).
 *
 * Parses the raw GraphQL document with the official `graphql` parser and
 * rejects any document that carries a `mutation` or `subscription`
 * operation. Lives in its own file (rather than inside `tools/web-fetch.ts`)
 * so the orchestrator stays a thin wrapper and the parser dependency has a
 * single, testable entry point.
 */
import { parse } from "graphql";

import { AppError, ErrorCode } from "../errors.js";

/**
 * Asserts that `query` contains only read-only `query` operations.
 *
 * The whole document is rejected as soon as it contains **any** non-query
 * operation (mutation or subscription) — even if only a query would run —
 * so the read-only guarantee is obvious and predictable. An anonymous
 * shorthand (`{ field }`) parses as a `query` operation and is therefore
 * allowed.
 *
 * Syntax errors are translated into a generic {@link AppError} without
 * forwarding the parser's original message/stack, so a caller cannot probe
 * the parser internals through crafted input.
 *
 * @throws {AppError} `BAD_REQUEST` when the query is unparseable or contains
 *   a mutation/subscription operation.
 */
export function assertQueryOnly(query: string): void {
  let document;
  try {
    document = parse(query);
  } catch {
    throw new AppError({
      code: ErrorCode.BAD_REQUEST,
      message: "graphql query is not parseable",
    });
  }
  for (const definition of document.definitions) {
    // Only `OperationDefinition` nodes carry an `operation` discriminator;
    // fragment definitions and type-system nodes are read-only by nature.
    if (definition.kind === "OperationDefinition" && definition.operation !== "query") {
      throw new AppError({
        code: ErrorCode.BAD_REQUEST,
        message: "web_graphql_query only accepts read-only query operations",
      });
    }
  }
}
