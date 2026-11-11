import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAuth } from "@/test/fake-auth";

// ---- Stand-ins for Next's request context and for Neon Auth ----------------
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  ip: "1.1.1.1",
  afterTasks: [] as Promise<unknown>[],
  fake: undefined as unknown as FakeAuth,
}));

class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (n: string, v: string, o?: { maxAge?: number; secure?: boolean }) => {
      // Like a browser: a "__Secure-" cookie can only be set or removed with Secure.
      if (n.startsWith("__Secure-") && !o?.secure) throw new Error(`browser would reject ${n}: missing Secure`);
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => {
      // cookies().delete() omits Secure, so it can't remove "__Secure-" cookies.
      if (n.startsWith("__Secure-")) throw new Error(`delete() can't remove ${n}; set it expired with Secure`);
      h.jar.delete(n);
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": h.ip }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => void h.afterTasks.push(Promise.resolve().then(fn)),
}));
// React's `cache` only exists in the server build of React.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("@/lib/auth-api", () => ({ authApi: () => h.fake }));

import { db } from "@/lib/db";
import { getCurrentUser, requireFreshUser, requireUser } from "@/lib/auth";
import { resetStorageDriver, readResumeFile, saveResumeFile } from "@/lib/storage";
import * as storage from "@/lib/storage";
import {
  login,
  logout,
  requestPasswordReset,
  resendVerificationCode,
  resetPassword,
  signup,
  verifyEmail,
} from "@/app/actions/auth";
import {
  changePassword,
  deleteAccount,
  signOutEverywhere,
} from "@/app/actions/account";
import { makePdf } from "@/test/files";
import { resetDb } from "@/test/db";
import { FakeAuth as FakeAuthImpl, SESSION_COOKIE } from "@/test/fake-auth";

const PASSWORD = "correct horse battery";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

/** Runs an action, returning its result or the URL it redirected to. */
async function run<T>(fn: () => Promise<T>): Promise<T | { redirect: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.url };
    throw e;
  }
}
const flush = async () => {
  await Promise.all(h.afterTasks.splice(0));
};
const verifyUrl = (email: string) => `/verify-email?email=${encodeURIComponent(email)}`;

