/**
 * Unit tests for {@link module:playwright-identity} — pure functions and
 * constants that build the Linux Chrome stable spoof identity (plan 0012).
 *
 * No Playwright, no network, no module mocks required — the module has zero
 * external dependencies.
 */
import { describe, expect, it } from "vitest";

import {
  buildLinuxChromeUserAgent,
  buildStealthContextOptions,
  parseChromeMajor,
  STEALTH_LOCALE,
  STEALTH_TIMEZONE,
  STEALTH_UA_FALLBACK_MAJOR,
  STEALTH_VIEWPORT,
} from "../../../src/services/playwright-identity.js";

// ---------------------------------------------------------------------------
// parseChromeMajor
// ---------------------------------------------------------------------------

describe("parseChromeMajor", () => {
  it("parses HeadlessChrome/<major> format", () => {
    expect(parseChromeMajor("HeadlessChrome/148.0.7778.96")).toBe(148);
  });

  it("parses Chrome/<major> format (no Headless prefix)", () => {
    expect(parseChromeMajor("Chrome/148.0.7778.96")).toBe(148);
  });

  it("parses Chromium/<major> format (case-insensitive match)", () => {
    // The CHROME_MAJOR_PATTERN uses the /i flag and matches `(Headless)?Chrome`;
    // "Chromium" does NOT match the pattern — the fallback sentinel is expected.
    expect(parseChromeMajor("Chromium/148.0.0.0")).toBe(STEALTH_UA_FALLBACK_MAJOR);
  });

  it("returns the sentinel for an empty string", () => {
    expect(parseChromeMajor("")).toBe(STEALTH_UA_FALLBACK_MAJOR);
  });

  it("returns the sentinel for a whitespace-only string", () => {
    expect(parseChromeMajor("   ")).toBe(STEALTH_UA_FALLBACK_MAJOR);
  });

  it("returns the sentinel for a garbage string", () => {
    expect(parseChromeMajor("garbage")).toBe(STEALTH_UA_FALLBACK_MAJOR);
  });

  it("returns the sentinel for an unrelated UA string", () => {
    expect(
      parseChromeMajor(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0",
      ),
    ).toBe(STEALTH_UA_FALLBACK_MAJOR);
  });

  it("extracts the correct major from a realistic Playwright version string", () => {
    // Playwright reports browser.version() as "HeadlessChrome/<major>.<minor>.<build>.<patch>".
    expect(parseChromeMajor("HeadlessChrome/120.0.6099.28")).toBe(120);
  });

  it("is case-insensitive for the Chrome prefix", () => {
    expect(parseChromeMajor("headlesschrome/148.0.7778.96")).toBe(148);
  });
});

// ---------------------------------------------------------------------------
// buildLinuxChromeUserAgent
// ---------------------------------------------------------------------------

describe("buildLinuxChromeUserAgent", () => {
  it("contains Chrome/<major>.0.0.0 with the supplied major version", () => {
    const ua = buildLinuxChromeUserAgent(148);
    expect(ua).toContain("Chrome/148.0.0.0");
  });

  it("contains the Linux x86_64 platform token", () => {
    const ua = buildLinuxChromeUserAgent(148);
    expect(ua).toContain("X11; Linux x86_64");
  });

  it("does NOT contain HeadlessChrome", () => {
    const ua = buildLinuxChromeUserAgent(148);
    expect(ua).not.toContain("HeadlessChrome");
  });

  it("starts with the standard Mozilla/5.0 prefix", () => {
    const ua = buildLinuxChromeUserAgent(148);
    expect(ua).toMatch(/^Mozilla\/5\.0/);
  });

  it("works with the fallback sentinel major", () => {
    const ua = buildLinuxChromeUserAgent(STEALTH_UA_FALLBACK_MAJOR);
    expect(ua).toContain(`Chrome/${STEALTH_UA_FALLBACK_MAJOR}.0.0.0`);
    expect(ua).not.toContain("HeadlessChrome");
  });
});

// ---------------------------------------------------------------------------
// buildStealthContextOptions
// ---------------------------------------------------------------------------

describe("buildStealthContextOptions", () => {
  const options = buildStealthContextOptions(148);

  it("sets userAgent to the Linux Chrome stable string for the supplied major", () => {
    expect(options.userAgent).toBe(buildLinuxChromeUserAgent(148));
  });

  it("sets locale to STEALTH_LOCALE (de-DE)", () => {
    expect(options.locale).toBe(STEALTH_LOCALE);
    expect(options.locale).toBe("de-DE");
  });

  it("sets timezoneId to STEALTH_TIMEZONE (Europe/Berlin)", () => {
    expect(options.timezoneId).toBe(STEALTH_TIMEZONE);
    expect(options.timezoneId).toBe("Europe/Berlin");
  });

  it("sets viewport to STEALTH_VIEWPORT (1366x768)", () => {
    expect(options.viewport).toStrictEqual(STEALTH_VIEWPORT);
    expect(options.viewport).toStrictEqual({ width: 1366, height: 768 });
  });

  it("sets deviceScaleFactor to 1", () => {
    expect(options.deviceScaleFactor).toBe(1);
  });

  it("sets colorScheme to light", () => {
    expect(options.colorScheme).toBe("light");
  });

  it("returns a fresh viewport object (no shared reference)", () => {
    const a = buildStealthContextOptions(148);
    const b = buildStealthContextOptions(148);
    expect(a.viewport).not.toBe(b.viewport);
  });

  it("reflects the supplied major in the userAgent", () => {
    const opts99 = buildStealthContextOptions(99);
    expect(opts99.userAgent).toContain("Chrome/99.0.0.0");
    const opts200 = buildStealthContextOptions(200);
    expect(opts200.userAgent).toContain("Chrome/200.0.0.0");
  });
});
