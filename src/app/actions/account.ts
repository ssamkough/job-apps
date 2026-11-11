"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireFreshUser } from "@/lib/auth";
import { authApi } from "@/lib/auth-api";
import { clearAuthCookies } from "@/lib/auth-cookies";
import { unexpectedAuthError } from "@/lib/auth-errors";
import { changePasswordSchema, fieldErrors } from "@/lib/validation";
import { formValues, type FormState } from "@/lib/form-state";
import { RULES, hit, retryMessage } from "@/lib/rate-limit";
import { deleteResumeFileStrict } from "@/lib/storage";

// Account actions ask Neon Auth about the session instead of trusting the
// short-lived cached copy (`requireFreshUser`), so a session that was revoked
// on another device can't change the password or delete the account.

export async function changePassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireFreshUser();

  const parsed = changePasswordSchema.safeParse(formValues(formData));
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };

  const limit = await hit(`password-check:user:${user.id}`, RULES.passwordCheckUser);
  if (!limit.allowed) return { message: retryMessage(limit) };

  // The adapter always passes revokeOtherSessions: true, so other devices are
  // signed out and this one gets a fresh session.
  const { error } = await authApi().changePassword({
    currentPassword: parsed.data.current,
    newPassword: parsed.data.password,
  });
  if (error) {
    if (error.code === "INVALID_CREDENTIALS") {
      return { errors: { current: "That isn't your current password" } };
    }
    if (error.code === "WEAK_PASSWORD") {
      return { errors: { password: "Choose a password of 8 to 128 characters" } };
    }
    return { message: unexpectedAuthError("change-password", error) };
  }

  return { ok: true, message: "Password updated. Other devices have been signed out." };
}

export async function signOutEverywhere(): Promise<FormState> {
  await requireFreshUser();

  const { error } = await authApi().revokeAllSessions();
  if (error) {
    // Don't claim other devices were signed out when we couldn't do it.
    return { message: unexpectedAuthError("sign-out-everywhere", error) };
  }
  await clearAuthCookies();
  redirect("/login");
}

/**
 * Deletes everything we store for the user, then asks Neon Auth to delete the
 * identity.
 *
 * Neon Auth (managed) doesn't offer self-service user deletion: the
 * `delete-user` endpoint answers 404 (verified against a Neon branch; not
 * documented either way). So the identity record (email address, password hash
 * and name) stays in Neon Auth until it is removed from the Neon console or
 * by Neon support. All sessions are revoked and every resume and application
 * is deleted, but the user is told this plainly (see the privacy page).
 * If Neon turns the endpoint on, the `deleteUser` call below starts working
 * with no further change.
 */
export async function deleteAccount(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireFreshUser();

  const password = formData.get("password");
  if (typeof password !== "string" || !password) {
    return { errors: { password: "Enter your password to confirm" } };
  }

  const limit = await hit(`password-check:user:${user.id}`, RULES.passwordCheckUser);
  if (!limit.allowed) return { message: retryMessage(limit) };

  // Re-check the password with Neon Auth (this starts a new session for the
  // same user, which is revoked below).
  const check = await authApi().signIn({ email: user.email, password });
  if (check.error) {
    if (check.error.code === "INVALID_CREDENTIALS") {
      return { errors: { password: "That isn't your password" } };
    }
    return { message: unexpectedAuthError("delete-account-check", check.error) };
  }

  const resumes = await db.resume.findMany({
    where: { userId: user.id },
    select: { storageKey: true },
  });

  // Files first and strictly: if one can't be deleted we stop with the
  // database rows still pointing at it, so the user can simply try again.
  try {
    for (const r of resumes) await deleteResumeFileStrict(r.storageKey);
  } catch (e) {
    console.error("Account deletion: could not delete a resume file", e);
    return {
      message: "We couldn't delete your uploaded files. Nothing was deleted. Please try again.",
    };
  }

  // Cascades to applications, resumes and status history.
  await db.user.delete({ where: { id: user.id } });

  const removed = await authApi().deleteUser({ password });
  if (removed.error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        message: "auth_identity_retained",
        status: removed.error.status,
        code: removed.error.code,
        userId: user.id,
      }),
    );
    // Best effort: end every session so the account can't be used from here.
    await authApi().revokeAllSessions().catch(() => {});
  }

  await clearAuthCookies();
  redirect("/?deleted=1");
}
