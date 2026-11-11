import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * Read-only window onto the deployment's database for the live journey. It
 * never writes, and it never puts the URL, a code or a password into a message.
 *
 * Why the database: Neon Auth emails the verification code and offers no API to
 * read it. It stores it in `neon_auth.verification` (same database as the app):
 *   identifier = "<type>-otp-<lowercased email>"   type: email-verification | forget-password
 *   value      = "<code stored as base64url(SHA-256(code))>:<wrong attempts so far>"
 *   expiresAt  = createdAt + 300 s
 * (recorded against a real Neon branch, Nov 2026). A 6-digit code has only a
 * million possibilities, so the stored hash is inverted by hashing them all
 * (about a second). If Neon ever stores the code in plain text the value is
 * "123456:0" and is used as is.
 */
export type OtpType = "email-verification" | "forget-password";

export type OtpRow = { code: string; attempts: number; ttlSeconds: number };

export class LiveDb {
  private client: PrismaClient;
  constructor(url: string) {
    this.client = new PrismaClient({ datasources: { db: { url } }, log: [] });
  }

  private async query<T>(what: string, sql: string, ...args: unknown[]): Promise<T[]> {
    try {
      return await this.client.$queryRawUnsafe<T[]>(sql, ...args);
    } catch (e) {
      // Prisma's own text can name the host; say only what we were doing.
      throw new Error(`LIVE_DATABASE_URL: could not ${what} (${e instanceof Error ? e.name : "error"}). Check the URL is the deployment's DIRECT url.`);
    }
  }

  /** The Neon Auth identity for an address, if any. */
  async identity(email: string) {
    const rows = await this.query<{ id: string; emailVerified: boolean; createdAt: Date }>(
      "look up the Neon Auth user",
      `select id::text as id, "emailVerified", "createdAt" from neon_auth."user" where lower(email) = $1`,
      email.toLowerCase(),
    );
    return rows[0] ?? null;
  }

  /** What Neon Auth still holds for a user id. */
  async retained(userId: string) {
    const [r] = await this.query<{ accounts: number; sessions: number }>(
      "count what Neon Auth retains",
      `select (select count(*)::int from neon_auth.account where "userId" = $1::uuid) as accounts,
              (select count(*)::int from neon_auth.session where "userId" = $1::uuid) as sessions`,
      userId,
    );
    return r;
  }

  /** Rows the APP keeps for a user id (`public."User"` is the slim row; the rest cascade from it). */
  async appRows(userId: string) {
    const [r] = await this.query<{ users: number; applications: number; resumes: number }>(
      "count the app's rows",
      `select (select count(*)::int from public."User" where id = $1) as users,
              (select count(*)::int from public."Application" where "userId" = $1) as applications,
              (select count(*)::int from public."Resume" where "userId" = $1) as resumes`,
      userId,
    );
    return r;
  }

  /** The newest code for an address, or null when none has been issued. */
  async otp(email: string, type: OtpType): Promise<OtpRow | null> {
    const rows = await this.query<{ value: string; expiresAt: Date; createdAt: Date }>(
      "read the verification code",
      `select value, "expiresAt", "createdAt" from neon_auth.verification where identifier = $1 order by "createdAt" desc limit 1`,
      `${type}-otp-${email.toLowerCase()}`,
    );
    if (!rows.length) return null;
    const [stored, attempts] = rows[0].value.split(":");
    const ttlSeconds = Math.round((rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()) / 1000);
    if (/^\d{6}$/.test(stored)) return { code: stored, attempts: Number(attempts), ttlSeconds };
    for (let n = 0; n < 1_000_000; n++) {
      const code = String(n).padStart(6, "0");
      if (createHash("sha256").update(code).digest("base64url") === stored) {
        return { code, attempts: Number(attempts), ttlSeconds };
      }
    }
    throw new Error("The stored verification code is in a format this test doesn't know (not plain, not SHA-256).");
  }

  /** Waits for the code to appear (Neon Auth writes it before it answers, but be tolerant). */
  async waitForOtp(email: string, type: OtpType, timeoutMs = 20_000): Promise<OtpRow> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const row = await this.otp(email, type);
      if (row) return row;
      if (Date.now() > until) throw new Error(`No ${type} code was issued for the test address within ${timeoutMs / 1000}s.`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  close() {
    return this.client.$disconnect();
  }
}
