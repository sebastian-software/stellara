/**
 * Embedding-model migration runner (concept §25).
 *
 * Offline CLI that re-embeds every point in a source Qdrant collection with
 * the currently configured embeddings provider and upserts the result into a
 * target collection. Used when the operator wants to switch embedding models
 * (e.g. `text-embedding-3-small` → `text-embedding-3-large`) which requires a
 * different vector size and therefore a fresh collection.
 *
 * Workflow per concept §25:
 *  1. Operator updates `EMBEDDINGS_MODEL` / `EMBEDDINGS_DIMENSIONS` in the env.
 *  2. Operator creates the new target collection (matching the new size).
 *  3. Operator runs `pnpm migrate:embeddings --from <old> --to <new>`.
 *  4. Operator swaps `QDRANT_COLLECTION` to `<new>` and restarts the gateway.
 *
 * This script intentionally does NOT swap the collection reference itself —
 * keeping the swap manual makes the migration auditable and lets the operator
 * verify the new collection before traffic moves over.
 */
import type { Schemas } from "@qdrant/js-client-rest";

import { QdrantClient } from "@qdrant/js-client-rest";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { EmbeddingsProvider } from "../src/services/embeddings.js";
import type { QdrantLikeClient } from "../src/services/qdrant-types.js";

import { loadConfig } from "../src/config.js";
import { createEmbeddingsProvider } from "../src/services/embeddings.js";

/** Default batch size for the cursor-paginated `scroll` loop. */
const DEFAULT_BATCH_SIZE = 100;

/** Upper bound for `--batch-size` to keep Qdrant request bodies reasonable. */
const MAX_BATCH_SIZE = 1000;

/**
 * Maximum number of consecutive empty scroll pages with a non-null cursor we
 * tolerate before bailing out. Guards against a misbehaving Qdrant returning
 * an advancing cursor without progress, which would otherwise loop forever.
 */
const MAX_EMPTY_PAGES = 3;

/** Exit code emitted when the operator passes invalid CLI arguments. */
const EXIT_INVALID_ARGS = 2;

/** Exit code emitted on a runtime failure (upstream error, unexpected response, …). */
const EXIT_RUNTIME_ERROR = 1;

/**
 * Exit code emitted when the migration completed embedding+upsert work but
 * the target collection ended up in a partial state (e.g. source/target
 * count mismatch). Distinct from {@link EXIT_RUNTIME_ERROR} so operators can
 * trigger a different remediation path in scripts/automation.
 */
const EXIT_PARTIAL_STATE = 3;

/** Exit code emitted when the migration is aborted via SIGINT/SIGTERM (POSIX 128 + signal). */
const EXIT_ABORTED = 130;

/** Help text shown by `--help`. Keep in sync with the CLI parser below. */
const HELP_TEXT = `Usage: pnpm migrate:embeddings --from <collection> --to <collection> [options]

Re-embeds every point in the source collection with the currently configured
embeddings provider (driven by EMBEDDINGS_MODEL / EMBEDDINGS_DIMENSIONS) and
upserts the result into the target collection.

Required:
  --from <collection>      Source collection (must exist, holds the old vectors).
  --to <collection>        Target collection (must exist, dimensions must match
                           the new EMBEDDINGS_DIMENSIONS — create it manually
                           before running this script, e.g. via the Qdrant UI).

Options:
  --batch-size <n>         Points per scroll/upsert batch (default ${String(DEFAULT_BATCH_SIZE)},
                           must be > 0 and <= ${String(MAX_BATCH_SIZE)}).
  --dry-run                Walk the source collection without writing to the
                           target — useful to estimate runtime and surface
                           missing payload.text entries before the real run.
  --help                   Show this message and exit.

Exit codes:
  0   Migration completed successfully (or --help was requested).
  1   Runtime failure (upstream error, unexpected response, …).
  2   Invalid CLI arguments.
  3   Partial state — work was upserted but source/target counts disagree.
  130 Aborted via SIGINT or SIGTERM (POSIX 128 + signal number).

Concept reference: docs/developer-guide/stellara-konzept.md §25.
`;

