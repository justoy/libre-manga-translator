import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  workers: 1, // Single worker avoids extension profile contention
  use: {
    trace: "on-first-retry",
  },
});