let uploadDir: string;
beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(os.tmpdir(), "auth-actions-"));
  process.env.UPLOAD_DIR = uploadDir;
  resetStorageDriver();
});
afterAll(async () => {
  delete process.env.UPLOAD_DIR;
  resetStorageDriver();
  await rm(uploadDir, { recursive: true, force: true });
});
beforeEach(async () => {
  // Rate-limit windows are wall-clock aligned: pin the clock mid-window so a
  // run can't straddle a boundary. Only Date is faked.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:07:30Z"));
  await resetDb();
  h.jar.clear();
  h.ip = "1.1.1.1";
  h.afterTasks.length = 0;
  h.fake = new FakeAuthImpl(h.jar);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signup", () => {
  it("creates an unverified identity, emails a code, and starts no session", async () => {
    const res = await run(() =>
      signup({}, form({ name: "Sam", email: "Sam@Example.com", password: PASSWORD })),
    );
    expect(res).toEqual({ redirect: verifyUrl("sam@example.com") });

    expect(h.fake.outbox).toEqual([
      expect.objectContaining({ to: "sam@example.com", type: "email-verification" }),
    ]);
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
    // Nothing of ours exists until the address is verified.
    expect(await db.user.count()).toBe(0);
  });

  it("answers the same for an address that already has an account, and sends nothing", async () => {
    h.fake.seedUser({ email: "dup@example.com", verified: true });
    const res = await run(() => signup({}, form({ email: "dup@example.com", password: PASSWORD })));
    expect(res).toEqual({ redirect: verifyUrl("dup@example.com") });
    expect(h.fake.outbox).toHaveLength(0);
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("doesn't echo the password back after an error", async () => {
    const res = await signup({}, form({ email: "bad", password: "x" }));
    expect(res.errors).toBeTruthy();
    expect(res.values).not.toHaveProperty("password");
  });

  it("limits signups per IP", async () => {
    for (let i = 0; i < 5; i++) {
      await run(() => signup({}, form({ email: `n${i}@example.com`, password: PASSWORD })));
    }
    const res = await signup({}, form({ email: "n6@example.com", password: PASSWORD }));
    expect(res.message).toMatch(/Too many attempts/);
    expect(h.fake.users.size).toBe(5);
  });

  it("caps how many emails one address can be sent, across IPs", async () => {
    for (let i = 0; i < 4; i++) {
      h.ip = `7.7.7.${i}`;
      await run(() => signup({}, form({ email: "victim@example.com", password: PASSWORD })));
    }
    h.ip = "7.7.7.99";
    const res = await signup({}, form({ email: "victim@example.com", password: PASSWORD }));
    expect(res.message).toMatch(/Too many attempts/);
  });

  it("reports a provider outage as unavailable, not as a bad form", async () => {
    h.fake.outage = true;
    const res = await signup({}, form({ email: "a@example.com", password: PASSWORD }));
    expect(res.message).toMatch(/temporarily unavailable/);
    expect(res.errors).toBeUndefined();
  });
});

describe("verify email", () => {
  async function pending() {
    await run(() => signup({}, form({ email: "new@example.com", password: PASSWORD })));
    return h.fake.lastCode("new@example.com")!;
  }

  it("the right code verifies, signs in, and creates our user row on first use", async () => {
    const code = await pending();
    const res = await run(() => verifyEmail({}, form({ email: "New@example.com", code })));
    expect(res).toEqual({ redirect: "/dashboard?verified=1" });
    expect(h.jar.has(SESSION_COOKIE)).toBe(true);

    expect(await db.user.count()).toBe(0);
    const me = await getCurrentUser();
    expect(me).toMatchObject({ email: "new@example.com", emailVerified: true });
    expect(await db.user.count({ where: { id: me!.id } })).toBe(1);
    await getCurrentUser(); // idempotent
    expect(await db.user.count()).toBe(1);
  });

  it("a wrong code is refused, and the code stops working after repeated misses", async () => {
    const code = await pending();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) {
      const res = await verifyEmail({}, form({ email: "new@example.com", code: wrong }));
      expect(res.message).toMatch(/wrong or has expired/);
    }
    // Even the correct code is dead now: guessing can't be retried forever.
    const late = await verifyEmail({}, form({ email: "new@example.com", code }));
    expect(late.message).toMatch(/wrong or has expired/);
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("rejects malformed codes before asking Neon Auth", async () => {
    await pending();
    for (const code of ["12345", "1234567", "abcdef", "12 456", ""]) {
      const res = await verifyEmail({}, form({ email: "new@example.com", code }));
      expect(res.errors?.code, code).toBeTruthy();
    }
  });

  it("limits guesses per address, even from many IPs", async () => {
    const code = await pending();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 10; i++) {
      h.ip = `6.6.6.${i}`;
      await verifyEmail({}, form({ email: "new@example.com", code: wrong }));
    }
    h.ip = "6.6.6.99";
    const res = await verifyEmail({}, form({ email: "new@example.com", code }));
    expect(res.message).toMatch(/Too many attempts/);
  });

  it("tells the truth about how long a code lives (5 minutes, measured on the real service)", async () => {
    await pending();
    const res = await resendVerificationCode({}, form({ email: "new@example.com" }));
    expect(res.message).toMatch(/valid for 5 minutes/);
  });

  it("resending answers the same for unknown and unverified addresses", async () => {
    await pending();
    const a = await resendVerificationCode({}, form({ email: "new@example.com" }));
    const b = await resendVerificationCode({}, form({ email: "ghost@example.com" }));
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ...a, values: { email: "ghost@example.com" } });
    expect(h.fake.outbox.map((m) => m.to)).toEqual(["new@example.com", "new@example.com"]);
  });

  it("a newer code replaces the older one", async () => {
    const first = await pending();
    await resendVerificationCode({}, form({ email: "new@example.com" }));
    const second = h.fake.lastCode("new@example.com")!;
    expect(second).not.toBe(first);
    expect((await verifyEmail({}, form({ email: "new@example.com", code: first }))).message).toMatch(
      /wrong or has expired/,
    );
    expect(await run(() => verifyEmail({}, form({ email: "new@example.com", code: second })))).toEqual({
      redirect: "/dashboard?verified=1",
    });
  });
});