/** Parsed CLI options after validation. */
export type MigrationCliOptions = {
  fromCollection: string;
  toCollection: string;
  batchSize: number;
  dryRun: boolean;
};

/** Result returned by {@link runMigration}. */
export type MigrationResult = {
  /** Number of points the migration touched (re-embedded; not upserted in dry-run). */
  processedCount: number;
  /** Exact count of points in the source collection after the run. */
  sourceCount: number;
  /** Exact count of points in the target collection after the run (0 in dry-run). */
  targetCount: number;
  /** Whether the run was a dry-run (`true`) or a real migration (`false`). */
  dryRun: boolean;
};

/** Status callback invoked after every batch (and once at the start/end). */
export type MigrationLogger = (message: string) => void;

/** Options accepted by {@link runMigration}. */
export type MigrationRunOptions = {
  client: QdrantLikeClient;
  embedder: EmbeddingsProvider;
  fromCollection: string;
  toCollection: string;
  batchSize: number;
  dryRun: boolean;
  logger?: MigrationLogger;
  /**
   * Optional abort signal. The CLI wires it to SIGINT/SIGTERM so an operator
   * can stop a long-running migration without leaving in-flight HTTP requests
   * hanging. Aborting throws an `AbortError`/`DOMException`.
   */
  signal?: AbortSignal;
};

/** Options accepted by the {@link MigrationError} constructor. */
export type MigrationErrorOptions = {
  /**
   * When `true`, the failure occurred AFTER work was written to the target
   * collection (e.g. a final count mismatch). The CLI uses this flag to
   * distinguish recoverable misconfiguration from a half-written target.
   */
  partialState?: boolean;
};

/** Error subclass used for actionable runtime failures inside `runMigration`. */
export class MigrationError extends Error {
  /** See {@link MigrationErrorOptions.partialState}. */
  public readonly partialState: boolean;

  public constructor(message: string, options: MigrationErrorOptions = {}) {
    super(message);
    this.name = "MigrationError";
    this.partialState = options.partialState ?? false;
  }
}

/**
 * Re-embeds every point in `fromCollection` and upserts it into `toCollection`.
 * Exported so unit tests can call it with fakes; the CLI entry point in
 * {@link main} wires the real {@link QdrantClient} + {@link EmbeddingsProvider}.
 */
export async function runMigration(opts: MigrationRunOptions): Promise<MigrationResult> {
  validateRunOptions(opts);
  opts.signal?.throwIfAborted();
  const log = opts.logger ?? noopLogger;
  log(
    `Starting migration from "${opts.fromCollection}" to "${opts.toCollection}" ` +
      `(batchSize=${String(opts.batchSize)}, dryRun=${String(opts.dryRun)}, ` +
      `dimensions=${String(opts.embedder.dimensions())}).`,
  );

  const processedCount = await iterateAndMigrate(opts, log);
  opts.signal?.throwIfAborted();
  const sourceCount = await readCount(opts.client, opts.fromCollection);
  const targetCount = opts.dryRun ? 0 : await readCount(opts.client, opts.toCollection);

  if (opts.dryRun) {
    log(
      `Dry-run complete: would have migrated ${String(processedCount)} points. ` +
        `Source count: ${String(sourceCount)}. Target collection was not modified.`,
    );
  } else if (sourceCount !== targetCount) {
    throw new MigrationError(
      `Count mismatch after migration: source="${opts.fromCollection}" has ` +
        `${String(sourceCount)} points, target="${opts.toCollection}" has ` +
        `${String(targetCount)} points. Target collection may be in a partial state.`,
      { partialState: true },
    );
  } else {
    log(
      `Migration complete: ${String(processedCount)} points re-embedded. ` +
        `Counts match (source=target=${String(sourceCount)}).`,
    );
  }

  return { processedCount, sourceCount, targetCount, dryRun: opts.dryRun };
}

