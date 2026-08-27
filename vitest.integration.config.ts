import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the integration suite (concept §26, plan 0002 §8).
 *
 * The integration tests load real bearer tokens and upstream credentials from
 * `process.env` and exercise the live Exa, Firecrawl and Qdrant endpoints via
 * Fastify's in-memory `app.inject` transport (no TCP `listen`). They are kept
 * out of the unit suite so `pnpm agent:check` stays hermetic. Maintainers run
 * this configuration locally and supply credentials through `process.env`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // Upstream calls (Exa search, Firecrawl scrape/crawl, Qdrant CRUD,
    // embeddings) plus per-route timeouts up to 60 s mean the per-test budget
    // needs to comfortably outpace the slowest single call.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential execution across files: the memory test uses a shared Qdrant
    // collection and would otherwise race against itself or other integration
    // tests that happen to share infrastructure. Disabling file parallelism
    // keeps the upstream load predictable for the configured test resources.
    // `fileParallelism: false` is the Vitest-4 successor of `poolOptions.forks.singleFork`.
    fileParallelism: false,
  },
});
