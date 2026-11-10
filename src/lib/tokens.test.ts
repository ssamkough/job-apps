import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { consumeToken, createToken, peekToken } from "@/lib/tokens";
import { makeUser, resetDb } from "@/test/db";

beforeEach(resetDb);

describe("tokens", () => {
  it("stores only a hash, never the raw token", async () => {
    const u = await makeUser();
    const raw = await createToken(u.id, "PASSWORD_RESET");
    const row = await db.authToken.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.tokenHash).not.toContain(raw);
    expect(raw.length).toBeGreaterThanOrEqual(40);
  });

  it("is single-use", async () => {
    const u = await makeUser();
    const raw = await createToken(u.id, "PASSWORD_RESET");
    expect(await peekToken(raw, "PASSWORD_RESET")).toBe(true);
    expect(await consumeToken(raw, "PASSWORD_RESET")).toBe(u.id);
    expect(await consumeToken(raw, "PASSWORD_RESET")).toBeNull();
    expect(await peekToken(raw, "PASSWORD_RESET")).toBe(false);
  });

  it("only one of several simultaneous attempts wins", async () => {
    const u = await makeUser();
    const raw = await createToken(u.id, "PASSWORD_RESET");
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeToken(raw, "PASSWORD_RESET")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("can't be used for a different purpose", async () => {
    const u = await makeUser();
    const raw = await createToken(u.id, "EMAIL_VERIFY");
    expect(await consumeToken(raw, "PASSWORD_RESET")).toBeNull();
    expect(await peekToken(raw, "PASSWORD_RESET")).toBe(false);
    expect(await consumeToken(raw, "EMAIL_VERIFY")).toBe(u.id);
  });

  it("expires", async () => {
    const u = await makeUser();
    const raw = await createToken(u.id, "PASSWORD_RESET");
    await db.authToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await peekToken(raw, "PASSWORD_RESET")).toBe(false);
    expect(await consumeToken(raw, "PASSWORD_RESET")).toBeNull();
  });

  it("a newer token invalidates the older one", async () => {
    const u = await makeUser();
    const first = await createToken(u.id, "PASSWORD_RESET");
    const second = await createToken(u.id, "PASSWORD_RESET");
    expect(await consumeToken(first, "PASSWORD_RESET")).toBeNull();
    expect(await consumeToken(second, "PASSWORD_RESET")).toBe(u.id);
  });

  it("issuing a reset token doesn't disturb the verify token", async () => {
    const u = await makeUser();
    const verify = await createToken(u.id, "EMAIL_VERIFY");
    await createToken(u.id, "PASSWORD_RESET");
    expect(await consumeToken(verify, "EMAIL_VERIFY")).toBe(u.id);
  });

  it("rejects garbage and empty input", async () => {
    expect(await consumeToken("nonsense", "PASSWORD_RESET")).toBeNull();
    expect(await consumeToken("", "PASSWORD_RESET")).toBeNull();
    expect(await peekToken("", "PASSWORD_RESET")).toBe(false);
  });

  it("are removed when the user is deleted", async () => {
    const u = await makeUser();
    await createToken(u.id, "PASSWORD_RESET");
    await db.user.delete({ where: { id: u.id } });
    expect(await db.authToken.count()).toBe(0);
  });
});
