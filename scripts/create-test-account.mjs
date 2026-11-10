// Creates (or resets) the local dev account described in .test-account.local.
// Dev only: refuses to run when NODE_ENV=production.
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to create a test account in production.");
  process.exit(1);
}
const text = readFileSync(".test-account.local", "utf8");
const field = (name) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim();
const email = field("Email")?.toLowerCase();
const password = field("Password");
const name = field("Name") ?? null;
if (!email || !password) throw new Error(".test-account.local needs Email: and Password: lines");

const db = new PrismaClient();
try {
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await db.user.upsert({
    where: { email },
    update: { passwordHash, name, emailVerifiedAt: new Date() },
    create: { email, passwordHash, name, emailVerifiedAt: new Date() },
  });
  console.log(`Test account ready: ${user.email} (verified)`);
} finally {
  await db.$disconnect();
}
