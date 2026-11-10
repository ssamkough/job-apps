"use server";

import { redirect } from "next/navigation";
import type { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { isStatus } from "@/lib/constants";
import { applicationSchema, fieldErrors } from "@/lib/validation";
import { formValues, type FormState } from "@/lib/form-state";
import {
  deleteResumeFile,
  readResumeUpload,
  saveResumeFile,
  type ResumeUpload,
} from "@/lib/storage";

/**
 * Validates the form and resolves the resume to attach: either an existing one
 * from the user's library or a newly uploaded file.
 */
type Prepared =
  | { error: FormState; data?: undefined; upload?: undefined }
  | {
      error?: undefined;
      data: z.output<typeof applicationSchema>;
      upload: ResumeUpload | null;
    };

async function prepare(userId: string, formData: FormData): Promise<Prepared> {
  const raw = formValues(formData);
  const parsed = applicationSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: { errors: fieldErrors(parsed.error), values: raw } };
  }

  let upload: ResumeUpload | null = null;
  const entry = formData.get("resumeFile");
  if (entry instanceof File && entry.size > 0) {
    const check = await readResumeUpload(entry);
    if (!check.ok) {
      return { error: { errors: { resumeFile: check.error }, values: raw } };
    }
    upload = check.upload;
  }

  if (parsed.data.resumeId) {
    const owned = await db.resume.findFirst({
      where: { id: parsed.data.resumeId, userId },
      select: { id: true },
    });
    if (!owned) {
      return {
        error: {
          errors: { resumeId: "That resume no longer exists" },
          values: raw,
        },
      };
    }
  }

  return { data: parsed.data, upload };
}

async function storeUpload(userId: string, file: ResumeUpload) {
  const storageKey = await saveResumeFile(userId, file);
  try {
    const resume = await db.resume.create({
      data: {
        userId,
        label: file.fileName.replace(/\.[^.]+$/, "").slice(0, 80) || "Resume",
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        storageKey,
      },
    });
    return resume.id;
  } catch (e) {
    await deleteResumeFile(storageKey);
    throw e;
  }
}

export async function createApplication(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const result = await prepare(user.id, formData);
  if (result.error) return result.error;

  const { data, upload } = result;
  const resumeId = upload
    ? await storeUpload(user.id, upload)
    : (data.resumeId ?? null);

  const app = await db.application.create({
    data: {
      ...data,
      userId: user.id,
      resumeId,
      events: { create: { fromStatus: null, toStatus: data.status } },
    },
  });

  revalidatePath("/", "layout");
  redirect(`/applications/${app.id}?saved=1`);
}

export async function updateApplication(
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const existing = await db.application.findFirst({
    where: { id, userId: user.id },
    select: { status: true },
  });
  if (!existing) redirect("/applications");

  const result = await prepare(user.id, formData);
  if (result.error) return result.error;

  const { data, upload } = result;
  const resumeId = upload
    ? await storeUpload(user.id, upload)
    : (data.resumeId ?? null);

  const statusChanged = existing.status !== data.status;

  // Optional fields cleared in the form must be cleared in the DB, so map
  // undefined -> null explicitly (Prisma ignores undefined).
  const columns = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v ?? null]),
  ) as typeof data;

  await db.application.update({
    where: { id },
    data: {
      ...columns,
      resumeId,
      ...(statusChanged && {
        statusUpdatedAt: new Date(),
        events: { create: { fromStatus: existing.status, toStatus: data.status } },
      }),
    },
  });

  revalidatePath("/", "layout");
  redirect(`/applications/${id}?saved=1`);
}

export async function updateApplicationStatus(id: string, status: string) {
  const user = await requireUser();
  if (!isStatus(status)) return { ok: false as const, error: "Invalid status" };

  const existing = await db.application.findFirst({
    where: { id, userId: user.id },
    select: { status: true },
  });
  if (!existing) return { ok: false as const, error: "Application not found" };

  if (existing.status !== status) {
    await db.application.update({
      where: { id },
      data: {
        status,
        statusUpdatedAt: new Date(),
        events: { create: { fromStatus: existing.status, toStatus: status } },
      },
    });
  }

  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function deleteApplication(id: string) {
  const user = await requireUser();
  await db.application.deleteMany({ where: { id, userId: user.id } });
  revalidatePath("/", "layout");
  redirect("/applications");
}
