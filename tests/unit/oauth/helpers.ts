/**
 * Shared test helpers for the OAuth library suite.
 *
 * Narrowing of discriminated-union results is moved into an `asserts` helper
 * so the test bodies remain conditional-free (per the project lint rules)
 * while still giving TypeScript the precise type after the assertion.
 */
import { expect } from "vitest";

/**
 * Asserts that `result.kind === expected` and narrows the static type to the
 * matching union variant. Throws (via vitest) if the kinds disagree.
 */
export function assertKind<R extends { kind: string }, K extends R["kind"]>(
  result: R,
  expected: K,
): asserts result is Extract<R, { kind: K }> {
  expect(result.kind).toBe(expected);
}
