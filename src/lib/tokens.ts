import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";

export type TokenType = "PASSWORD_RESET" | "EMAIL_VERIFY";

const TTL_MS: Record<TokenType, number> = {
  PASSWORD_RESET: 60 * 60 * 1000, // 1 hour
  EMAIL_VERIFY: 24 * 60 * 60 * 1000, // 24 hours
};

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

/**
 * Issues a one-time token and returns the raw value (for the emailed link).
 * Only its hash is stored, and any earlier unused token of the same type for
 * this user is invalidated so only the newest link works.
 */
export async function createToken(userId: string, type: TokenType) {
  const raw = randomBytes(32).toString("base64url");
  await db.$transaction([
    db.authToken.deleteMany({ where: { userId, type, usedAt: null } }),
    db.authToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + TTL_MS[type]),
      },
    }),
  ]);
  return raw;
}

/** Is this token currently usable? Doesn't consume it. */
export async function peekToken(raw: string, type: TokenType) {
  if (!raw) return false;
  const t = await db.authToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  return !!t && t.type === type && !t.usedAt && t.expiresAt.getTime() > Date.now();
}

/**
 * Atomically uses up a token and returns its user id, or null if it's
 * invalid, expired, the wrong type, or already used. The conditional update
 * means two simultaneous requests can't both succeed.
 */
export async function consumeToken(raw: string, type: TokenType) {
  if (!raw) return null;
  const token = await db.authToken.findUnique({ where: { tokenHash: hashToken(raw) } });
  if (!token || token.type !== type) return null;

  const { count } = await db.authToken.updateMany({
    where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return count === 1 ? token.userId : null;
}
