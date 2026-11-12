import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

/** Wipes every table so each test starts from a known state. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    `TRUNCATE "StatusEvent", "Application", "Resume", "ImportJob", "ApplicationQuestion", "Answer", "Question", "RateLimit", "User" RESTART IDENTITY CASCADE`,
  );
}

/** An app-side user row. Its id is what Neon Auth's user id would be. */
export async function makeAppUser(id: string = randomUUID()) {
  return db.user.create({ data: { id } });
}
