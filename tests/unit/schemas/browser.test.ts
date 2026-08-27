/**
 * Unit tests for the Playwright-related Zod schemas in
 * {@link module:schemas/browser} — focusing on the `stealth` field added by
 * plan 0012.
 */
import { describe, expect, it } from "vitest";

import { browserSessionStartRequestSchema } from "../../../src/schemas/browser.js";

describe("browserSessionStartRequestSchema", () => {
  describe("stealth field defaults", () => {
    it("defaults stealth to true when the field is omitted", () => {
      const result = browserSessionStartRequestSchema.parse({ url: "https://example.com" });
      expect(result.stealth).toBe(true);
    });

    it("preserves stealth: true when explicitly supplied", () => {
      const result = browserSessionStartRequestSchema.parse({
        url: "https://example.com",
        stealth: true,
      });
      expect(result.stealth).toBe(true);
    });

    it("accepts stealth: false to opt out per session", () => {
      const result = browserSessionStartRequestSchema.parse({
        url: "https://example.com",
        stealth: false,
      });
      expect(result.stealth).toBe(false);
    });
  });

  describe("url field validation", () => {
    it("rejects internal / loopback URLs even when stealth is set", () => {
      const result = browserSessionStartRequestSchema.safeParse({
        url: "http://localhost/",
        stealth: true,
      });
      expect(result.success).toBe(false);
    });

    it("accepts a public https URL", () => {
      const result = browserSessionStartRequestSchema.safeParse({ url: "https://example.com/" });
      expect(result.success).toBe(true);
    });
  });

  describe("parsed output shape", () => {
    it("returns both url and stealth in the parsed object", () => {
      const result = browserSessionStartRequestSchema.parse({ url: "https://example.com" });
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("stealth");
    });

    it("rejects non-boolean stealth values", () => {
      const result = browserSessionStartRequestSchema.safeParse({
        url: "https://example.com",
        stealth: "yes",
      });
      expect(result.success).toBe(false);
    });
  });
});