/** No-op default logger so callers that omit `logger` do not need a guard. */
const noopLogger: MigrationLogger = () => {
  // Intentionally empty.
};

/**
 * Asserts that the two collection names differ. Used by both the CLI parser
 * (early feedback) and `runMigration` (defense-in-depth for direct callers).
 */
function assertCollectionsDiffer(from: string, to: string): void {
  if (from === to) {
    throw new MigrationError(
      `Refusing to migrate: --from and --to point at the same collection ("${from}").`,
    );
  }
}

/** Validates the invariants `runMigration` depends on (kept separate for clarity). */
function validateRunOptions(opts: MigrationRunOptions): void {
  assertCollectionsDiffer(opts.fromCollection, opts.toCollection);
  if (opts.batchSize <= 0) {
    throw new MigrationError(`Invalid batch size: ${String(opts.batchSize)} (must be > 0).`);
  }
}

/**
 * Cursor-paginates through `fromCollection` and migrates each batch.
 * Returns the total number of points processed.
 */
/** Mutable progress counters threaded through the scroll loop. */
type ScrollProgress = {
  processed: number;
  batchIndex: number;
  consecutiveEmpty: number;
};

/** Args bundle for {@link handleScrollPage}. */
type HandleScrollPageArgs = {
  opts: MigrationRunOptions;
  log: MigrationLogger;
  points: ReadonlyArray<Schemas["Record"]>;
  progress: ScrollProgress;
};

/** Handles a single non-empty scroll page: migrates it and logs progress. */
async function handleScrollPage(args: HandleScrollPageArgs): Promise<void> {
  const { opts, log, points, progress } = args;
  progress.consecutiveEmpty = 0;
  await migrateBatch(opts, points);
  progress.processed += points.length;
  progress.batchIndex += 1;
  log(
    `Batch ${String(progress.batchIndex)} done: ${String(points.length)} points ` +
      `${opts.dryRun ? "inspected" : "re-embedded and upserted"} ` +
      `(running total: ${String(progress.processed)}).`,
  );
}

async function iterateAndMigrate(opts: MigrationRunOptions, log: MigrationLogger): Promise<number> {
  // Qdrant's `next_page_offset` matches the `offset` field on `ScrollRequest`,
  // so we let TypeScript infer the union (ExtendedPointId | Record<…> | null
  // | undefined) and feed it straight back into the next scroll call.
  let cursor: Schemas["ScrollRequest"]["offset"];
  const progress: ScrollProgress = { processed: 0, batchIndex: 0, consecutiveEmpty: 0 };

  for (;;) {
    opts.signal?.throwIfAborted();
    const page = await opts.client.scroll(opts.fromCollection, {
      limit: opts.batchSize,
      offset: cursor,
      // MUST include full payload — §25 requires verbatim preservation of userId/tags/metadata/createdAt/updatedAt.
      with_payload: true,
      with_vector: false,
    });
    if (page.points.length === 0) {
      progress.consecutiveEmpty += 1;
      if (progress.consecutiveEmpty >= MAX_EMPTY_PAGES) {
        throw new MigrationError(
          `Scroll cursor returned ${String(MAX_EMPTY_PAGES)} consecutive empty pages but kept ` +
            `advancing; aborting to avoid an infinite loop.`,
        );
      }
    } else {
      await handleScrollPage({ opts, log, points: page.points, progress });
    }
    const next = page.next_page_offset;
    if (next === null || next === undefined) break;
    cursor = next;
  }

  return progress.processed;
}

