import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Stand-ins for Next's request context ---------------------------------
const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  ip: "1.1.1.1",
  afterTasks: [] as Promise<unknown>[],
}));

class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect:${url}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string) => void h.jar.set(n, v),
    delete: (n: string) => void h.jar.delete(n),
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
const generateCoverLetter = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generateCoverLetter,
}));

import { db } from "@/lib/db";
import { createSession, hashPassword, verifyPassword } from "@/lib/auth";
import { devOutbox } from "@/lib/email";
import { resetStorageDriver, readResumeFile, saveResumeFile } from "@/lib/storage";
import { login, requestPasswordReset, resetPassword, signup } from "@/app/actions/auth";
import {
  changePassword,
  confirmEmail,
  deleteAccount,
  resendVerification,
  signOutEverywhere,
} from "@/app/actions/account";
import {
  createApplication,
  deleteApplication,
  updateApplication,
  updateApplicationStatus,
} from "@/app/actions/applications";
import { deleteResume } from "@/app/actions/resumes";
import { GET as downloadResume } from "@/app/api/resumes/[id]/route";
import { POST as draftCoverLetter } from "@/app/api/cover-letter/route";
import { makePdf } from "@/test/files";
import { resetDb } from "@/test/db";

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

let seq = 0;
async function makeUser(opts: { verified?: boolean; email?: string } = {}) {
  seq++;
  return db.user.create({
    data: {
      email: opts.email ?? `u${seq}-${Date.now()}@example.com`,
      name: `U${seq}`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: opts.verified ? new Date() : null,
    },
  });
}
async function signInAs(user: { id: string }) {
  h.jar.clear();
  await createSession(user.id);
}
const tokenFromOutbox = (index = -1) => {
  const mail = devOutbox().at(index)!;
  return new URL(mail.text.match(/https?:\/\/\S+/)![0]).searchParams.get("token")!;
};
const appFields = (extra: Record<string, string> = {}) =>
  form({ company: "Acme", jobTitle: "Engineer", status: "APPLIED", ...extra });

let uploadDir: string;
beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(os.tmpdir(), "actions-"));
  process.env.UPLOAD_DIR = uploadDir;
  resetStorageDriver();
});
afterAll(async () => {
  delete process.env.UPLOAD_DIR;
  resetStorageDriver();
  await rm(uploadDir, { recursive: true, force: true });
});
beforeEach(async () => {
  await resetDb();
  h.jar.clear();
  h.ip = "1.1.1.1";
  h.afterTasks.length = 0;
  devOutbox().length = 0;
  generateCoverLetter.mockReset().mockResolvedValue("Dear team...");
});

