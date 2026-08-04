import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    environment: "node",
    globals: true,
    restoreMocks: true,
    setupFiles: ["./test/setup.ts"],
  },
});