/** Re-embeds every point in `points` and upserts the new vectors into the target. */
async function migrateBatch(
  opts: MigrationRunOptions,
  points: ReadonlyArray<Schemas["Record"]>,
): Promise<void> {
  // Always validate every point — even in dry-run — so the operator finds out
  // about missing payload.text without burning embedding quota.
  const prepared = points.map((point) => ({ point, text: extractText(point) }));
  if (opts.dryRun) {
    // Skip embedding + upsert in dry-run so we do not burn API quota; the
    // operator just wants to know whether the source collection is migratable.
    return;
  }
  // Sequential embedding keeps us friendly to upstream rate limits (mirrors
  // the original loop). Once all vectors are ready, a single upsert per batch
  // cuts Qdrant round-trips by an order of magnitude vs. one upsert per point.
  const upsertPoints: Array<Schemas["PointStruct"]> = [];
  for (const { point, text } of prepared) {
    opts.signal?.throwIfAborted();
    const vector = await opts.embedder.embed(text, opts.signal);
    upsertPoints.push({ id: point.id, vector, payload: point.payload ?? {} });
  }
  opts.signal?.throwIfAborted();
  await opts.client.upsert(opts.toCollection, { wait: true, points: upsertPoints });
}

/**
 * Pulls `payload.text` out of a Qdrant record. Throws when the payload is
 * missing or `text` is not a string — the operator must know about points
 * that would otherwise be silently dropped.
 */
function extractText(point: Schemas["Record"]): string {
  const payload = point.payload;
  if (payload === undefined || payload === null) {
    throw new MigrationError(
      `Point "${String(point.id)}" has no payload — cannot re-embed without payload.text.`,
    );
  }
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== "string") {
    throw new MigrationError(
      `Point "${String(point.id)}" is missing a string payload.text (got ${typeof text}).`,
    );
  }
  return text;
}

/** Reads the exact point count of a collection via Qdrant's `count` endpoint. */
async function readCount(client: QdrantLikeClient, collection: string): Promise<number> {
  const result = await client.count(collection, { exact: true });
  return result.count;
}

/**
 * Parses CLI arguments. Exported so callers (e.g. tests) can reuse the parser
 * without invoking the full bootstrap. Returns `undefined` when `--help` was
 * requested so the caller can print help text and exit cleanly.
 */
export function parseCliArgs(argv: readonly string[]): MigrationCliOptions | undefined {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "batch-size": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (parsed.values.help) return undefined;

  const from = parsed.values.from;
  const to = parsed.values.to;
  if (typeof from !== "string" || from === "") {
    throw new MigrationError("Missing required argument: --from <collection>.");
  }
  if (typeof to !== "string" || to === "") {
    throw new MigrationError("Missing required argument: --to <collection>.");
  }
  // `parseArgs` happily consumes the next token as the value, so
  // `--from --to new` would silently set `from = "--to"`. Detect that and
  // tell the operator they likely forgot a value.
  if (from.startsWith("--")) {
    throw new MigrationError(
      `--from looks like a flag, not a collection name ("${from}"). Did you forget to provide a value?`,
    );
  }
  if (to.startsWith("--")) {
    throw new MigrationError(
      `--to looks like a flag, not a collection name ("${to}"). Did you forget to provide a value?`,
    );
  }
  assertCollectionsDiffer(from, to);

  return {
    fromCollection: from,
    toCollection: to,
    batchSize: parseBatchSize(parsed.values["batch-size"]),
    dryRun: parsed.values["dry-run"],
  };
}

/** Parses and validates the `--batch-size` argument. */
function parseBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCH_SIZE;
  // Use `Number(...)` (not `parseInt`) so values like "100.7" or "0xff" are
  // rejected outright — the operator should know they passed a non-integer.
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new MigrationError(`Invalid --batch-size: "${raw}" (must be a positive integer).`);
  }
  if (value > MAX_BATCH_SIZE) {
    throw new MigrationError(
      `Invalid --batch-size: ${String(value)} exceeds the upper bound of ${String(MAX_BATCH_SIZE)}.`,
    );
  }
  return value;
}