describe("login", () => {
  it("signs in with the right password", async () => {
    const u = h.fake.seedUser({ email: "a@example.com" });
    expect(await run(() => login({}, form({ email: "A@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
    expect(h.fake.sessionCount(u.id)).toBe(1);
    expect(h.jar.has(SESSION_COOKIE)).toBe(true);
  });

  it("gives the same message for a wrong password and an unknown email", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    const wrong = await login({}, form({ email: "a@example.com", password: "nope-nope-nope" }));
    const unknown = await login({}, form({ email: "ghost@example.com", password: "nope-nope-nope" }));
    expect(wrong.message).toBe("Incorrect email or password");
    expect(unknown.message).toBe(wrong.message);
  });

  it("an unverified account with the right password is sent to the code screen", async () => {
    h.fake.seedUser({ email: "a@example.com", verified: false });
    const res = await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })));
    expect(res).toEqual({ redirect: verifyUrl("a@example.com") });
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
    // Neon Auth sends nothing on sign-in and sign-up's code lives only minutes, so we ask for a new one.
    expect(h.fake.outbox).toEqual([
      expect.objectContaining({ to: "a@example.com", type: "email-verification" }),
    ]);
  });

  it("the fresh code sent at login really verifies the account", async () => {
    h.fake.seedUser({ email: "a@example.com", verified: false });
    await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })));
    const res = await run(() =>
      verifyEmail({}, form({ email: "a@example.com", code: h.fake.lastCode("a@example.com")! })),
    );
    expect(res).toEqual({ redirect: "/dashboard?verified=1" });
  });

  it("an unverified account with the wrong password learns nothing and gets no email", async () => {
    h.fake.seedUser({ email: "a@example.com", verified: false });
    const res = await login({}, form({ email: "a@example.com", password: "nope-nope-nope" }));
    expect(res.message).toBe("Incorrect email or password");
    expect(h.fake.outbox).toEqual([]);
  });

  it("logging in unverified can't be used to flood an inbox: the per-address email cap applies", async () => {
    h.fake.seedUser({ email: "a@example.com", verified: false });
    for (let i = 0; i < 6; i++) {
      h.ip = `7.7.7.${i}`;
      expect(await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })))).toEqual({
        redirect: verifyUrl("a@example.com"),
      });
    }
    expect(h.fake.outbox).toHaveLength(4); // RULES.otpSendEmail.limit
  });

  it("locks an account after repeated failures even across IPs", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    for (let i = 0; i < 10; i++) {
      h.ip = `9.9.9.${i}`;
      await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    }
    h.ip = "9.9.9.99";
    const locked = await login({}, form({ email: "a@example.com", password: PASSWORD }));
    expect(locked.message).toMatch(/Too many attempts/);
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("failures below the threshold are cleared by a successful login", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    for (let i = 0; i < 5; i++) await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    expect(await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
    for (let i = 0; i < 9; i++) await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    expect(await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
  });

  it("an outage is reported as such and doesn't count as a failed password", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    h.fake.outage = true;
    for (let i = 0; i < 12; i++) {
      const res = await login({}, form({ email: "a@example.com", password: PASSWORD }));
      expect(res.message).toMatch(/temporarily unavailable/);
    }
    h.fake.outage = false;
    expect(await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
  });
});

describe("logout", () => {
  it("ends the session at Neon Auth and clears the cookies", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    expect(await run(() => logout())).toEqual({ redirect: "/login" });
    expect(h.fake.sessionCount(u.id)).toBe(0);
    expect([...h.jar.keys()]).toEqual([]);
  });

  it("still signs this browser out when Neon Auth is unreachable", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    h.fake.outage = true;
    expect(await run(() => logout())).toEqual({ redirect: "/login" });
    expect([...h.jar.keys()]).toEqual([]);
  });
});

