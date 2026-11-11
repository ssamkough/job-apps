import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authApi, type AuthError } from "@/lib/auth-api";

/**
 * Who is signed in, on top of Neon Auth.
 *
 * Neon Auth owns credentials, email, names and sessions. We keep a slim `User`
 * row (id only) so applications and resumes have something to belong to; it is
 * created the first time a verified user makes an authenticated request.
 */

export type CurrentUser = {
  /** Neon Auth user id (uuid). Also `User.id` in our database. */
  id: string;
  email: string;
  /** Null when the user didn't give a name. */
  name: string | null;
  emailVerified: boolean;
};

/** A provider outage must not look like "signed out": surface it as a 500. */
class AuthUnavailableError extends Error {
  constructor(public readonly cause: AuthError) {
    super(`Neon Auth is unavailable (${cause.code})`);
  }
}

async function ensureAppUser(id: string) {
  const exists = await db.user.findUnique({ where: { id }, select: { id: true } });
  if (exists) return;
  try {
    await db.user.create({ data: { id } });
  } catch (e) {
    // Two requests from a brand-new user raced; the other one won.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
}

async function loadUser(fresh: boolean): Promise<CurrentUser | null> {
  const { data, error } = await authApi().getSession({ fresh });
  if (error) {
    if (error.code === "UNAVAILABLE") throw new AuthUnavailableError(error);
    return null;
  }
  if (!data) return null;

  const u = data.user;
  // Only verified users get app data: an address nobody has proven they own
  // must not be able to start filling an account, and account recovery relies
  // on the email. (Neon Auth is also configured to refuse unverified sign-ins;
  // this keeps the rule even if that setting is ever turned off.)
  if (u.emailVerified) await ensureAppUser(u.id);
  return { id: u.id, email: u.email, name: u.name || null, emailVerified: u.emailVerified };
}

/**
 * The signed-in user, or null. Memoized per request. May come from the SDK's
 * short-lived signed cookie cache, so a session revoked on another device can
 * still pass for up to SESSION_CACHE_SECONDS; use `requireFreshUser` for
 * sensitive actions.
 */
export const getCurrentUser = cache(() => loadUser(false));

const verifyUrl = (email: string) => `/verify-email?email=${encodeURIComponent(email)}`;

/** Use in pages and actions that need a signed-in, verified user. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!user.emailVerified) redirect(verifyUrl(user.email));
  return user;
}

/** Like `requireUser` but asks Neon Auth instead of trusting the cached session. */
export async function requireFreshUser(): Promise<CurrentUser> {
  const user = await loadUser(true);
  if (!user) redirect("/login");
  if (!user.emailVerified) redirect(verifyUrl(user.email));
  return user;
}
