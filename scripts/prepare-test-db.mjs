// Applies migrations to the *test* database (never the dev one) before tests.
import { execFileSync } from "node:child_process";

const url =
  process.env.TEST_DATABASE_URL ??
  "postgresql://jobapps:jobapps@localhost:5432/jobapps_test";

if (!/test/i.test(new URL(url).pathname)) {
  console.error(`Refusing to run tests against "${url}": database name must contain "test".`);
  process.exit(1);
}

execFileSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
});
