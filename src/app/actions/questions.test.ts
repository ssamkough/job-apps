import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeAuth } from "@/test/fake-auth";

const h = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  ip: "3.3.3.3",
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
    set: (n: string, v: string, o?: { maxAge?: number }) => {
      if (o?.maxAge === 0) h.jar.delete(n);
      else h.jar.set(n, v);
    },
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
  after: () => {},
}));
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  cache: <T,>(fn: T) => fn,
}));
vi.mock("@/lib/auth-api", () => ({ authApi: () => h.fake }));

import { db } from "@/lib/db";
import {
  addAnswer,
  createQuestion,
  deleteAnswer,
  deleteQuestion,
  updateAnswer,
  updateQuestion,
} from "@/app/actions/questions";
import { createApplication, deleteApplication, updateApplication } from "@/app/actions/applications";
import { loadApplicationQuestions, loadQuestionLibrary } from "@/lib/question-store";
import {
  MAX_ANSWERS_PER_QUESTION,
  MAX_QUESTIONS_PER_APPLICATION,
  MAX_QUESTIONS_PER_USER,
} from "@/lib/questions";
import { resetDb } from "@/test/db";
import { FakeAuth as FakeAuthImpl } from "@/test/fake-auth";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

async function run<T>(fn: () => Promise<T>): Promise<T | { redirect: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Redirect) return { redirect: e.url };
    throw e;
  }
}

async function makeUser() {
  const u = h.fake.seedUser({ verified: true });
  await db.user.create({ data: { id: u.id } });
  return u;
}
const signInAs = (u: { id: string }) => h.fake.signInAs(u);

const prev = { errors: {}, values: {} };
const app = (extra: Record<string, string> = {}) =>
  form({ company: "Acme", jobTitle: "Engineer", status: "APPLIED", ...extra });
const attach = (items: unknown[]) => JSON.stringify(items);

async function makeQuestion(userId: string, text: string, answers: string[] = []) {
  const q = await db.question.create({
    data: {
      userId,
      text,
      textKey: text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      answers: { create: answers.map((body) => ({ body })) },
    },
    include: { answers: true },
  });
  return q;
}
async function makeApplication(userId: string, company = "Acme") {
  return db.application.create({ data: { userId, company, jobTitle: "Engineer", status: "APPLIED" } });
}

beforeEach(async () => {
  await resetDb();
  h.jar.clear();
  h.fake = new FakeAuthImpl(h.jar);
});
afterEach(() => vi.restoreAllMocks());