describe("current user", () => {
  it("anonymous visitors are sent to /login", async () => {
    expect(await getCurrentUser()).toBeNull();
    expect(await run(() => requireUser())).toEqual({ redirect: "/login" });
  });

  it("unverified users are sent to verify and get no data row", async () => {
    const u = h.fake.seedUser({ email: "a@example.com", verified: false });
    h.fake.signInAs(u); // only possible if verification isn't enforced upstream
    expect(await run(() => requireUser())).toEqual({ redirect: verifyUrl("a@example.com") });
    expect(await db.user.count()).toBe(0);
  });

  it("a session revoked on another device still passes the cache, but not a fresh check", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    await requireUser(); // caches
    // Revoke from "another device": delete the session server-side only.
    for (const token of [...h.fake.sessions.keys()]) h.fake.sessions.delete(token);

    expect((await requireUser()).id).toBe(u.id); // within the cache lifetime
    expect(await run(() => requireFreshUser())).toEqual({ redirect: "/login" });
    // ...and it drops the stale cookies, so the cache can't bounce /login back into the app.
    expect([...h.jar.keys()]).toEqual([]);
    expect(await getCurrentUser()).toBeNull();
    expect(await run(() => requireUser())).toEqual({ redirect: "/login" });
  });

  it("once the cache lifetime passes, a revoked session is refused everywhere", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    await requireUser();
    h.fake.sessions.clear();
    h.fake.expireCache();
    expect(await run(() => requireUser())).toEqual({ redirect: "/login" });
  });

  it("an outage is an error, never silently 'signed out'", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    h.fake.expireCache();
    h.fake.outage = true;
    await expect(getCurrentUser()).rejects.toThrow(/unavailable/);
  });

  it("two simultaneous first requests create one row", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    await Promise.all([getCurrentUser(), getCurrentUser(), getCurrentUser()]);
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);
  });
});

describe("password reset", () => {
  it("emails a code for a real account and the code sets a new password", async () => {
    const u = h.fake.seedUser({ email: "a@example.com" });
    const other = h.fake.seedUser();
    h.fake.signInAs(u);
    const otherSession = h.fake.otherDevice(other);

    const req = await run(() => requestPasswordReset({}, form({ email: "A@example.com" })));
    expect(req).toEqual({ redirect: "/reset-password?email=a%40example.com" });
    await flush();
    expect(h.fake.outbox).toEqual([expect.objectContaining({ to: "a@example.com", type: "forget-password" })]);

    const done = await run(() =>
      resetPassword(
        {},
        form({
          email: "a@example.com",
          code: h.fake.lastCode()!,
          password: "brand-new-pass",
          confirm: "brand-new-pass",
        }),
      ),
    );
    expect(done).toEqual({ redirect: "/login?reset=1" });

    expect(h.fake.users.get("a@example.com")!.password).toBe("brand-new-pass");
    expect(h.fake.sessionCount(u.id)).toBe(0); // signed out everywhere
    expect(h.fake.sessions.has(otherSession)).toBe(true); // somebody else's session untouched
  });

  it("a reset code from the inbox also verifies a still-unverified address (as the real service does)", async () => {
    h.fake.seedUser({ email: "a@example.com", verified: false });
    await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    await flush();
    expect(h.fake.lastCode("a@example.com")).toBeTruthy();
    await run(() =>
      resetPassword(
        {},
        form({ email: "a@example.com", code: h.fake.lastCode()!, password: "brand-new-pass", confirm: "brand-new-pass" }),
      ),
    );
    const res = await run(() => login({}, form({ email: "a@example.com", password: "brand-new-pass" })));
    expect(res).toEqual({ redirect: "/dashboard" });
  });

  it("looks identical for unknown emails and sends nothing", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    const a = await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    const b = await run(() => requestPasswordReset({}, form({ email: "ghost@example.com" })));
    await flush();
    expect(a).toEqual({ redirect: "/reset-password?email=a%40example.com" });
    expect(b).toEqual({ redirect: "/reset-password?email=ghost%40example.com" });
    expect(h.fake.outbox.map((m) => m.to)).toEqual(["a@example.com"]);
  });

  it("doesn't wait for the email to be sent before answering", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    const send = vi.spyOn(h.fake, "sendOtp");
    await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    // Queued with after(), not awaited: it runs only once the tasks are flushed.
    expect(h.afterTasks).toHaveLength(1);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a code works once, and a newer code replaces the older one", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    await flush();
    const first = h.fake.lastCode()!;
    await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    await flush();
    const second = h.fake.lastCode()!;

    const body = (code: string) =>
      form({ email: "a@example.com", code, password: "brand-new-pass", confirm: "brand-new-pass" });
    expect((await resetPassword({}, body(first))).message).toMatch(/wrong or has expired/);
    expect(await run(() => resetPassword({}, body(second)))).toEqual({ redirect: "/login?reset=1" });
    expect((await resetPassword({}, body(second))).message).toMatch(/wrong or has expired/);
  });

  it("a mismatch or a short password is rejected without spending the code", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    await flush();
    const code = h.fake.lastCode()!;
    const base = { email: "a@example.com", code };
    const bad = await resetPassword({}, form({ ...base, password: "brand-new-pass", confirm: "different-one" }));
    expect(bad.errors?.confirm).toBeTruthy();
    const short = await resetPassword({}, form({ ...base, password: "short", confirm: "short" }));
    expect(short.errors?.password).toBeTruthy();
    expect(
      await run(() => resetPassword({}, form({ ...base, password: "brand-new-pass", confirm: "brand-new-pass" }))),
    ).toEqual({ redirect: "/login?reset=1" });
  });

  it("limits reset requests per email, even from another IP", async () => {
    h.fake.seedUser({ email: "a@example.com" });
    for (let i = 0; i < 4; i++) await run(() => requestPasswordReset({}, form({ email: "a@example.com" })));
    h.ip = "8.8.8.8";
    const res = await requestPasswordReset({}, form({ email: "a@example.com" }));
    expect(res.message).toMatch(/Too many attempts/);
  });
});

