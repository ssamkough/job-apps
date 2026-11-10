"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  deleteUserSessions,
  destroySession,
  hashPassword,
  requireUser,
  verifyPassword,
} from "@/lib/auth";
import { changePasswordSchema, fieldErrors } from "@/lib/validation";
import { formValues, type FormState } from "@/lib/form-state";
import { RULES, hit, retryMessage } from "@/lib/rate-limit";
import { consumeToken } from "@/lib/tokens";
import { emailQuotaAvailable } from "@/lib/email";
import { sendVerificationEmail } from "@/lib/auth-emails";
import { deleteResumeFile } from "@/lib/storage";

export async function resendVerification(): Promise<FormState> {
  const user = await requireUser();
  if (user.emailVerifiedAt) return { ok: true, message: "Your email is already verified." };

  const limit = await hit(`verify-resend:user:${user.id}`, RULES.verifyResendUser);
  if (!limit.allowed) return { message: retryMessage(limit) };

  if (!(await emailQuotaAvailable())) {
    return { message: "We can't send email right now. Please try again tomorrow." };
  }

  const sent = await sendVerificationEmail(user);
  return sent
    ? { ok: true, message: `Verification email sent to ${user.email}.` }
    : { message: "Couldn't send the email. Please try again later." };
}

/** Works signed in or out: the emailed token is the proof. */
export async function confirmEmail(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const token = formData.get("token");
  const userId = typeof token === "string" ? await consumeToken(token, "EMAIL_VERIFY") : null;
  if (!userId) {
    return { message: "This link is invalid or has expired. Request a new one from Settings." };
  }
  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  redirect("/dashboard?verified=1");
}

export async function changePassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const parsed = changePasswordSchema.safeParse(formValues(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const limit = await hit(`password-check:user:${user.id}`, RULES.passwordCheckUser);
  if (!limit.allowed) return { message: retryMessage(limit) };

  const row = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(parsed.data.current, row.passwordHash))) {
    return { errors: { current: "That isn't your current password" } };
  }

  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(parsed.data.password) },
  });
  // Other devices must sign in again; this one stays signed in.
  await deleteUserSessions(user.id, { keepCurrent: true });

  return { ok: true, message: "Password updated. Other devices have been signed out." };
}

export async function signOutEverywhere() {
  const user = await requireUser();
  await deleteUserSessions(user.id);
  await destroySession();
  redirect("/login");
}

export async function deleteAccount(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();

  const password = formData.get("password");
  if (typeof password !== "string" || !password) {
    return { errors: { password: "Enter your password to confirm" } };
  }

  const limit = await hit(`password-check:user:${user.id}`, RULES.passwordCheckUser);
  if (!limit.allowed) return { message: retryMessage(limit) };

  const row = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(password, row.passwordHash))) {
    return { errors: { password: "That isn't your password" } };
  }

  const resumes = await db.resume.findMany({
    where: { userId: user.id },
    select: { storageKey: true },
  });

  // Cascades to sessions, applications, resumes, status history and tokens.
  await db.user.delete({ where: { id: user.id } });
  await Promise.all(resumes.map((r) => deleteResumeFile(r.storageKey)));

  await destroySession();
  redirect("/?deleted=1");
}
