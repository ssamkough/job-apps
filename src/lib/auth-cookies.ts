import "server-only";
import { cookies, headers } from "next/headers";

/** Every cookie the Neon Auth SDK sets starts with this (`session_token`, `local.session_data`). */
export const AUTH_COOKIE_PREFIX = "__Secure-neon-auth";

export const SESSION_TOKEN_COOKIE = `${AUTH_COOKIE_PREFIX}.session_token`;

export async function hasAuthCookie() {
  return (await cookies()).getAll().some((c) => c.name.startsWith(AUTH_COOKIE_PREFIX));
}

/**
 * The browser's session-token cookie exactly as sent (`name=value`, still
 * encoded), or null. Read from the raw header because `cookies()` hands back
 * decoded values that can't be forwarded as they are.
 */
export async function sessionTokenCookieHeader(): Promise<string | null> {
  const raw = (await headers()).get("cookie") ?? "";
  const part = raw.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_TOKEN_COOKIE}=`));
  return part ?? null;
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
