import { defineConfig } from "vitest/config";

/**
 * Default Vitest configuration — runs the unit suite only.
 *
 * Integration tests live under `tests/integration/**` and hit real upstreams
 * (Firecrawl, Exa, Qdrant, embeddings provider, Stellara tokens). They are
 * deliberately excluded from `pnpm test` / `pnpm agent:check` so the quality
 * gate stays hermetic; maintainers can opt in locally through the dedicated
 * `pnpm test:integration` script and `vitest.integration.config.ts`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
