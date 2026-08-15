import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    include: ["src/**/__tests__/**/*.test.ts"],
    isolate: false
  }
});