describe("signup", () => {
  it("creates the account, signs in, and emails a working verification link", async () => {
    const res = await run(() =>
      signup({}, form({ name: "Sam", email: "Sam@Example.com", password: PASSWORD })),
    );
    expect(res).toEqual({ redirect: "/dashboard" });
    expect(h.jar.get("session")).toBeTruthy();

    const user = await db.user.findUniqueOrThrow({ where: { email: "sam@example.com" } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash).not.toContain(PASSWORD);

    await flush();
    expect(devOutbox()).toHaveLength(1);
    expect(devOutbox()[0].to).toBe("sam@example.com");

    expect(await run(() => confirmEmail({}, form({ token: tokenFromOutbox() })))).toEqual({
      redirect: "/dashboard?verified=1",
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
  });

  it("rejects a duplicate email without creating another user", async () => {
    await makeUser({ email: "dup@example.com" });
    const res = await signup({}, form({ email: "dup@example.com", password: PASSWORD }));
    expect(res.errors?.email).toMatch(/already exists/);
    expect(await db.user.count()).toBe(1);
  });

  it("doesn't echo the password back after an error", async () => {
    const res = await signup({}, form({ email: "bad", password: "x" }));
    expect(res.errors).toBeTruthy();
    expect(JSON.stringify(res.values)).not.toContain("x\"");
    expect(res.values).not.toHaveProperty("password");
  });

  it("limits signups per IP", async () => {
    for (let i = 0; i < 5; i++) {
      await run(() => signup({}, form({ email: `n${i}@example.com`, password: PASSWORD })));
    }
    const res = await signup({}, form({ email: "n6@example.com", password: PASSWORD }));
    expect(res.message).toMatch(/Too many attempts/);
    expect(await db.user.count()).toBe(5);
  });

  it("a verification email can't be used to verify a different action's token", async () => {
    const u = await makeUser();
    await run(() => signup({}, form({ email: "x@example.com", password: PASSWORD })));
    await flush();
    // verify-email token must not work as a password-reset token
    const res = await resetPassword({}, form({ token: tokenFromOutbox(), password: PASSWORD, confirm: PASSWORD }));
    expect(res.message).toMatch(/invalid or has expired/);
    expect(u.id).toBeTruthy();
  });
});

describe("login", () => {
  it("signs in with the right password", async () => {
    const u = await makeUser({ email: "a@example.com" });
    expect(await run(() => login({}, form({ email: "A@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
    expect(await db.session.count({ where: { userId: u.id } })).toBe(1);
  });

  it("gives the same message for a wrong password and an unknown email", async () => {
    await makeUser({ email: "a@example.com" });
    const wrong = await login({}, form({ email: "a@example.com", password: "nope-nope-nope" }));
    const unknown = await login({}, form({ email: "ghost@example.com", password: "nope-nope-nope" }));
    expect(wrong.message).toBe("Incorrect email or password");
    expect(unknown.message).toBe(wrong.message);
  });

  it("locks an account after repeated failures even across IPs, and success resets it", async () => {
    await makeUser({ email: "a@example.com" });
    for (let i = 0; i < 10; i++) {
      h.ip = `9.9.9.${i}`;
      await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    }
    h.ip = "9.9.9.99";
    const locked = await login({}, form({ email: "a@example.com", password: PASSWORD }));
    expect(locked.message).toMatch(/Too many attempts/);
    expect(h.jar.has("session")).toBe(false);
  });

  it("failures below the threshold are cleared by a successful login", async () => {
    await makeUser({ email: "a@example.com" });
    for (let i = 0; i < 5; i++) await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    expect(await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })))).toEqual({
      redirect: "/dashboard",
    });
    for (let i = 0; i < 9; i++) await login({}, form({ email: "a@example.com", password: "wrong-wrong" }));
    const res = await run(() => login({}, form({ email: "a@example.com", password: PASSWORD })));
    expect(res).toEqual({ redirect: "/dashboard" });
  });
});

describe("password reset", () => {
  it("emails a link for a real account and the link sets a new password", async () => {
    const u = await makeUser({ email: "a@example.com" });
    const other = await makeUser();
    await signInAs(u);
    await createSession(other.id); // unrelated user's session must survive

    const res = await requestPasswordReset({}, form({ email: "A@example.com" }));
    expect(res.ok).toBe(true);
    await flush();
    expect(devOutbox()).toHaveLength(1);
    expect(devOutbox()[0].to).toBe("a@example.com");

    const token = tokenFromOutbox();
    const done = await run(() =>
      resetPassword({}, form({ token, password: "brand-new-pass", confirm: "brand-new-pass" })),
    );
    expect(done).toEqual({ redirect: "/login?reset=1" });

    const after = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("brand-new-pass", after.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, after.passwordHash)).toBe(false);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: other.id } })).toBe(1);
  });

  it("looks identical for unknown emails and sends nothing", async () => {
    const real = await makeUser({ email: "a@example.com" });
    const a = await requestPasswordReset({}, form({ email: "a@example.com" }));
    const b = await requestPasswordReset({}, form({ email: "ghost@example.com" }));
    await flush();
    expect(b).toEqual({ ok: true, message: a.message });
    expect(devOutbox().map((m) => m.to)).toEqual(["a@example.com"]);
    expect(real.id).toBeTruthy();
  });

  it("tokens are single-use and a newer request invalidates the older link", async () => {
    await makeUser({ email: "a@example.com" });
    await requestPasswordReset({}, form({ email: "a@example.com" }));
    await flush();
    const first = tokenFromOutbox();
    await requestPasswordReset({}, form({ email: "a@example.com" }));
    await flush();
    const second = tokenFromOutbox();
    expect(second).not.toBe(first);

    const body = (token: string) => form({ token, password: "brand-new-pass", confirm: "brand-new-pass" });
    expect((await resetPassword({}, body(first))).message).toMatch(/invalid or has expired/);
    expect(await run(() => resetPassword({}, body(second)))).toEqual({ redirect: "/login?reset=1" });
    expect((await resetPassword({}, body(second))).message).toMatch(/invalid or has expired/);
  });

  it("rejects a mismatched confirmation and short passwords without using the token", async () => {
    await makeUser({ email: "a@example.com" });
    await requestPasswordReset({}, form({ email: "a@example.com" }));
    await flush();
    const token = tokenFromOutbox();
    const bad = await resetPassword({}, form({ token, password: "brand-new-pass", confirm: "different-one" }));
    expect(bad.errors?.confirm).toBeTruthy();
    const short = await resetPassword({}, form({ token, password: "short", confirm: "short" }));
    expect(short.errors?.password).toBeTruthy();
    expect(await run(() => resetPassword({}, form({ token, password: "brand-new-pass", confirm: "brand-new-pass" })))).toEqual({
      redirect: "/login?reset=1",
    });
  });

  it("limits reset requests per email", async () => {
    await makeUser({ email: "a@example.com" });
    for (let i = 0; i < 3; i++) await requestPasswordReset({}, form({ email: "a@example.com" }));
    h.ip = "8.8.8.8"; // a different IP doesn't dodge the per-email limit
    const res = await requestPasswordReset({}, form({ email: "a@example.com" }));
    expect(res.ok).toBeUndefined();
    expect(res.message).toMatch(/Too many attempts/);
  });

  it("reports a spent daily email quota to everyone alike, without sending", async () => {
    vi.stubEnv("SMTP_HOST", "smtp.test");
    vi.stubEnv("EMAIL_DAILY_LIMIT", "1");
    try {
      await makeUser({ email: "a@example.com" });
      await db.$executeRawUnsafe(
        `INSERT INTO "RateLimit" ("key","windowStart","count") VALUES ('email:daily', date_trunc('day', now() AT TIME ZONE 'UTC'), 1)`,
      );
      const res = await requestPasswordReset({}, form({ email: "a@example.com" }));
      expect(res.ok).toBeUndefined();
      expect(res.message).toMatch(/can't send email/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("account settings", () => {
  it("change password keeps this session, drops others, and requires the current password", async () => {
    const u = await makeUser();
    await createSession(u.id); // "other device"
    const otherDevice = h.jar.get("session");
    await signInAs(u); // clears the jar and makes the "current" one
    // re-create the other device's session record since signInAs only added one
    await createSession(u.id);
    const current = h.jar.get("session")!;
    expect(otherDevice).toBeTruthy();

    const wrong = await changePassword({}, form({ current: "wrong-wrong", password: "brand-new-pass", confirm: "brand-new-pass" }));
    expect(wrong.errors?.current).toBeTruthy();

    const ok = await changePassword({}, form({ current: PASSWORD, password: "brand-new-pass", confirm: "brand-new-pass" }));
    expect(ok.ok).toBe(true);
    expect(h.jar.get("session")).toBe(current);
    expect(await db.session.count({ where: { userId: u.id } })).toBe(1);
  });

  it("change password requires being signed in", async () => {
    const res = await run(() => changePassword({}, form({ current: "a", password: "b", confirm: "b" })));
    expect(res).toEqual({ redirect: "/login" });
  });

  it("resend verification is limited per user and skipped when already verified", async () => {
    const u = await makeUser();
    await signInAs(u);
    for (let i = 0; i < 3; i++) expect((await resendVerification()).ok).toBe(true);
    expect((await resendVerification()).message).toMatch(/Too many attempts/);
    expect(devOutbox()).toHaveLength(3);

    const v = await makeUser({ verified: true });
    await signInAs(v);
    expect((await resendVerification()).message).toMatch(/already verified/);
  });

  it("confirmEmail rejects bad tokens", async () => {
    const res = await confirmEmail({}, form({ token: "nonsense" }));
    expect(res.message).toMatch(/invalid or has expired/);
  });

  it("sign out everywhere ends all of the user's sessions", async () => {
    const u = await makeUser();
    await signInAs(u);
    await createSession(u.id);
    expect(await run(() => signOutEverywhere())).toEqual({ redirect: "/login" });
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
    expect(h.jar.has("session")).toBe(false);
  });

  it("delete account needs the right password, then removes everything incl. files", async () => {
    const u = await makeUser();
    const bystander = await makeUser();
    await db.application.create({ data: { userId: bystander.id, company: "Keep", jobTitle: "Me" } });

    const buffer = makePdf(["resume"]);
    const key = await saveResumeFile(u.id, { fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, buffer });
    await db.resume.create({ data: { userId: u.id, label: "r", fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, storageKey: key } });
    await db.application.create({ data: { userId: u.id, company: "Gone", jobTitle: "X" } });

    await signInAs(u);
    const wrong = await deleteAccount({}, form({ password: "wrong-wrong" }));
    expect(wrong.errors?.password).toBeTruthy();
    expect(await db.user.count({ where: { id: u.id } })).toBe(1);

    expect(await run(() => deleteAccount({}, form({ password: PASSWORD })))).toEqual({ redirect: "/?deleted=1" });
    expect(await db.user.count({ where: { id: u.id } })).toBe(0);
    expect(await db.application.count({ where: { userId: u.id } })).toBe(0);
    expect(await db.resume.count({ where: { userId: u.id } })).toBe(0);
    await expect(readResumeFile(key)).rejects.toBeTruthy();
    // Someone else's data is untouched.
    expect(await db.application.count({ where: { userId: bystander.id } })).toBe(1);
  });
});

describe("access control: users can't touch each other's data", () => {
  async function setup() {
    const owner = await makeUser({ verified: true });
    const intruder = await makeUser({ verified: true });
    const app = await db.application.create({
      data: { userId: owner.id, company: "Secret Co", jobTitle: "Secret", status: "APPLIED" },
    });
    const buffer = makePdf(["owner resume text that is long enough to read"]);
    const key = await saveResumeFile(owner.id, { fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, buffer });
    const resume = await db.resume.create({
      data: { userId: owner.id, label: "Owner", fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, storageKey: key },
    });
    return { owner, intruder, app, resume, key };
  }

  it("can't change someone else's application status", async () => {
    const { intruder, app } = await setup();
    await signInAs(intruder);
    const res = await updateApplicationStatus(app.id, "REJECTED");
    expect(res.ok).toBe(false);
    expect((await db.application.findUniqueOrThrow({ where: { id: app.id } })).status).toBe("APPLIED");
  });

  it("can't edit someone else's application", async () => {
    const { intruder, app } = await setup();
    await signInAs(intruder);
    const res = await run(() => updateApplication(app.id, {}, appFields({ company: "Hacked" })));
    expect(res).toEqual({ redirect: "/applications" });
    expect((await db.application.findUniqueOrThrow({ where: { id: app.id } })).company).toBe("Secret Co");
  });

  it("can't delete someone else's application", async () => {
    const { intruder, app } = await setup();
    await signInAs(intruder);
    await run(() => deleteApplication(app.id));
    expect(await db.application.count({ where: { id: app.id } })).toBe(1);
  });

  it("can't attach someone else's resume to their own application", async () => {
    const { intruder, resume } = await setup();
    await signInAs(intruder);
    const res = await createApplication({}, appFields({ resumeId: resume.id }));
    expect(res.errors?.resumeId).toBeTruthy();
    expect(await db.application.count({ where: { userId: intruder.id } })).toBe(0);
  });

  it("can't delete or download someone else's resume", async () => {
    const { intruder, resume, key } = await setup();
    await signInAs(intruder);
    await deleteResume(resume.id);
    expect(await db.resume.count({ where: { id: resume.id } })).toBe(1);
    await expect(readResumeFile(key)).resolves.toBeTruthy();

    const res = await downloadResume(new Request("http://x"), { params: Promise.resolve({ id: resume.id }) });
    expect(res.status).toBe(404);
  });

  it("the owner can download their resume with safe headers", async () => {
    const { owner, resume } = await setup();
    await signInAs(owner);
    const res = await downloadResume(new Request("http://x"), { params: Promise.resolve({ id: resume.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("signed-out requests are refused", async () => {
    const { app, resume } = await setup();
    h.jar.clear();
    expect(await run(() => updateApplicationStatus(app.id, "REJECTED"))).toEqual({ redirect: "/login" });
    const res = await downloadResume(new Request("http://x"), { params: Promise.resolve({ id: resume.id }) });
    expect(res.status).toBe(401);
  });
});

describe("AI cover letter route", () => {
  const post = (fields: Record<string, string> = { company: "Acme", jobTitle: "Engineer" }) =>
    draftCoverLetter(new Request("http://x", { method: "POST", body: form(fields) }));

  it("requires sign-in", async () => {
    expect((await post()).status).toBe(401);
  });

  it("requires a verified email, and never calls the model otherwise", async () => {
    await signInAs(await makeUser({ verified: false }));
    const res = await post();
    expect(res.status).toBe(403);
    expect(generateCoverLetter).not.toHaveBeenCalled();
  });

  it("drafts for verified users and then enforces the hourly cap", async () => {
    await signInAs(await makeUser({ verified: true }));
    const ok = await post();
    expect(ok.status).toBe(200);
    expect(generateCoverLetter).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 14; i++) await post();
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(generateCoverLetter).toHaveBeenCalledTimes(15);
  });

  it("the cap is per user", async () => {
    const a = await makeUser({ verified: true });
    const b = await makeUser({ verified: true });
    await signInAs(a);
    for (let i = 0; i < 16; i++) await post();
    await signInAs(b);
    expect((await post()).status).toBe(200);
  });
});
