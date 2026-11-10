import { db } from "@/lib/db";

/** Wipes every table so each test starts from a known state. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    `TRUNCATE "StatusEvent", "Application", "Resume", "AuthToken", "Session", "RateLimit", "User" RESTART IDENTITY CASCADE`,
  );
}

let n = 0;
export async function makeUser(overrides: { email?: string; name?: string | null; verified?: boolean } = {}) {
  n++;
  return db.user.create({
    data: {
      email: overrides.email ?? `user${n}-${Date.now()}@example.com`,
      name: overrides.name === undefined ? `User ${n}` : overrides.name,
      passwordHash: "not-a-real-hash",
      emailVerifiedAt: overrides.verified ? new Date() : null,
    },
  });
}
