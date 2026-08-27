/**
 * Identity templates for the Playwright stealth slice (plan 0012).
 *
 * Centralises the "what do target sites see" decision (user-agent string,
 * locale, timezone, viewport) so the pool/client only know "stealth on or
 * off" — never the literal Linux Chrome desktop identity values. A later
 * slice that adds multiple identity profiles (mobile, alternative locales,
 * operator-configurable identities) extends this module without touching
 * the pool wiring.
 *
 * No Pino logger import on purpose — callers detect the sentinel-major
 * fallback by comparing against {@link STEALTH_UA_FALLBACK_MAJOR} and log
 * in their own context (the pool already has access to the request-scoped
 * logger). Keeping the module log-free also keeps it trivial to unit-test.
 */

/** BCP-47 locale advertised by the spoofed context. */
export const STEALTH_LOCALE = "de-DE";

/** IANA timezone advertised by the spoofed context. */
export const STEALTH_TIMEZONE = "Europe/Berlin";

/**
 * Default viewport for the spoofed context. 1366×768 is the most common
 * Linux desktop resolution on tracker telemetry; deliberately not 1080p
 * because that would mismatch the typical Linux desktop fleet.
 */
export const STEALTH_VIEWPORT = { width: 1366, height: 768 } as const;

/**
 * Sentinel major version used by {@link parseChromeMajor} when
 * `browser.version()` returns a string the parser cannot interpret. Callers
 * compare the parser result against this constant to decide whether to
 * emit a warn-level log entry — see `PlaywrightClient.startSession`.
 *
 * The value tracks roughly one Chromium milestone behind the bundled
 * Playwright at the time of writing (plan 0012). Bumping it requires no
 * code change elsewhere; treat it as a self-contained "if all else fails"
 * floor that still produces a plausible UA.
 */
export const STEALTH_UA_FALLBACK_MAJOR = 120;

/**
 * Builds the Linux Chrome stable user-agent string for the supplied major
 * version. Format mirrors the canonical Chromium output:
 *
 * ```
 * Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36
 * ```
 *
 * `AppleWebKit/537.36` and `Safari/537.36` are constant tokens every
 * Chromium release keeps for legacy parser compatibility — they are NOT a
 * stable indicator of the actual engine version.
 */
export function buildLinuxChromeUserAgent(major: number): string {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Pre-compiled matcher for the leading `Chrome/<major>` or
 * `HeadlessChrome/<major>` tokens in a `browser.version()` payload. Both
 * prefixes are accepted because the stealth plugin may or may not rewrite
 * the `Headless` token depending on its registration order.
 */
const CHROME_MAJOR_PATTERN = /(?:Headless)?Chrome\/(\d+)\./i;

/**
 * Extracts the Chromium major version from a `browser.version()` payload.
 *
 * Returns {@link STEALTH_UA_FALLBACK_MAJOR} when the input is blank or
 * does not match the expected `(Headless)Chrome/<major>.<minor>.<build>.<patch>`
 * shape. The caller can detect the fallback by comparing the result against
 * the sentinel constant and emit a warn-level log entry.
 */
export function parseChromeMajor(browserVersion: string): number {
  const trimmed = browserVersion.trim();
  if (trimmed === "") return STEALTH_UA_FALLBACK_MAJOR;
  const match = CHROME_MAJOR_PATTERN.exec(trimmed);
  if (match === null) return STEALTH_UA_FALLBACK_MAJOR;
  const major = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(major) || major <= 0) return STEALTH_UA_FALLBACK_MAJOR;
  return major;
}

/**
 * Shape of the context options the stealth slice forwards to
 * `browser.newContext()`. Deliberately narrow (only the fields the slice
 * actually overrides) so the caller can spread the result without leaking
 * accidental Playwright defaults.
 */
export type StealthContextOptions = {
  userAgent: string;
  locale: string;
  timezoneId: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  colorScheme: "light";
};

/**
 * Assembles the Playwright `BrowserContextOptions` slice required for the
 * Linux Chrome stable identity. Centralised so the pool/client never has
 * to know which fields constitute "the spoofed identity" — adding another
 * field (e.g. `extraHTTPHeaders` for Sec-CH-UA) happens here only.
 */
export function buildStealthContextOptions(major: number): StealthContextOptions {
  return {
    userAgent: buildLinuxChromeUserAgent(major),
    locale: STEALTH_LOCALE,
    timezoneId: STEALTH_TIMEZONE,
    viewport: { ...STEALTH_VIEWPORT },
    deviceScaleFactor: 1,
    colorScheme: "light",
  };
}
