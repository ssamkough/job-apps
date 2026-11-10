import path from "node:path";
import { defineConfig } from "vitest/config";

const TEST_DB =
  process.env.TEST_DATABASE_URL ??
  "postgresql://jobapps:jobapps@localhost:5432/jobapps_test";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // Next provides this at build time; tests run outside Next.
      "server-only": path.resolve(import.meta.dirname, "src/test/empty.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: TEST_DB,
      DIRECT_URL: TEST_DB,
      STORAGE_DRIVER: "local",
      AI_ENABLED: "true",
    },
    // Tests share one Postgres database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
