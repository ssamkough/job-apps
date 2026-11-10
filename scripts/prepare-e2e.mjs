// Brings the e2e database to a migrated, empty state. Refuses to run against
// anything not named *_e2e so it can never touch real data.
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/\/[^/?]*_e2e(\?|$)/.test(url)) {
  console.error(`Refusing to touch "${url}": database name must end in _e2e`);
  process.exit(1);
}

execSync("npx prisma migrate deploy", { stdio: "inherit", env: process.env });

const db = new PrismaClient();
try {
  await db.$executeRawUnsafe(
    `TRUNCATE "StatusEvent", "Application", "Resume", "AuthToken", "Session", "RateLimit", "User" RESTART IDENTITY CASCADE`,
  );
} finally {
  await db.$disconnect();
}
rmSync("./data/e2e-uploads", { recursive: true, force: true });