/**
 * Injectable IO seam used by the CLI bootstrap. Production wiring routes
 * `stdout`/`stderr` through `console`; tests can supply a capturing
 * implementation so assertions can inspect what the CLI would print.
 */
export type MigrationIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

/** Default IO implementation that mirrors the previous direct `console.*` use. */
const defaultIo: MigrationIo = {
  stdout(line) {
    console.log(line);
  },
  stderr(line) {
    console.error(line);
  },
};

/**
 * Resolves the CLI arguments to {@link MigrationCliOptions}, printing help and
 * exiting via `process.exit` when the operator requested `--help` or supplied
 * an invalid combination. Extracted from {@link main} so the bootstrap stays
 * under the per-function statement budget.
 */
function resolveCliOptions(
  argv: readonly string[],
  io: MigrationIo = defaultIo,
): MigrationCliOptions {
  let options: MigrationCliOptions | undefined;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr("Run with --help to see usage.");
    process.exit(EXIT_INVALID_ARGS);
  }
  if (options === undefined) {
    io.stdout(HELP_TEXT);
    process.exit(0);
  }
  return options;
}

/**
 * Returns `true` when `error` represents an `AbortSignal` cancellation, i.e.
 * the operator hit Ctrl-C or the orchestrator sent SIGTERM mid-run.
 */
function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Wires the real Qdrant client + embedder and dispatches to {@link runMigration}.
 * Kept separate so {@link main} stays under the per-function statement budget.
 */
async function executeMigration(
  options: MigrationCliOptions,
  io: MigrationIo,
  signal: AbortSignal,
): Promise<void> {
  const config = loadConfig();
  // The migration script is meaningless without a Qdrant target and an
  // embeddings provider — refuse to start when memory is deactivated so the
  // operator gets a clear pointer instead of a cryptic Qdrant 401 later.
  if (!config.features.memory || !config.features.embeddings) {
    throw new Error(
      "migrate-embeddings requires QDRANT_BASE_URL, QDRANT_API_KEY and EMBEDDINGS_API_KEY",
    );
  }
  const client = new QdrantClient({
    url: config.qdrantBaseUrl,
    apiKey: config.qdrantApiKey,
    checkCompatibility: false,
  });
  const embedder = createEmbeddingsProvider(config);
  await runMigration({
    client,
    embedder,
    fromCollection: options.fromCollection,
    toCollection: options.toCollection,
    batchSize: options.batchSize,
    dryRun: options.dryRun,
    logger: io.stdout,
    signal,
  });
}

/**
 * Top-level CLI entry. Parses args, loads config, builds the real client +
 * embedder, runs the migration. Calls `process.exit` so the shell sees the
 * right status code; the exit calls are intentionally confined to this
 * bootstrap pair (mirroring how `src/server.ts` handles its exits).
 */
export async function main(argv: readonly string[], io: MigrationIo = defaultIo): Promise<void> {
  const options = resolveCliOptions(argv, io);

  // Bridge POSIX termination signals to an AbortController so in-flight
  // fetches/HTTP calls actually unwind instead of hanging until completion.
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  try {
    await executeMigration(options, io, controller.signal);
  } catch (error) {
    exitForError(error, io);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

/**
 * Maps a runtime failure to a stderr line + the right exit code. Kept in
 * one place so the mapping stays consistent and `main` keeps its statement
 * budget.
 */
function exitForError(error: unknown, io: MigrationIo): never {
  if (isAbortError(error)) {
    io.stderr("Migration aborted by signal — partial state may have been written.");
    process.exit(EXIT_ABORTED);
  }
  io.stderr(error instanceof Error ? error.message : String(error));
  if (error instanceof MigrationError && error.partialState) {
    process.exit(EXIT_PARTIAL_STATE);
  }
  process.exit(EXIT_RUNTIME_ERROR);
}

// Only auto-run when invoked as the entry point (mirrors src/server.ts).
const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  await main(process.argv.slice(2));
}
