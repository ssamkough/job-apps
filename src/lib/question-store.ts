import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  MAX_QUESTIONS_PER_USER,
  cleanQuestionText,
  questionKey,
  type Attachment,
} from "@/lib/questions";

type Tx = Prisma.TransactionClient;

export class QuestionLimitError extends Error {
  constructor() {
    super(`You can keep up to ${MAX_QUESTIONS_PER_USER} questions.`);
  }
}

/**
 * Finds the person's question with this text, or creates it. Two spellings of
 * the same question resolve to one row, so answers are never split.
 */
export async function findOrCreateQuestion(tx: Tx, userId: string, rawText: string) {
  const text = cleanQuestionText(rawText);
  const textKey = questionKey(text);
  const existing = await tx.question.findUnique({
    where: { userId_textKey: { userId, textKey } },
    select: { id: true },
  });
  if (existing) return existing.id;

  if ((await tx.question.count({ where: { userId } })) >= MAX_QUESTIONS_PER_USER) {
    throw new QuestionLimitError();
  }
  // upsert, not create: a concurrent request may have just made it.
  const made = await tx.question.upsert({
    where: { userId_textKey: { userId, textKey } },
    create: { userId, text, textKey },
    update: {},
    select: { id: true },
  });
  return made.id;
}

/**
 * Makes an application's questions exactly `items`, in that order. Everything
 * is checked against the caller: a question or variant that isn't theirs is
 * ignored, and a variant must belong to the question it is attached to.
 */
export async function setApplicationQuestions(
  tx: Tx,
  userId: string,
  applicationId: string,
  items: Attachment[],
) {
  // Resolve every item to one of the person's questions (first mention wins).
  const resolved = new Map<string, { answerId: string | null; source: string }>();
  for (const item of items) {
    let questionId: string | null = null;
    if (item.questionId) {
      const own = await tx.question.findFirst({
        where: { id: item.questionId, userId },
        select: { id: true },
      });
      questionId = own?.id ?? null;
    } else if (item.text) {
      questionId = await findOrCreateQuestion(tx, userId, item.text);
    }
    if (!questionId || resolved.has(questionId)) continue;

    let answerId: string | null = null;
    if (item.answerId) {
      const answer = await tx.answer.findFirst({
        where: { id: item.answerId, questionId },
        select: { id: true },
      });
      answerId = answer?.id ?? null;
    }
    resolved.set(questionId, { answerId, source: item.source ?? "MANUAL" });
  }

  const keep = [...resolved.keys()];
  await tx.applicationQuestion.deleteMany({
    where: { applicationId, questionId: { notIn: keep } },
  });

  let position = 0;
  for (const [questionId, { answerId, source }] of resolved) {
    await tx.applicationQuestion.upsert({
      where: { applicationId_questionId: { applicationId, questionId } },
      create: { applicationId, questionId, answerId, source, position },
      // Keep where the link came from; only the choice and order change.
      update: { answerId, position },
    });
    position++;
  }
}

/** Number of distinct questions this person would have after saving `items`. */
export async function wouldExceedLimit(userId: string, items: Attachment[]) {
  const texts = new Map<string, true>();
  for (const i of items) if (!i.questionId && i.text) texts.set(questionKey(i.text), true);
  if (texts.size === 0) return false;
  const existing = await db.question.findMany({
    where: { userId, textKey: { in: [...texts.keys()] } },
    select: { textKey: true },
  });
  const fresh = texts.size - existing.length;
  if (fresh <= 0) return false;
  return (await db.question.count({ where: { userId } })) + fresh > MAX_QUESTIONS_PER_USER;
}

export type LibraryQuestion = {
  id: string;
  text: string;
  answers: Array<{ id: string; label: string | null; preview: string }>;
};

/**
 * The person's question library for pickers: every question with short
 * previews of its answers (the full text of every answer isn't needed here).
 */
export async function loadQuestionLibrary(userId: string): Promise<LibraryQuestion[]> {
  const [questions, answers] = await Promise.all([
    db.question.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, text: true },
    }),
    db.$queryRaw<Array<{ id: string; questionId: string; label: string | null; preview: string }>>`
      SELECT a."id", a."questionId", a."label", left(a."body", 80) AS "preview"
      FROM "Answer" a
      JOIN "Question" q ON q."id" = a."questionId"
      WHERE q."userId" = ${userId}
      ORDER BY a."createdAt" ASC`,
  ]);
  const byQuestion = new Map<string, LibraryQuestion["answers"]>();
  for (const a of answers) {
    const list = byQuestion.get(a.questionId) ?? [];
    list.push({ id: a.id, label: a.label, preview: a.preview });
    byQuestion.set(a.questionId, list);
  }
  return questions.map((q) => ({ ...q, answers: byQuestion.get(q.id) ?? [] }));
}

export type AttachedQuestion = {
  questionId: string;
  text: string;
  answerId: string | null;
  source: string;
};

/** An application's questions in order. */
export async function loadApplicationQuestions(
  userId: string,
  applicationId: string,
): Promise<AttachedQuestion[]> {
  const links = await db.applicationQuestion.findMany({
    where: { applicationId, application: { userId } },
    orderBy: { position: "asc" },
    select: { questionId: true, answerId: true, source: true, question: { select: { text: true } } },
  });
  return links.map((l) => ({
    questionId: l.questionId,
    text: l.question.text,
    answerId: l.answerId,
    source: l.source,
  }));
}
