import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { resetDb } from "@/test/db";

const requireUser = vi.fn();
vi.mock("@/lib/auth", () => ({ requireUser: () => requireUser() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { hasAdminRole, isAdmin, requireAdmin } from "@/lib/admin";
import { ADMIN_PAGE_SIZE, APPS_PER_USER, getAdminOverview, getAdminUsers } from "@/lib/admin-data";

// Neon Auth owns these tables in a real database. Recreate the columns we read
// in the (throwaway) test database.
beforeAll(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS neon_auth CASCADE`);
  await db.$executeRawUnsafe(`CREATE SCHEMA neon_auth`);
  await db.$executeRawUnsafe(`
    CREATE TABLE neon_auth."user" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" text NOT NULL DEFAULT '',
      "email" text NOT NULL UNIQUE,
      "emailVerified" boolean NOT NULL DEFAULT false,
      "image" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "role" text,
      "banned" boolean,
      "banReason" text,
      "banExpires" timestamptz
    )`);
  await db.$executeRawUnsafe(`
    CREATE TABLE neon_auth.session (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "expiresAt" timestamptz NOT NULL DEFAULT now() + interval '7 days',
      "token" text NOT NULL DEFAULT gen_random_uuid()::text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      "userId" uuid NOT NULL REFERENCES neon_auth."user"("id") ON DELETE CASCADE
    )`);
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS neon_auth CASCADE`);
});

beforeEach(async () => {
  requireUser.mockReset();
  await resetDb();
  await db.$executeRawUnsafe(`TRUNCATE neon_auth."user" CASCADE`);
});

async function authUser(
  o: {
    email?: string;
    name?: string;
    role?: string | null;
    banned?: boolean;
    banExpires?: Date | null;
    verified?: boolean;
    createdAt?: Date;
  } = {},
) {
  const id = randomUUID();
  await db.$executeRaw`
    INSERT INTO neon_auth."user" ("id", "name", "email", "emailVerified", "role", "banned", "banExpires", "createdAt")
    VALUES (${id}::uuid, ${o.name ?? ""}, ${o.email ?? `${id}@example.com`}, ${o.verified ?? true},
            ${o.role ?? null}, ${o.banned ?? null}, ${o.banExpires ?? null}, ${o.createdAt ?? new Date()})`;
  await db.user.create({ data: { id } });
  return id;
}

const addApp = (userId: string, status = "APPLIED", extra: { company?: string; updatedAt?: Date } = {}) =>
  db.application.create({
    data: { userId, company: extra.company ?? "Acme", jobTitle: "Engineer", status, updatedAt: extra.updatedAt },
  });

describe("hasAdminRole", () => {
  it("accepts admin alone or in a comma-separated list, any case", () => {
    expect(hasAdminRole("admin")).toBe(true);
    expect(hasAdminRole("user, Admin")).toBe(true);
  });
  it("rejects everything else", () => {
    expect(hasAdminRole(null)).toBe(false);
    expect(hasAdminRole("")).toBe(false);
    expect(hasAdminRole("user")).toBe(false);
    expect(hasAdminRole("superadmin")).toBe(false);
    expect(hasAdminRole("administrator")).toBe(false);
  });
});

