import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { db } from "@/lib/db";

/**
 * Fixed-window rate limiting backed by the existing Postgres database, so
 * there's no Redis to run or pay for. One row per (key, window); an atomic
 * upsert increments it, so concurrent requests can't slip past the limit.
 *
 * Trade-off of fixed windows: a client can burst up to 2x the limit across a
 * window boundary. That's fine for abuse protection.
 */
export type Rule = { limit: number; windowSec: number };

export const RULES = {
  loginIp: { limit: 20, windowSec: 15 * 60 },
  // Only failed attempts count toward this one.
  loginEmailFailures: { limit: 10, windowSec: 15 * 60 },
  signupIp: { limit: 5, windowSec: 60 * 60 },
  // Every email we ask Neon Auth to send (signup, resend code, forgot password)
  // counts here, so our forms can't be used to flood someone's inbox.
  otpSendIp: { limit: 15, windowSec: 60 * 60 },
  otpSendEmail: { limit: 4, windowSec: 60 * 60 },
  // Guessing a code: Neon Auth also caps attempts per code.
  otpSubmitIp: { limit: 20, windowSec: 15 * 60 },
  otpSubmitEmail: { limit: 10, windowSec: 15 * 60 },
  // Guessing the current password from inside a logged-in session.
  passwordCheckUser: { limit: 10, windowSec: 15 * 60 },
  aiUser: { limit: 15, windowSec: 60 * 60 },
} as const satisfies Record<string, Rule>;

export type HitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

const windowStart = (windowSec: number, now = Date.now()) => {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now / ms) * ms);
};

const retryAfter = (windowSec: number, now = Date.now()) => {
  const ms = windowSec * 1000;
  return Math.max(1, Math.ceil((Math.floor(now / ms) * ms + ms - now) / 1000));
};

/** Counts one event against `key` and says whether it was within the limit. */
export async function hit(key: string, rule: Rule): Promise<HitResult> {
  const start = windowStart(rule.windowSec);
  // "windowStart" is a timestamp *without* time zone that Prisma reads as UTC.
  // Raw SQL would otherwise convert using the database server's time zone, so
  // be explicit.
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count")
    VALUES (${key}, (${start}::timestamptz AT TIME ZONE 'UTC'), 1)
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  const count = Number(rows[0].count);

  // Housekeeping: occasionally drop windows that are long over.
  if (Math.random() < 0.02) void prune();

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSec: retryAfter(rule.windowSec),
  };
}

/** Current count for `key` in the active window, without counting an event. */
export async function peek(key: string, rule: Rule): Promise<HitResult> {
  const row = await db.rateLimit.findUnique({
    where: { key_windowStart: { key, windowStart: windowStart(rule.windowSec) } },
  });
  const count = row?.count ?? 0;
  return {
    allowed: count < rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSec: retryAfter(rule.windowSec),
  };
}

/** Forget a key entirely (e.g. failed-login counter after a successful login). */
export async function clear(key: string) {
  await db.rateLimit.deleteMany({ where: { key } });
}

export async function prune(olderThanMs = 2 * 24 * 60 * 60 * 1000) {
  await db.rateLimit
    .deleteMany({ where: { windowStart: { lt: new Date(Date.now() - olderThanMs) } } })
    .catch(() => {});
}

/** Stable key for an email without storing the address in this table. */
export const emailKey = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);

export function ipFromHeaders(h: Pick<Headers, "get">): string {
  // Which header carries the real client IP depends on what's in front of the
  // app: Vercel sets x-forwarded-for; Cloudflare Tunnel sets cf-connecting-ip.
  // Only trust a header your proxy overwrites, or clients can spoof it.
  const name = (process.env.CLIENT_IP_HEADER || "x-forwarded-for").toLowerCase();
  const raw = h.get(name);
  if (!raw) return "unknown";
  return raw.split(",")[0].trim() || "unknown";
}

export async function clientIp() {
  return ipFromHeaders(await headers());
}

export const retryMessage = (r: HitResult) => {
  const mins = Math.ceil(r.retryAfterSec / 60);
  return mins <= 1
    ? "Too many attempts. Try again in a minute."
    : `Too many attempts. Try again in about ${mins} minutes.`;
};
