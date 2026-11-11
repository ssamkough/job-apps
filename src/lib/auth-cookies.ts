import "server-only";
import { cookies } from "next/headers";

/** Every cookie the Neon Auth SDK sets starts with this (`session_token`, `local.session_data`). */
export const AUTH_COOKIE_PREFIX = "__Secure-neon-auth";

export async function hasAuthCookie() {
  return (await cookies()).getAll().some((c) => c.name.startsWith(AUTH_COOKIE_PREFIX));
}

/**
 * Removes every Neon Auth cookie from this browser, even when Neon Auth itself
 * can't be reached, so signing out always works locally.
 *
 * `cookies().delete()` is deliberately not used: it writes a Set-Cookie without
 * the `Secure` attribute, which browsers refuse for `__Secure-` cookies (so the
 * cookie would survive), and it would also replace the correct deletion the SDK
 * has just queued. An expired cookie with the same attributes the SDK sets is
 * what actually removes them.
 */
export async function clearAuthCookies() {
  const jar = await cookies();
  for (const { name } of jar.getAll()) {
    if (name.startsWith(AUTH_COOKIE_PREFIX)) {
      jar.set(name, "", {
        maxAge: 0,
        expires: new Date(0),
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      });
    }
  }
}
