// @ts-nocheck
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    env: { BLOCKCHAIN_ADAPTER: "memory" },
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
