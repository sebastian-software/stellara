import { defineConfig } from "vitest/config";

/**
 * Container tests build and exercise the final Docker image. They are kept
 * outside the default hermetic quality gate and run serially to avoid Docker
 * resource collisions on developer machines and CI runners.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/container/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 900_000,
    testTimeout: 180_000,
  },
});
