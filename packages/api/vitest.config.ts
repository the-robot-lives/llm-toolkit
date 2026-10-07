import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["../../test/strip-provider-env.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/__tests__/**"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 47 },
    },
  },
});
