import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAuth } from "@/test/fake-auth";

// ---- Stand-ins for Next's request context ---------------------------------
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
const generateCoverLetter = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generateCoverLetter,
}));

import { db } from "@/lib/db";
import { resetStorageDriver, readResumeFile, saveResumeFile } from "@/lib/storage";
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
import { FakeAuth as FakeAuthImpl } from "@/test/fake-auth";

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

/**
 * A user as Neon Auth knows them, plus our row for them (which the app would
 * create on first use; it is created up front here to seed data).
 */
async function makeUser(opts: { verified?: boolean } = {}) {
  const u = h.fake.seedUser({ verified: opts.verified ?? false });
  if (u.verified) await db.user.create({ data: { id: u.id } });
  return u;
}
function signInAs(user: { id: string }) {
  h.fake.signInAs(user);
}
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
  // Rate-limit windows follow the wall clock; pin it mid-window (Date only).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:07:30Z"));
  await resetDb();
  h.jar.clear();
  h.ip = "1.1.1.1";
  h.afterTasks.length = 0;
  h.fake = new FakeAuthImpl(h.jar);
  generateCoverLetter.mockReset().mockResolvedValue("Dear team...");
});

afterEach(() => {
  vi.useRealTimers();
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

  it("an unverified account can't download a resume, even its own", async () => {
    const unverified = await makeUser({ verified: false });
    await db.user.create({ data: { id: unverified.id } }); // as if data existed from before
    const buffer = makePdf(["mine"]);
    const key = await saveResumeFile(unverified.id, { fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, buffer });
    const resume = await db.resume.create({
      data: { userId: unverified.id, label: "Mine", fileName: "r.pdf", mimeType: "application/pdf", size: buffer.length, storageKey: key },
    });
    signInAs(unverified);
    const res = await downloadResume(new Request("http://x"), { params: Promise.resolve({ id: resume.id }) });
    expect(res.status).toBe(401);
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

  it("is a 404 when the AI_ENABLED flag is off (unset, empty, or anything but 'true')", async () => {
    for (const value of [undefined, "", "false", "1"]) {
      if (value === undefined) vi.stubEnv("AI_ENABLED", undefined as unknown as string);
      else vi.stubEnv("AI_ENABLED", value);
      const res = await post();
      expect(res.status, `AI_ENABLED=${String(value)}`).toBe(404);
    }
    vi.unstubAllEnvs();
    expect((await post()).status).toBe(401); // back on: now reaches the auth check
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
