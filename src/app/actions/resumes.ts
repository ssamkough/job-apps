"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import type { FormState } from "@/lib/form-state";
import {
  deleteResumeFile,
  readResumeUpload,
  saveResumeFile,
} from "@/lib/storage";

export async function uploadResume(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const check = await readResumeUpload(formData.get("file"));
  if (!check.ok) return { errors: { file: check.error } };
  const { upload } = check;

  const rawLabel = formData.get("label");
  const label =
    (typeof rawLabel === "string" ? rawLabel.trim() : "") ||
    upload.fileName.replace(/\.[^.]+$/, "") ||
    "Resume";
  if (label.length > 80) {
    return { errors: { label: "Label must be 80 characters or fewer" } };
  }

  const storageKey = await saveResumeFile(user.id, upload);
  try {
    await db.resume.create({
      data: {
        userId: user.id,
        label,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        size: upload.size,
        storageKey,
      },
    });
  } catch (e) {
    await deleteResumeFile(storageKey);
    throw e;
  }

  revalidatePath("/resumes");
  return { message: "Resume uploaded" };
}

export async function deleteResume(id: string) {
  const user = await requireUser();
  const resume = await db.resume.findFirst({
    where: { id, userId: user.id },
    select: { id: true, storageKey: true },
  });
  if (!resume) return;

  // Applications that used it keep existing; resumeId is set to null.
  await db.resume.delete({ where: { id: resume.id } });
  await deleteResumeFile(resume.storageKey);
  revalidatePath("/", "layout");
}
