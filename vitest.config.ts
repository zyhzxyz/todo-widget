import { defineConfig } from "vitest/config";

// Match the primary user's calendar; this also catches accidental UTC date slicing.
process.env.TZ = "Asia/Shanghai";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
