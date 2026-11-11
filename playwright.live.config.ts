/**
 * OPT-IN smoke test against a DEPLOYED instance. Not part of `npm run test:e2e`
 * or CI (`playwright.config.ts` ignores e2e/live). Run it with:
 *
 *   LIVE_BASE_URL=https://your-app.vercel.app npm run test:live
 *
 * It refuses to start without LIVE_BASE_URL and refuses any non-https URL
 * unless the host is localhost. See e2e/live/smoke.spec.ts for what it does,
 * and for the extra variables the optional account journey needs.
 */
import { defineConfig, devices } from "@playwright/test";
import { liveTarget } from "./e2e/live/target";

const target = liveTarget(); // throws with a clear message when misconfigured

export default defineConfig({
  testDir: "./e2e/live",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  // Under the ignored e2e/.artifacts folder; nothing is recorded on purpose:
  // traces, videos and screenshots could capture a code or a password.
  outputDir: "./e2e/.artifacts/live",
  use: {
    baseURL: target.baseURL,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "live", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 860 } } }],
});