describe("the question library", () => {
  it("creates a question, optionally with a first answer, and goes to it", async () => {
    const u = await makeUser();
    signInAs(u);
    const res = await run(() => createQuestion(prev, form({ text: "Why do you want to work here?", body: "Because." })));
    expect(res).toMatchObject({ redirect: expect.stringMatching(/^\/questions\//) });
    const q = await db.question.findFirstOrThrow({ where: { userId: u.id }, include: { answers: true } });
    expect(q.answers).toHaveLength(1);
    expect(q.answers[0]).toMatchObject({ body: "Because.", source: "MANUAL" });
  });

  it("treats the same question in a different spelling as a duplicate", async () => {
    const u = await makeUser();
    signInAs(u);
    await run(() => createQuestion(prev, form({ text: "Why us?" })));
    const dupe = await createQuestion(prev, form({ text: "  why   US " }));
    expect(dupe).toMatchObject({ errors: { text: "You already have this question." } });
    expect(await db.question.count()).toBe(1);
  });

  it("lets two people have the same question", async () => {
    const a = await makeUser();
    const b = await makeUser();
    signInAs(a);
    await run(() => createQuestion(prev, form({ text: "Why us?" })));
    signInAs(b);
    await run(() => createQuestion(prev, form({ text: "Why us?" })));
    expect(await db.question.count()).toBe(2);
  });

  it("validates text and answers", async () => {
    signInAs(await makeUser());
    expect(await createQuestion(prev, form({ text: "" }))).toMatchObject({ errors: { text: expect.any(String) } });
    expect(await createQuestion(prev, form({ text: "x".repeat(1001) }))).toMatchObject({
      errors: { text: expect.any(String) },
    });
    expect(await createQuestion(prev, form({ text: "Fine question?", body: "y".repeat(10_001) }))).toMatchObject({
      errors: { body: expect.any(String) },
    });
    expect(await db.question.count()).toBe(0);
  });

  it("caps questions per person", async () => {
    const u = await makeUser();
    signInAs(u);
    await db.question.createMany({
      data: Array.from({ length: MAX_QUESTIONS_PER_USER }, (_, i) => ({
        userId: u.id,
        text: `Question ${i}`,
        textKey: `question ${i}`,
      })),
    });
    expect(await createQuestion(prev, form({ text: "One too many?" }))).toMatchObject({
      errors: { text: expect.stringContaining("up to") },
    });
  });

  it("edits the text, but not into another question's text", async () => {
    const u = await makeUser();
    signInAs(u);
    const a = await makeQuestion(u.id, "Why us?");
    await makeQuestion(u.id, "Why you?");
    expect(await updateQuestion(a.id, prev, form({ text: "Why this company?" }))).toMatchObject({ ok: true });
    expect((await db.question.findUniqueOrThrow({ where: { id: a.id } })).text).toBe("Why this company?");
    expect(await updateQuestion(a.id, prev, form({ text: "why you" }))).toMatchObject({
      errors: { text: "You already have this question." },
    });
  });

  it("adds, edits and deletes variants, with a cap", async () => {
    const u = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?");
    expect(await addAnswer(q.id, prev, form({ label: "Short", body: "Short answer" }))).toMatchObject({ ok: true });
    const a = await db.answer.findFirstOrThrow({ where: { questionId: q.id } });
    expect(a.label).toBe("Short");
    expect(await updateAnswer(a.id, prev, form({ body: "Changed" }))).toMatchObject({ ok: true });
    expect(await db.answer.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ body: "Changed", label: null });
    expect(await addAnswer(q.id, prev, form({ body: "" }))).toMatchObject({ errors: { body: expect.any(String) } });

    await db.answer.createMany({
      data: Array.from({ length: MAX_ANSWERS_PER_QUESTION - 1 }, (_, i) => ({ questionId: q.id, body: `v${i}` })),
    });
    expect(await addAnswer(q.id, prev, form({ body: "too many" }))).toMatchObject({
      errors: { body: expect.stringContaining("up to") },
    });

    await deleteAnswer(a.id);
    expect(await db.answer.count({ where: { id: a.id } })).toBe(0);
  });
});

describe("access control", () => {
  it("never lets one person read or change another's questions and answers", async () => {
    const owner = await makeUser();
    const intruder = await makeUser();
    const q = await makeQuestion(owner.id, "Secret question?", ["Secret answer"]);
    const answerId = q.answers[0].id;
    signInAs(intruder);

    expect(await run(() => updateQuestion(q.id, prev, form({ text: "Hijacked" })))).toMatchObject({
      redirect: "/questions",
    });
    expect(await run(() => addAnswer(q.id, prev, form({ body: "Injected" })))).toMatchObject({ redirect: "/questions" });
    expect(await updateAnswer(answerId, prev, form({ body: "Overwritten" }))).toMatchObject({
      errors: { body: expect.any(String) },
    });
    await deleteAnswer(answerId);
    await run(() => deleteQuestion(q.id));

    const after = await db.question.findUniqueOrThrow({ where: { id: q.id }, include: { answers: true } });
    expect(after.text).toBe("Secret question?");
    expect(after.answers.map((a) => a.body)).toEqual(["Secret answer"]);
    expect(await loadQuestionLibrary(intruder.id)).toEqual([]);
  });

  it("requires sign-in", async () => {
    await expect(createQuestion(prev, form({ text: "Why us?" }))).rejects.toBeDefined();
  });
});

describe("questions on applications", () => {
  it("lets a question belong to many applications, and an application have many questions", async () => {
    const u = await makeUser();
    signInAs(u);
    const q1 = await makeQuestion(u.id, "Why us?", ["Answer A", "Answer B"]);
    const q2 = await makeQuestion(u.id, "Salary expectations?");
    const [a1, a2] = [await makeApplication(u.id, "One"), await makeApplication(u.id, "Two")];

    await run(() =>
      updateApplication(a1.id, prev, app({ questions: attach([{ questionId: q1.id }, { questionId: q2.id }]) })),
    );
    await run(() => updateApplication(a2.id, prev, app({ questions: attach([{ questionId: q1.id }]) })));

    expect((await loadApplicationQuestions(u.id, a1.id)).map((q) => q.questionId)).toEqual([q1.id, q2.id]);
    expect((await loadApplicationQuestions(u.id, a2.id)).map((q) => q.questionId)).toEqual([q1.id]);
    expect(await db.applicationQuestion.count({ where: { questionId: q1.id } })).toBe(2);
  });

  it("records which variant each application uses", async () => {
    const u = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?", ["Answer A", "Answer B"]);
    const [a, b] = q.answers;
    const one = await makeApplication(u.id, "One");
    const two = await makeApplication(u.id, "Two");
    await run(() => updateApplication(one.id, prev, app({ questions: attach([{ questionId: q.id, answerId: a.id }]) })));
    await run(() => updateApplication(two.id, prev, app({ questions: attach([{ questionId: q.id, answerId: b.id }]) })));
    expect((await loadApplicationQuestions(u.id, one.id))[0].answerId).toBe(a.id);
    expect((await loadApplicationQuestions(u.id, two.id))[0].answerId).toBe(b.id);
  });

  it("creates new questions from text, reusing an existing one with the same text", async () => {
    const u = await makeUser();
    signInAs(u);
    const existing = await makeQuestion(u.id, "Why us?");
    const res = await run(() =>
      createApplication(
        prev,
        app({
          questions: attach([
            { text: "  why US ", source: "IMPORT" },
            { text: "What is your favourite language?", source: "IMPORT" },
          ]),
        }),
      ),
    );
    expect(res).toMatchObject({ redirect: expect.stringContaining("/applications/") });
    expect(await db.question.count({ where: { userId: u.id } })).toBe(2);
    const created = await db.application.findFirstOrThrow({ where: { userId: u.id } });
    const links = await db.applicationQuestion.findMany({ where: { applicationId: created.id }, orderBy: { position: "asc" } });
    expect(links.map((l) => l.questionId)[0]).toBe(existing.id);
    expect(links.map((l) => l.source)).toEqual(["IMPORT", "IMPORT"]);
  });

  it("ignores another person's question or variant, and a variant of a different question", async () => {
    const owner = await makeUser();
    const u = await makeUser();
    signInAs(u);
    const theirs = await makeQuestion(owner.id, "Their question?", ["their answer"]);
    const mine = await makeQuestion(u.id, "My question?", ["my answer"]);
    const other = await makeQuestion(u.id, "Another?", ["other answer"]);
    const a = await makeApplication(u.id);
    await run(() =>
      updateApplication(
        a.id,
        prev,
        app({
          questions: attach([
            { questionId: theirs.id, answerId: theirs.answers[0].id },
            { questionId: mine.id, answerId: other.answers[0].id },
            { questionId: other.id, answerId: theirs.answers[0].id },
          ]),
        }),
      ),
    );
    const links = await loadApplicationQuestions(u.id, a.id);
    expect(links.map((l) => l.questionId).sort()).toEqual([mine.id, other.id].sort());
    expect(links.every((l) => l.answerId === null)).toBe(true);
  });

  it("removes questions that are no longer listed, and leaves them alone when the field is absent", async () => {
    const u = await makeUser();
    signInAs(u);
    const q1 = await makeQuestion(u.id, "One?");
    const q2 = await makeQuestion(u.id, "Two?");
    const a = await makeApplication(u.id);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q1.id }, { questionId: q2.id }]) })));
    await run(() => updateApplication(a.id, prev, app()));
    expect(await loadApplicationQuestions(u.id, a.id)).toHaveLength(2);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q2.id }]) })));
    expect((await loadApplicationQuestions(u.id, a.id)).map((q) => q.questionId)).toEqual([q2.id]);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([]) })));
    expect(await loadApplicationQuestions(u.id, a.id)).toEqual([]);
    expect(await db.question.count({ where: { userId: u.id } })).toBe(2);
  });

  it("de-duplicates repeats and keeps the order given", async () => {
    const u = await makeUser();
    signInAs(u);
    const q1 = await makeQuestion(u.id, "One?");
    const q2 = await makeQuestion(u.id, "Two?");
    const a = await makeApplication(u.id);
    await run(() =>
      updateApplication(
        a.id,
        prev,
        app({ questions: attach([{ questionId: q2.id }, { questionId: q1.id }, { questionId: q2.id }, { text: "two" }]) }),
      ),
    );
    expect((await loadApplicationQuestions(u.id, a.id)).map((q) => q.questionId)).toEqual([q2.id, q1.id]);
  });

  it("rejects a bad list with a message and saves nothing", async () => {
    const u = await makeUser();
    signInAs(u);
    const a = await makeApplication(u.id);
    const res = await updateApplication(a.id, prev, app({ company: "Renamed", questions: "{broken" }));
    expect(res).toMatchObject({ errors: { questions: expect.any(String) } });
    expect((await db.application.findUniqueOrThrow({ where: { id: a.id } })).company).toBe("Acme");

    const tooMany = Array.from({ length: MAX_QUESTIONS_PER_APPLICATION + 1 }, (_, i) => ({ text: `Q${i}?` }));
    expect(await updateApplication(a.id, prev, app({ questions: attach(tooMany) }))).toMatchObject({
      errors: { questions: expect.any(String) },
    });
  });

  it("refuses new questions past the per-person limit, without saving the application", async () => {
    const u = await makeUser();
    signInAs(u);
    await db.question.createMany({
      data: Array.from({ length: MAX_QUESTIONS_PER_USER }, (_, i) => ({ userId: u.id, text: `Q ${i}`, textKey: `q ${i}` })),
    });
    const res = await run(() => createApplication(prev, app({ questions: attach([{ text: "Brand new question?" }]) })));
    expect(res).toMatchObject({ errors: { questions: expect.any(String) } });
    expect(await db.application.count()).toBe(0);
  });

  it("keeps the question and its answers when an application is deleted", async () => {
    const u = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?", ["A"]);
    const a = await makeApplication(u.id);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q.id, answerId: q.answers[0].id }]) })));
    await run(() => deleteApplication(a.id));
    expect(await db.applicationQuestion.count()).toBe(0);
    expect(await db.question.count()).toBe(1);
    expect(await db.answer.count()).toBe(1);
  });

  it("clears the choice, not the question, when a variant is deleted", async () => {
    const u = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?", ["A"]);
    const a = await makeApplication(u.id);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q.id, answerId: q.answers[0].id }]) })));
    await deleteAnswer(q.answers[0].id);
    const links = await loadApplicationQuestions(u.id, a.id);
    expect(links).toHaveLength(1);
    expect(links[0].answerId).toBeNull();
  });

  it("removes the question from every application when it is deleted", async () => {
    const u = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?", ["A"]);
    const a = await makeApplication(u.id);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q.id }]) })));
    await run(() => deleteQuestion(q.id));
    expect(await loadApplicationQuestions(u.id, a.id)).toEqual([]);
    expect(await db.application.count({ where: { id: a.id } })).toBe(1);
  });
});

describe("the library for pickers", () => {
  it("lists questions with short previews of their variants", async () => {
    const u = await makeUser();
    await makeQuestion(u.id, "Why us?", ["x".repeat(500)]);
    const [q] = await loadQuestionLibrary(u.id);
    expect(q.answers[0].preview).toHaveLength(80);
  });
});

describe("deleting an account", () => {
  it("cascades: removes questions, variants and links with it", async () => {
    const u = await makeUser();
    const other = await makeUser();
    signInAs(u);
    const q = await makeQuestion(u.id, "Why us?", ["A"]);
    const keep = await makeQuestion(other.id, "Keep me?", ["B"]);
    const a = await makeApplication(u.id);
    await run(() => updateApplication(a.id, prev, app({ questions: attach([{ questionId: q.id }]) })));
    // What deleteAccount does for the database rows: it relies on the cascade.
    await db.user.delete({ where: { id: u.id } });
    expect(await db.question.findMany({ select: { id: true } })).toEqual([{ id: keep.id }]);
    expect(await db.answer.count()).toBe(1);
    expect(await db.applicationQuestion.count()).toBe(0);
  });
});
