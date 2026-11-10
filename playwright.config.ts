import { defineConfig, devices } from "@playwright/test";

const E2E_DB = "postgresql://jobapps:jobapps@localhost:5432/jobapps_e2e";
const PORT = 3100;

// Runs against the *production build* so headers/CSP/behavior match deploy.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
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
    { command: "node e2e/mock-services.mjs", url: "http://127.0.0.1:11501/mails", reuseExistingServer: false },
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
        APP_URL: `http://localhost:${PORT}`,
        STORAGE_DRIVER: "local",
        UPLOAD_DIR: "./data/e2e-uploads",
        OLLAMA_BASE_URL: "http://127.0.0.1:11500",
        OLLAMA_MODEL: "mock",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "2526",
        SMTP_SECURE: "false",
        EMAIL_FROM: "Job Tracker <noreply@example.test>",
        EMAIL_DAILY_LIMIT: "500",
        SUPPORT_EMAIL: "help@example.test",
      },
    },
  ],
});
