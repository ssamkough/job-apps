import { defineConfig, devices } from "@playwright/test";

const E2E_DB = "postgresql://jobapps:jobapps@localhost:5432/jobapps_e2e";
const PORT = 3100;

// Runs against the *production build* so headers/CSP/behavior match deploy.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  // e2e/live is the opt-in smoke test for a deployed URL (npm run test:live).
  testIgnore: "**/live/**",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "./e2e/.artifacts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@mobile/ },
  ],
  webServer: [
    { command: "node e2e/mock-services.mjs", url: "http://127.0.0.1:11501/chats", reuseExistingServer: false },
    {
      command: `node scripts/prepare-e2e.mjs && npx next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        DATABASE_URL: E2E_DB,
        DIRECT_URL: E2E_DB,
        STORAGE_DRIVER: "local",
        UPLOAD_DIR: "./data/e2e-uploads",
        // E2E_AI=false exercises the no-AI launch configuration.
        AI_ENABLED: process.env.E2E_AI === "false" ? "false" : "true",
        // Job-posting import without the AI worker (no queue is wired up here).
        IMPORT_ENABLED: "true",
        OLLAMA_BASE_URL: "http://127.0.0.1:11500",
        OLLAMA_MODEL: "mock",
        // The app talks to an in-process stand-in for Neon Auth (e2e/mock-neon-auth.mjs).
        NEON_AUTH_BASE_URL: "http://127.0.0.1:11502/neondb/auth",
        NEON_AUTH_COOKIE_SECRET: "e2e-only-cookie-secret-at-least-32-characters-long",
        SUPPORT_EMAIL: "help@example.test",
      },
    },
  ],
});
