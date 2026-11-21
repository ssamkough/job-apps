import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAuth } from "@/test/fake-auth";

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  ip: "9.9.9.9",
  fake: undefined as unknown as FakeAuth,
}));

const generateAnswerDraft = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (n: string, v: string, o?: { maxAge?: number }) => {
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
    delete: (n: string) => void h.jar.delete(n),
  }),
  headers: async () => new Headers({ "x-forwarded-for": h.ip }),
}));
vi.mock("next/navigation", () => ({ redirect: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("@/lib/auth-api", () => ({ authApi: () => h.fake }));
vi.mock("@/lib/ai", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai")>()),
  generateAnswerDraft,
}));

import { db } from "@/lib/db";
import { AI_PAUSED_MESSAGE, spendMonth } from "@/lib/ai-budget";
import { POST as draftAnswer } from "@/app/api/answer-draft/route";
import { AiBusyError, AiTimeoutError, AiUnavailableError } from "@/lib/ai";
import { resetStorageDriver, saveResumeFile } from "@/lib/storage";
import { makePdf } from "@/test/files";
import { resetDb } from "@/test/db";
import { FakeAuth as FakeAuthImpl } from "@/test/fake-auth";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const post = (questionId?: string) =>
  draftAnswer(
    new Request("http://x/api/answer-draft", {
      method: "POST",
      body: questionId === undefined ? form({}) : form({ questionId }),
    }),
  );

async function signIn(opts: { verified?: boolean; name?: string } = {}) {
  const u = h.fake.seedUser({ verified: opts.verified ?? true, name: opts.name });
  if (u.verified) await db.user.create({ data: { id: u.id } });
  h.fake.signInAs(u);
  return u;
}

async function makeQuestion(userId: string, text = "Why do you want to work here?") {
  return db.question.create({
    data: {
      userId,
      text,
      textKey: text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
    },
  });
}

let uploadDir: string;
beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(os.tmpdir(), "answer-draft-"));
  process.env.UPLOAD_DIR = uploadDir;
  resetStorageDriver();
});
afterAll(async () => {
  delete process.env.UPLOAD_DIR;
  resetStorageDriver();
  await rm(uploadDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T12:07:30Z"));
  vi.stubEnv("AI_ENABLED", "true");
  vi.stubEnv("OLLAMA_INPUT_USD_PER_MILLION", "0.14");
  vi.stubEnv("OLLAMA_OUTPUT_USD_PER_MILLION", "0.40");
  vi.stubEnv("AI_MONTHLY_BUDGET_USD", "20");
  await resetDb();
  h.jar.clear();
  h.ip = "9.9.9.9";
  h.fake = new FakeAuthImpl(h.jar);
  generateAnswerDraft.mockReset().mockResolvedValue("I want to build careful systems.");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("POST /api/answer-draft", () => {
  it("is a 404 when AI_ENABLED is off, and does not call the model", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    for (const value of [undefined, "", "false", "1"]) {
      if (value === undefined) vi.stubEnv("AI_ENABLED", undefined as unknown as string);
      else vi.stubEnv("AI_ENABLED", value);
      const res = await post(q.id);
      expect(res.status, `AI_ENABLED=${String(value)}`).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("requires sign-in, then a verified email, before calling the model", async () => {
    expect((await post("anything")).status).toBe(401);

    const unverified = await signIn({ verified: false });
    await db.user.create({ data: { id: unverified.id } });
    const q = await makeQuestion(unverified.id);
    const res = await post(q.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Verify your email address to use AI drafts." });
    expect(generateAnswerDraft).not.toHaveBeenCalled();
  });

  it("rejects a missing question id and a question the caller does not own", async () => {
    const owner = await signIn();
    const q = await makeQuestion(owner.id);
    expect((await post()).status).toBe(400);

    h.jar.clear();
    await signIn();
    const res = await post(q.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That question no longer exists." });
    expect(generateAnswerDraft).not.toHaveBeenCalled();
    expect(await db.rateLimit.count()).toBe(0);
  });

  it("drafts from the question alone when nothing is attached", async () => {
    const u = await signIn({ name: "Ada" });
    const q = await makeQuestion(u.id);
    const res = await post(q.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      draft: "I want to build careful systems.",
      resumeUsed: false,
      resumeSkipped: false,
      application: null,
      usedMostRecent: false,
    });
    expect(generateAnswerDraft).toHaveBeenCalledWith({
      question: q.text,
      applicantName: "Ada",
      company: null,
      jobTitle: null,
      jobDescription: null,
      resumeText: null,
    });
    const keys = await db.rateLimit.findMany({ select: { key: true } });
    expect(keys.map((row) => row.key)).toEqual([`ai-answer:user:${u.id}`]);
  });

  it("uses the most recently updated application and its resume", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    const older = await db.application.create({
      data: {
        userId: u.id,
        company: "Old Co",
        jobTitle: "Engineer",
        status: "APPLIED",
        jobDescription: "This older posting must not be used.",
      },
    });
    const newer = await db.application.create({
      data: {
        userId: u.id,
        company: "New Co",
        jobTitle: "Staff Engineer",
        status: "APPLIED",
        jobDescription: "We need Go and Postgres.",
      },
    });
    const buffer = makePdf([
      "Built payment systems in Go and kept Postgres migrations online for the payments team.",
    ]);
    const storageKey = await saveResumeFile(u.id, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      size: buffer.length,
      buffer,
    });
    const resume = await db.resume.create({
      data: {
        userId: u.id,
        label: "Mine",
        fileName: "resume.pdf",
        mimeType: "application/pdf",
        size: buffer.length,
        storageKey,
      },
    });
    await db.application.update({ where: { id: newer.id }, data: { resumeId: resume.id } });
    await db.applicationQuestion.createMany({
      data: [
        { applicationId: older.id, questionId: q.id, position: 0 },
        { applicationId: newer.id, questionId: q.id, position: 0 },
      ],
    });
    // Fake timers freeze Date, so set the order explicitly after the writes.
    await db.$executeRaw`UPDATE "Application" SET "updatedAt" = ${new Date("2026-01-01T00:00:00Z")} WHERE id = ${older.id}`;
    await db.$executeRaw`UPDATE "Application" SET "updatedAt" = ${new Date("2026-06-01T00:00:00Z")} WHERE id = ${newer.id}`;

    const res = await post(q.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resumeUsed: true,
      resumeSkipped: false,
      application: { company: "New Co", jobTitle: "Staff Engineer" },
      usedMostRecent: true,
    });
    const input = generateAnswerDraft.mock.calls[0][0];
    expect(input.company).toBe("New Co");
    expect(input.jobTitle).toBe("Staff Engineer");
    expect(input.jobDescription).toBe("We need Go and Postgres.");
    expect(input.resumeText).toMatch(/payment systems in Go/i);
    expect(input.resumeText).not.toMatch(/older posting/i);
  });

  it("ignores a resume that is only attached to an older application", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    const older = await db.application.create({
      data: { userId: u.id, company: "Old Co", jobTitle: "Engineer", status: "APPLIED" },
    });
    const newer = await db.application.create({
      data: {
        userId: u.id,
        company: "New Co",
        jobTitle: "Staff Engineer",
        status: "APPLIED",
        jobDescription: "Platform work.",
      },
    });
    const buffer = makePdf([
      "Built payment systems in Go and kept Postgres migrations online for the payments team.",
    ]);
    const storageKey = await saveResumeFile(u.id, {
      fileName: "resume.pdf",
      mimeType: "application/pdf",
      size: buffer.length,
      buffer,
    });
    const resume = await db.resume.create({
      data: {
        userId: u.id,
        label: "Mine",
        fileName: "resume.pdf",
        mimeType: "application/pdf",
        size: buffer.length,
        storageKey,
      },
    });
    await db.application.update({ where: { id: older.id }, data: { resumeId: resume.id } });
    await db.applicationQuestion.createMany({
      data: [
        { applicationId: older.id, questionId: q.id, position: 0 },
        { applicationId: newer.id, questionId: q.id, position: 0 },
      ],
    });
    await db.$executeRaw`UPDATE "Application" SET "updatedAt" = ${new Date("2026-01-01T00:00:00Z")} WHERE id = ${older.id}`;
    await db.$executeRaw`UPDATE "Application" SET "updatedAt" = ${new Date("2026-06-01T00:00:00Z")} WHERE id = ${newer.id}`;

    const res = await post(q.id);
    expect(await res.json()).toMatchObject({
      resumeUsed: false,
      resumeSkipped: false,
      application: { company: "New Co", jobTitle: "Staff Engineer" },
      usedMostRecent: true,
    });
    expect(generateAnswerDraft.mock.calls[0][0].resumeText).toBeNull();
  });

  it("reports a resume that could not be read", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    const app = await db.application.create({
      data: { userId: u.id, company: "Acme", jobTitle: "Engineer", status: "APPLIED" },
    });
    const buffer = Buffer.from("not a document");
    const storageKey = await saveResumeFile(u.id, {
      fileName: "resume.doc",
      mimeType: "application/msword",
      size: buffer.length,
      buffer,
    });
    const resume = await db.resume.create({
      data: {
        userId: u.id,
        label: "Old",
        fileName: "resume.doc",
        mimeType: "application/msword",
        size: buffer.length,
        storageKey,
      },
    });
    await db.application.update({ where: { id: app.id }, data: { resumeId: resume.id } });
    await db.applicationQuestion.create({
      data: { applicationId: app.id, questionId: q.id, position: 0 },
    });

    const res = await post(q.id);
    expect(await res.json()).toMatchObject({
      resumeUsed: false,
      resumeSkipped: true,
      usedMostRecent: false,
    });
    expect(generateAnswerDraft.mock.calls[0][0].resumeText).toBeNull();
  });

  it("enforces 15 drafts an hour on its own key", async () => {
    const a = await signIn();
    const q = await makeQuestion(a.id);
    for (let i = 0; i < 15; i++) expect((await post(q.id)).status).toBe(200);
    const limited = await post(q.id);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(generateAnswerDraft).toHaveBeenCalledTimes(15);
    const row = await db.rateLimit.findFirstOrThrow({ where: { key: `ai-answer:user:${a.id}` } });
    expect(row.count).toBe(16);
    expect(await db.rateLimit.count({ where: { key: { startsWith: "ai:user:" } } })).toBe(0);

    h.jar.clear();
    const b = await signIn();
    const qb = await makeQuestion(b.id, "Tell us about a project.");
    expect((await post(qb.id)).status).toBe(200);
  });

  it("pauses when the month is at the cap and does not call the model or the hourly limit", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    await db.aiSpend.create({
      data: { month: spendMonth(), spentMicros: BigInt(19_000_000), reservedMicros: BigInt(1_000_000) },
    });
    const res = await post(q.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: AI_PAUSED_MESSAGE });
    expect(generateAnswerDraft).not.toHaveBeenCalled();
    expect(await db.rateLimit.count()).toBe(0);
  });

  it("maps AI failures to the same statuses as cover letters", async () => {
    const u = await signIn();
    const q = await makeQuestion(u.id);
    generateAnswerDraft.mockRejectedValueOnce(new AiBusyError());
    expect((await post(q.id)).status).toBe(429);
    generateAnswerDraft.mockRejectedValueOnce(new AiTimeoutError());
    expect((await post(q.id)).status).toBe(504);
    generateAnswerDraft.mockRejectedValueOnce(new AiUnavailableError("model missing"));
    const unavailable = await post(q.id);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toMatch(/offline/i);
    generateAnswerDraft.mockRejectedValueOnce(new Error("boom"));
    const other = await post(q.id);
    expect(other.status).toBe(502);
    expect(await other.json()).toEqual({
      error: "Couldn't generate a draft right now. Please try again.",
    });
  });
});
