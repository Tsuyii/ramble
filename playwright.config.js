import { defineConfig, devices } from "@playwright/test";

// Ramble E2E config. The same frontend runs in a plain browser and in the
// Electron renderer; these tests drive the browser surface at 127.0.0.1:5179.
const PORT = process.env.PORT || 5179;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "html" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Boot the local server for tests; reuse one already running in dev.
  webServer: {
    command: "node server.js",
    url: BASE_URL,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
