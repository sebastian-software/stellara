/** Bounded source-address limiter for real CIMD egress operations. */

const RATE_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 4 * 1024;
const PRUNE_INTERVAL = 64;

type RateBucket = { count: number; resetAt: number };

export type SourceRateLimiter = {
  consume: (sourceIp: string, nowMs: number) => number | undefined;
  clear: () => void;
};

/** Creates an LRU-bounded limiter with amortized expiry cleanup. */
export function createSourceRateLimiter(options: {
  maxPerMinute: number;
  maxEntries?: number;
}): SourceRateLimiter {
  const buckets = new Map<string, RateBucket>();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let missesSincePrune = 0;
  return {
    consume(sourceIp, nowMs) {
      missesSincePrune += 1;
      if (missesSincePrune >= PRUNE_INTERVAL || buckets.size >= maxEntries) {
        pruneExpiredBuckets(buckets, nowMs);
        missesSincePrune = 0;
      }
      const existing = consumeExisting({
        buckets,
        sourceIp,
        nowMs,
        maxPerMinute: options.maxPerMinute,
      });
      if (existing.matched) return existing.retryAfterSeconds;
      ensureCapacity(buckets, maxEntries);
      buckets.set(sourceIp, { count: 1, resetAt: nowMs + RATE_WINDOW_MS });
    },
    clear() {
      buckets.clear();
      missesSincePrune = 0;
    },
  };
}

function consumeExisting(args: {
  buckets: Map<string, RateBucket>;
  sourceIp: string;
  nowMs: number;
  maxPerMinute: number;
}): { matched: boolean; retryAfterSeconds?: number } {
  const entry = args.buckets.get(args.sourceIp);
  args.buckets.delete(args.sourceIp);
  if (entry === undefined || entry.resetAt <= args.nowMs) return { matched: false };
  args.buckets.set(args.sourceIp, entry);
  if (entry.count >= args.maxPerMinute) {
    return {
      matched: true,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - args.nowMs) / 1000)),
    };
  }
  entry.count += 1;
  return { matched: true };
}

function ensureCapacity(buckets: Map<string, RateBucket>, maxEntries: number): void {
  while (buckets.size >= maxEntries) {
    const oldest = buckets.keys().next();
    if (oldest.done) return;
    buckets.delete(oldest.value);
  }
}

function pruneExpiredBuckets(buckets: Map<string, RateBucket>, nowMs: number): void {
  for (const [sourceIp, entry] of buckets) {
    if (entry.resetAt <= nowMs) buckets.delete(sourceIp);
  }
}
