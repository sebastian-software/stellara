/** Resource bounds for untrusted OAuth client identifiers. */

/**
 * Permanent CIMD identifiers should fit comfortably within 4 KiB while this
 * bound prevents untrusted values from becoming oversized cache and flight
 * keys. The separate byte ceiling keeps non-ASCII paths bounded as well.
 */
export const MAX_OAUTH_CLIENT_ID_LENGTH = 4 * 1024;
export const MAX_OAUTH_CLIENT_ID_BYTES = 8 * 1024;

/** Returns whether an OAuth client identifier is non-empty and safely bounded. */
export function isOAuthClientIdWithinLimit(clientId: string): boolean {
  return (
    clientId.length > 0 &&
    clientId.length <= MAX_OAUTH_CLIENT_ID_LENGTH &&
    Buffer.byteLength(clientId, "utf8") <= MAX_OAUTH_CLIENT_ID_BYTES
  );
}