describe("isAdmin / requireAdmin", () => {
  it("is true only for an unbanned admin", async () => {
    const admin = await authUser({ role: "admin" });
    const plain = await authUser({ role: "user" });
    const noRole = await authUser({ role: null });
    const banned = await authUser({ role: "admin", banned: true });
    const expiredBan = await authUser({ role: "admin", banned: true, banExpires: new Date(Date.now() - 1000) });

    expect(await isAdmin(admin)).toBe(true);
    expect(await isAdmin(plain)).toBe(false);
    expect(await isAdmin(noRole)).toBe(false);
    expect(await isAdmin(banned)).toBe(false);
    expect(await isAdmin(expiredBan)).toBe(true);
  });

  it("is false for unknown or malformed ids instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await isAdmin(randomUUID())).toBe(false);
    expect(await isAdmin("not-a-uuid")).toBe(false);
  });

  it("fails closed when the neon_auth tables are unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await authUser({ role: "admin" });
    await db.$executeRawUnsafe(`ALTER TABLE neon_auth."user" RENAME TO user_gone`);
    try {
      expect(await isAdmin(id)).toBe(false);
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE neon_auth.user_gone RENAME TO "user"`);
    }
  });

  it("requireAdmin returns the user for admins and 404s everyone else", async () => {
    const admin = await authUser({ role: "admin" });
    const plain = await authUser({ role: "user" });

    requireUser.mockResolvedValue({ id: admin, email: "a@example.com" });
    await expect(requireAdmin()).resolves.toMatchObject({ id: admin });

    requireUser.mockResolvedValue({ id: plain, email: "p@example.com" });
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("propagates the sign-in redirect for signed-out visitors", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT");
  });

  it("sees a role change on the very next check", async () => {
    const id = await authUser({ role: "admin" });
    expect(await isAdmin(id)).toBe(true);
    await db.$executeRaw`UPDATE neon_auth."user" SET "role" = 'user' WHERE "id" = ${id}::uuid`;
    expect(await isAdmin(id)).toBe(false);
  });
});

describe("getAdminOverview", () => {
  it("is all zeros with no data", async () => {
    const o = await getAdminOverview();
    expect(o.users).toEqual({ total: 0, verified: 0, admins: 0, new7d: 0, new30d: 0, active30d: 0 });
    expect(o.applications.total).toBe(0);
    expect(o.applications.avgPerActiveUser).toBeNull();
  });

  it("counts users, admins, signups, activity and application statuses", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const day = 86_400_000;
    const a = await authUser({ role: "admin", createdAt: new Date(now.getTime() - 2 * day) });
    const b = await authUser({ role: "user, admin", verified: false, createdAt: new Date(now.getTime() - 20 * day) });
    const c = await authUser({ createdAt: new Date(now.getTime() - 100 * day) });
    await authUser({ role: "administrator", createdAt: new Date(now.getTime() - 100 * day) });

    await addApp(a, "APPLIED", { updatedAt: new Date(now.getTime() - day) });
    await addApp(a, "OFFER", { updatedAt: new Date(now.getTime() - day) });
    await addApp(c, "REJECTED", { updatedAt: new Date(now.getTime() - 90 * day) });
    // b has a recent session only
    await db.$executeRaw`INSERT INTO neon_auth.session ("userId", "updatedAt") VALUES (${b}::uuid, ${new Date(now.getTime() - 3 * day)})`;
    await db.resume.create({
      data: { userId: a, label: "r", fileName: "r.pdf", mimeType: "application/pdf", size: 1, storageKey: "k1" },
    });

    const o = await getAdminOverview(now);
    expect(o.users).toEqual({ total: 4, verified: 3, admins: 2, new7d: 1, new30d: 2, active30d: 2 });
    expect(o.applications.total).toBe(3);
    expect(o.applications.byStatus).toMatchObject({ APPLIED: 1, OFFER: 1, REJECTED: 1, WISHLIST: 0 });
    expect(o.applications.usersWithApplications).toBe(2);
    expect(o.applications.avgPerActiveUser).toBe(1.5);
    expect(o.resumes).toBe(1);
  });
});

describe("getAdminUsers", () => {
  it("lists newest signups first with applications, status mix and last activity", async () => {
    const now = new Date("2026-06-30T12:00:00Z");
    const old = await authUser({ email: "old@example.com", name: "Old", createdAt: new Date("2026-01-01T00:00:00Z") });
    const fresh = await authUser({ email: "new@example.com", role: "admin", createdAt: new Date("2026-06-01T00:00:00Z") });
    await addApp(old, "APPLIED", { company: "A", updatedAt: new Date("2026-02-01T00:00:00Z") });
    await addApp(old, "INTERVIEWING", { company: "B", updatedAt: new Date("2026-03-01T00:00:00Z") });
    await db.$executeRaw`INSERT INTO neon_auth.session ("userId", "updatedAt") VALUES (${old}::uuid, ${new Date("2026-05-01T00:00:00Z")})`;

    const page = await getAdminUsers({}, now);
    expect(page.total).toBe(2);
    expect(page.users.map((u) => u.id)).toEqual([fresh, old]);

    const [f, o] = page.users;
    expect(f).toMatchObject({ isAdmin: true, applicationCount: 0, lastActiveAt: null, name: null });
    expect(o).toMatchObject({ name: "Old", email: "old@example.com", isAdmin: false, applicationCount: 2 });
    expect(o.byStatus).toMatchObject({ APPLIED: 1, INTERVIEWING: 1 });
    expect(o.applications.map((a) => a.company)).toEqual(["B", "A"]); // newest update first
    expect(o.lastActiveAt).toEqual(new Date("2026-05-01T00:00:00Z")); // the session is newer than any edit
  });

  it("does not expose notes, cover letters or contact details", async () => {
    const id = await authUser();
    await db.application.create({
      data: { userId: id, company: "X", jobTitle: "Y", notes: "secret", coverLetter: "secret", contactEmail: "s@e.com" },
    });
    const { users } = await getAdminUsers();
    expect(JSON.stringify(users)).not.toContain("secret");
    expect(JSON.stringify(users)).not.toContain("s@e.com");
  });

  it("searches by name or email and treats % and _ literally", async () => {
    await authUser({ email: "ada@example.com", name: "Ada Lovelace" });
    await authUser({ email: "bob@example.com", name: "Bob 100%" });
    await authUser({ email: "carol@example.com", name: "Carol" });

    expect((await getAdminUsers({ q: "lovelace" })).users.map((u) => u.email)).toEqual(["ada@example.com"]);
    expect((await getAdminUsers({ q: "BOB@" })).total).toBe(1);
    expect((await getAdminUsers({ q: "100%" })).total).toBe(1);
    expect((await getAdminUsers({ q: "%" })).total).toBe(1);
    expect((await getAdminUsers({ q: "_" })).total).toBe(0);
    expect((await getAdminUsers({ q: "nobody" })).users).toEqual([]);
  });

  it("paginates and clamps out-of-range pages", async () => {
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < ADMIN_PAGE_SIZE + 3; i++) {
      await authUser({ createdAt: new Date(base + i * 1000) });
    }
    const p1 = await getAdminUsers({ page: 1 });
    const p2 = await getAdminUsers({ page: 2 });
    expect(p1).toMatchObject({ total: ADMIN_PAGE_SIZE + 3, pageCount: 2, page: 1 });
    expect(p1.users).toHaveLength(ADMIN_PAGE_SIZE);
    expect(p2.users).toHaveLength(3);
    expect((await getAdminUsers({ page: 99 })).page).toBe(2);
    expect((await getAdminUsers({ page: -4 })).page).toBe(1);
    expect((await getAdminUsers({ page: Number.NaN })).page).toBe(1);
  });

  it("caps the applications listed per user but still counts them all", async () => {
    const id = await authUser();
    await db.application.createMany({
      data: Array.from({ length: APPS_PER_USER + 5 }, (_, i) => ({ userId: id, company: `C${i}`, jobTitle: "T" })),
    });
    const { users } = await getAdminUsers();
    expect(users[0].applicationCount).toBe(APPS_PER_USER + 5);
    expect(users[0].applications).toHaveLength(APPS_PER_USER);
  });

  it("shows signed-up users who never opened the app (no app-side row)", async () => {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO neon_auth."user" ("id", "email") VALUES (${id}::uuid, 'ghost@example.com')`;
    const { users } = await getAdminUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email: "ghost@example.com", emailVerified: false, applicationCount: 0 });
  });
});
