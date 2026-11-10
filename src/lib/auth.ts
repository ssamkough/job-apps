import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;
const BCRYPT_ROUNDS = 12;

// Compared against when the email doesn't exist so login timing doesn't reveal
// which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS);

export const hashPassword = (password: string) =>
  bcrypt.hash(password, BCRYPT_ROUNDS);

export async function verifyPassword(password: string, hash: string | null) {
  return bcrypt.compare(password, hash ?? DUMMY_HASH).then((ok) => ok && !!hash);
}

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await db.session.create({
    data: { tokenHash: hashToken(token), userId, expiresAt },
  });

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.session
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Signs a user out of every device. With `keepCurrent`, the session making the
 * request survives (used after changing a password).
 */
export async function deleteUserSessions(
  userId: string,
  { keepCurrent = false }: { keepCurrent?: boolean } = {},
) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await db.session.deleteMany({
    where: {
      userId,
      ...(keepCurrent && token ? { tokenHash: { not: hashToken(token) } } : {}),
    },
  });
}

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
};

/** Returns the signed-in user, or null. Memoized per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: { id: true, email: true, name: true, emailVerifiedAt: true },
      },
    },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() < Date.now()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session.user;
});

/** Use in pages, actions, and route handlers that need a signed-in user. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
