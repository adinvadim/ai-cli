import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    setupFiles: ["src/test/setup.ts"],
  },
});
