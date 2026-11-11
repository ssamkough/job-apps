import "server-only";
import { createNeonAuth } from "@neon/auth/next/server";

/**
 * The Neon Auth (managed Better Auth) server SDK, created on first use so that
 * `next build` and tests don't need the secrets at import time.
 *
 * Only `src/lib/auth-api.ts` should import this: everything else talks to the
 * small `AuthApi` interface, which tests replace with an in-memory fake.
 *
 * Docs: https://neon.com/docs/auth/reference/nextjs-server.md
 */

/**
 * How long the SDK may trust its signed `session_data` cookie before asking
 * Neon Auth again (the SDK default is 300 s). It bounds how long a session that
 * was revoked on another device can still pass a *cached* check. Sensitive
 * actions skip the cache entirely (see `fresh` in auth-api.ts). Verified by
 * reading the SDK source: the cache is the only place a revoked session can
 * linger, because Neon Auth itself reads the database on every session check.
 */
export const SESSION_CACHE_SECONDS = 60;

/** Neon Auth's base URL (`…/neondb/auth`); throws when it isn't configured. */
export function neonAuthBaseUrl(): string {
  const baseUrl = process.env.NEON_AUTH_BASE_URL;
  if (!baseUrl) throw new Error("NEON_AUTH_BASE_URL must be set");
  return baseUrl.replace(/\/+$/, "");
}

type NeonAuth = ReturnType<typeof createNeonAuth>;
let instance: NeonAuth | undefined;

export function getNeonAuth(): NeonAuth {
  if (!instance) {
    const baseUrl = process.env.NEON_AUTH_BASE_URL;
    const secret = process.env.NEON_AUTH_COOKIE_SECRET;
    if (!baseUrl || !secret) {
      throw new Error("NEON_AUTH_BASE_URL and NEON_AUTH_COOKIE_SECRET must be set");
    }
    instance = createNeonAuth({
      baseUrl,
      // The SDK's own logs carry request paths and statuses; "warn" keeps the
      // per-request info/debug chatter (and anything incidental) out of the logs.
      logLevel: "warn",
      cookies: {
        secret,
        sessionDataTtl: SESSION_CACHE_SECONDS,
        // The SDK's documented default is "strict", which drops the session
        // cookie on any cross-site navigation (a link clicked in an email or
        // chat would land signed out). "lax" still blocks cross-site POSTs.
        sameSite: "lax",
      },
    });
  }
  return instance;
}
