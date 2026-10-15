import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    fileParallelism: false,
    // Smoke tests hit real paid external services and are slow. They run only
    // from `pnpm smoke`, never here and never in CI.
    exclude: ["**/node_modules/**", "test/smoke/**"],
  },
});