describe("account settings", () => {
  it("change password needs the current password, keeps this session and drops the others", async () => {
    const u = h.fake.seedUser();
    const otherDevice = h.fake.otherDevice(u);
    h.fake.signInAs(u);
    const other2 = h.fake.otherDevice(u);

    const wrong = await changePassword(
      {},
      form({ current: "wrong-wrong", password: "brand-new-pass", confirm: "brand-new-pass" }),
    );
    expect(wrong.errors?.current).toBeTruthy();
    expect(h.fake.sessions.has(otherDevice)).toBe(true);

    const ok = await changePassword(
      {},
      form({ current: PASSWORD, password: "brand-new-pass", confirm: "brand-new-pass" }),
    );
    expect(ok.ok).toBe(true);
    expect(h.fake.sessions.has(otherDevice)).toBe(false);
    expect(h.fake.sessions.has(other2)).toBe(false);
    expect(h.fake.sessionCount(u.id)).toBe(1);
    expect(h.jar.has(SESSION_COOKIE)).toBe(true);
  });

  it("change password requires being signed in, and a live session", async () => {
    expect(await run(() => changePassword({}, form({ current: "a", password: "b", confirm: "b" })))).toEqual({
      redirect: "/login",
    });
    // A session revoked elsewhere but still cached must not be able to change it.
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    h.fake.sessions.clear();
    expect(
      await run(() =>
        changePassword({}, form({ current: PASSWORD, password: "brand-new-pass", confirm: "brand-new-pass" })),
      ),
    ).toEqual({ redirect: "/login" });
    expect(h.fake.users.get(u.email)!.password).toBe(PASSWORD);
  });

  it("limits password guesses made from a signed-in session", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    for (let i = 0; i < 10; i++) {
      await changePassword({}, form({ current: "wrong-wrong", password: "brand-new-pass", confirm: "brand-new-pass" }));
    }
    const res = await changePassword(
      {},
      form({ current: PASSWORD, password: "brand-new-pass", confirm: "brand-new-pass" }),
    );
    expect(res.message).toMatch(/Too many attempts/);
  });

  it("sign out everywhere ends all of the user's sessions", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    h.fake.otherDevice(u);
    expect(await run(() => signOutEverywhere())).toEqual({ redirect: "/login" });
    expect(h.fake.sessionCount(u.id)).toBe(0);
    expect(h.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("sign out everywhere doesn't claim success when Neon Auth can't do it", async () => {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    h.fake.otherDevice(u);
    const revoke = vi.spyOn(h.fake, "revokeAllSessions").mockResolvedValue({
      data: null,
      error: { status: 503, code: "UNAVAILABLE" },
    });
    const res = await run(() => signOutEverywhere());
    expect(res).toMatchObject({ message: expect.stringMatching(/temporarily unavailable/) });
    expect(revoke).toHaveBeenCalled();
    expect(h.jar.has(SESSION_COOKIE)).toBe(true);
  });
});

describe("delete account", () => {
  async function setup() {
    const u = h.fake.seedUser();
    h.fake.signInAs(u);
    await getCurrentUser(); // creates our row
    const bystander = h.fake.seedUser();
    await db.user.create({ data: { id: bystander.id } });
    await db.application.create({ data: { userId: bystander.id, company: "Keep", jobTitle: "Me" } });

    const buffer = makePdf(["resume"]);
    const key = await saveResumeFile(u.id, {
      fileName: "r.pdf",
      mimeType: "application/pdf",
      size: buffer.length,
      buffer,
    });
    await db.resume.create({
      data: { userId: u.id, label: "r", fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, storageKey: key },
    });
    await db.application.create({ data: { userId: u.id, company: "Gone", jobTitle: "X" } });
    return { u, bystander, key };
  }

  it("needs the right password", async () => {
    const { u } = await setup();
    const wrong = await deleteAccount({}, form({ password: "wrong-wrong" }));
    expect(wrong.errors?.password).toBeTruthy();
    const empty = await deleteAccount({}, form({ password: "" }));
    expect(empty.errors?.password).toBeTruthy();
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);
  });

  it("limits password guesses", async () => {
    const { u } = await setup();
    for (let i = 0; i < 10; i++) await deleteAccount({}, form({ password: "wrong-wrong" }));
    const res = await deleteAccount({}, form({ password: PASSWORD }));
    expect(res.message).toMatch(/Too many attempts/);
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);
  });

  it("removes our data and files, ends every session, and leaves other users alone", async () => {
    const { u, bystander, key } = await setup();
    h.fake.otherDevice(u);

    expect(await run(() => deleteAccount({}, form({ password: PASSWORD })))).toEqual({
      redirect: "/?deleted=1",
    });
    expect(await db.user.count({ where: { id: u.id } })).toBe(0);
    expect(await db.application.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.resume.count({ where: { userId: u.id } })).toBe(0);
    await expect(readResumeFile(key)).rejects.toBeTruthy();
    expect(h.fake.sessionCount(u.id)).toBe(0);
    expect([...h.jar.keys()].filter((k) => k.startsWith("__Secure-neon-auth"))).toEqual([]);
    expect(await db.application.count({ where: { userId: bystander.id } })).toBe(1);
  });

  it("while Neon Auth can't delete identities, logs which one was kept (no email or password)", async () => {
    const { u } = await setup();
    await run(() => deleteAccount({}, form({ password: PASSWORD })));
    expect(h.fake.users.has(u.email)).toBe(true); // retained upstream: documented limitation
    const logged = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("auth_identity_retained");
    expect(logged).toContain(u.id);
    expect(logged).not.toContain(u.email);
    expect(logged).not.toContain(PASSWORD);
  });

  it("removes the identity too when Neon Auth supports it", async () => {
    const { u } = await setup();
    h.fake.supportsDeleteUser = true;
    await run(() => deleteAccount({}, form({ password: PASSWORD })));
    expect(h.fake.users.has(u.email)).toBe(false);
    expect(vi.mocked(console.warn)).not.toHaveBeenCalled();
  });

  it("if a file can't be deleted, nothing is deleted and the user can retry", async () => {
    const { u, key } = await setup();
    const strict = vi.spyOn(storage, "deleteResumeFileStrict").mockRejectedValueOnce(new Error("boom"));
    const res = await deleteAccount({}, form({ password: PASSWORD }));
    expect(res.message).toMatch(/Nothing was deleted/);
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);
    expect(await db.resume.count({ where: { userId: u.id } })).toBe(1);
    await expect(readResumeFile(key)).resolves.toBeTruthy();

    strict.mockRestore();
    expect(await run(() => deleteAccount({}, form({ password: PASSWORD })))).toEqual({
      redirect: "/?deleted=1",
    });
  });

  it("requires a live session", async () => {
    const { u } = await setup();
    h.fake.sessions.clear(); // revoked on another device; cache still says signed in
    expect(await run(() => deleteAccount({}, form({ password: PASSWORD })))).toEqual({ redirect: "/login" });
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);
  });
});
