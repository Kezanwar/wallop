import { defineConfig } from "vitest/config";

// Manual, on-demand runs against real external services (R2, Gemini).
// No DB globalSetup: the generation smoke migrates DATABASE_URL_TEST itself.
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.smoke.test.ts"],
    fileParallelism: false,
    // Gemini 3 image generation is a thinking model: ~12-23s at 1K, longer at 4K.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // Smokes exist to be read: their console reports are the result. Vitest
    // swallows stdout from passing tests unless intercept is off.
    disableConsoleIntercept: true,
  },
});
