/**
 * Pino logger factory used by Stellara.
 *
 * Produces a JSON logger writing to stdout, configured with the redaction
 * paths from concept §21 (`req.headers.authorization`, `req.body.text`).
 * Also exposes a Fastify-compatible `LoggerOptions` object so the bootstrap
 * in `server.ts` can hand the same configuration to `Fastify({ logger })`.
 */
import { type DestinationStream, type Logger, type LoggerOptions, pino } from "pino";

import type { Config } from "./config.js";

/**
 * Pino redaction paths derived from concept §21.
 *
 * Note: Fastify's default request serializer does not include `req.body`. The
 * `req.body.text` path therefore only takes effect when route handlers (e.g.
 * memory upsert in step 5) explicitly log a structured object with that
 * shape, or when a custom serializer projects the body. Implementers in
 * downstream steps must follow this contract.
 */
export const LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.body.text",
  // MCP wraps the upsert payload one level deeper: the same secret text
  // arrives under `body.params.arguments.text` on the JSON-RPC path.
  "req.body.params.arguments.text",
] as const;

/**
 * Builds the Pino options that both {@link createLogger} and the Fastify
 * `logger` option consume — keeps them in sync.
 *
 * The optional `destination` argument lets tests redirect log output into a
 * memory-backed stream without touching pino's worker setup. Production
 * code (`server.ts`) omits it so logging stays on the default
 * `process.stdout.fd` path via sonic-boom.
 */
export function createLoggerOptions(
  config: Config,
  destination?: DestinationStream,
): LoggerOptions {
  const options: LoggerOptions = {
    level: config.logLevel,
    redact: {
      paths: [...LOG_REDACT_PATHS],
      remove: false,
      censor: "[redacted]",
    },
  };
  if (destination !== undefined) {
    // Fastify forwards `opts.stream` to `pino(opts, opts.stream)` (see
    // `node_modules/fastify/lib/logger-pino.js`), so wiring it here is
    // enough for both the standalone `createLogger` helper and the Fastify
    // bootstrap to pick the same destination up.
    Reflect.set(options, "stream", destination);
  }
  return options;
}

/** Creates a Pino logger pre-configured for Stellara. */
export function createLogger(config: Config): Logger {
  return pino(createLoggerOptions(config));
}
