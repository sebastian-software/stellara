/**
 * Unit tests for the read-only GraphQL guard (plan 0014).
 *
 * `assertQueryOnly` is a synchronous validator: it parses the raw GraphQL
 * document and throws an {@link AppError} (`BAD_REQUEST`) for any syntax
 * error or any `mutation`/`subscription` operation in the document. Pure
 * `query` operations — including the anonymous shorthand and documents with
 * multiple query operations or fragments — are allowed through untouched.
 */
import { describe, expect, it } from "vitest";

import { AppError, ErrorCode } from "../../../src/errors.js";
import { assertQueryOnly } from "../../../src/services/graphql-guard.js";

/** Captures the `AppError` thrown by `assertQueryOnly`, failing the test if none was thrown. */
function captureAppError(query: string): AppError {
  try {
    assertQueryOnly(query);
  } catch (error) {
    if (AppError.is(error)) return error;
    throw error;
  }
  throw new Error(`expected assertQueryOnly(${JSON.stringify(query)}) to throw`);
}

describe("assertQueryOnly — allowed documents", () => {
  it("allows a simple anonymous query", () => {
    expect(() => {
      assertQueryOnly("query { field }");
    }).not.toThrow();
  });

  it("allows a named query operation", () => {
    expect(() => {
      assertQueryOnly("query GetThing { field }");
    }).not.toThrow();
  });

  it("allows the anonymous shorthand form", () => {
    expect(() => {
      assertQueryOnly("{ field }");
    }).not.toThrow();
  });

  it("allows a query alongside a fragment definition", () => {
    const document = `
      query GetThing {
        field {
          ...ThingFields
        }
      }
      fragment ThingFields on Thing {
        id
        name
      }
    `;
    expect(() => {
      assertQueryOnly(document);
    }).not.toThrow();
  });

  it("allows multiple query operations in the same document", () => {
    const document = `
      query First {
        field
      }
      query Second {
        otherField
      }
    `;
    expect(() => {
      assertQueryOnly(document);
    }).not.toThrow();
  });
});

describe("assertQueryOnly — rejected documents", () => {
  it("rejects an anonymous mutation with a BAD_REQUEST AppError", () => {
    const error = captureAppError("mutation { doThing }");
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it("rejects a named subscription with a BAD_REQUEST AppError", () => {
    const error = captureAppError("subscription OnThing { thingChanged }");
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it("rejects a document mixing a query and a mutation operation", () => {
    const document = `
      query GetThing {
        field
      }
      mutation DoThing {
        doThing
      }
    `;
    const error = captureAppError(document);
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it("rejects unparseable syntax garbage with a BAD_REQUEST AppError", () => {
    const error = captureAppError("this is not { valid graphql at all !!!");
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it("does not leak the underlying parser error message", () => {
    const error = captureAppError("this is not { valid graphql at all !!!");
    expect(error.message).toBe("graphql query is not parseable");
  });
});
