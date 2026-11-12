"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import type { FormState } from "@/lib/form-state";
import { formValues } from "@/lib/form-state";
import { fieldErrors } from "@/lib/validation";
import {
  MAX_ANSWERS_PER_QUESTION,
  MAX_QUESTIONS_PER_USER,
  answerSchema,
  questionKey,
  questionTextSchema,
} from "@/lib/questions";

const DUPLICATE = "You already have this question.";

export async function createQuestion(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const raw = formValues(formData);

  const text = questionTextSchema.safeParse(raw.text ?? "");
  if (!text.success) return { errors: { text: text.error.issues[0].message }, values: raw };

  // An optional first answer, so a question can be saved with its answer.
  let answer: { label?: string; body: string } | null = null;
  if (raw.body?.trim()) {
    const parsed = answerSchema.safeParse({ label: raw.label, body: raw.body });
    if (!parsed.success) return { errors: fieldErrors(parsed.error), values: raw };
    answer = parsed.data;
  }

  if ((await db.question.count({ where: { userId: user.id } })) >= MAX_QUESTIONS_PER_USER) {
    return { errors: { text: `You can keep up to ${MAX_QUESTIONS_PER_USER} questions.` }, values: raw };
  }
  const textKey = questionKey(text.data);
  if (await db.question.findUnique({ where: { userId_textKey: { userId: user.id, textKey } } })) {
    return { errors: { text: DUPLICATE }, values: raw };
  }

  const created = await db.question.create({
    data: {
      userId: user.id,
      text: text.data,
      textKey,
      ...(answer && { answers: { create: answer } }),
    },
  });
  revalidatePath("/questions");
  redirect(`/questions/${created.id}`);
}

export async function updateQuestion(
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const raw = formValues(formData);

  const text = questionTextSchema.safeParse(raw.text ?? "");
  if (!text.success) return { errors: { text: text.error.issues[0].message }, values: raw };

  const existing = await db.question.findFirst({ where: { id, userId: user.id } });
  if (!existing) redirect("/questions");

  const textKey = questionKey(text.data);
  const clash = await db.question.findFirst({
    where: { userId: user.id, textKey, NOT: { id } },
    select: { id: true },
  });
  if (clash) return { errors: { text: DUPLICATE }, values: raw };

  await db.question.update({
    where: { id, userId: user.id },
    data: { text: text.data, textKey },
  });
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved" };
}

export async function deleteQuestion(id: string) {
  const user = await requireUser();
  // Applications keep existing; they just stop listing this question.
  await db.question.deleteMany({ where: { id, userId: user.id } });
  revalidatePath("/", "layout");
  redirect("/questions");
}

export async function addAnswer(
  questionId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const raw = formValues(formData);
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values: raw };

  const question = await db.question.findFirst({
    where: { id: questionId, userId: user.id },
    select: { id: true, _count: { select: { answers: true } } },
  });
  if (!question) redirect("/questions");
  if (question._count.answers >= MAX_ANSWERS_PER_QUESTION) {
    return {
      errors: { body: `A question can have up to ${MAX_ANSWERS_PER_QUESTION} variants.` },
      values: raw,
    };
  }

  await db.answer.create({ data: { questionId: question.id, ...parsed.data } });
  revalidatePath("/", "layout");
  // Clear the form after a successful add.
  return { ok: true, message: "Variant added" };
}

export async function updateAnswer(
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const raw = formValues(formData);
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values: raw };

  // Ownership runs through the question the variant belongs to.
  const { count } = await db.answer.updateMany({
    where: { id, question: { userId: user.id } },
    data: { label: parsed.data.label ?? null, body: parsed.data.body },
  });
  if (count === 0) return { errors: { body: "That variant no longer exists." }, values: raw };
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved" };
}

export async function deleteAnswer(id: string) {
  const user = await requireUser();
  // Applications that chose it keep the question and lose the choice.
  await db.answer.deleteMany({ where: { id, question: { userId: user.id } } });
  revalidatePath("/", "layout");
}
