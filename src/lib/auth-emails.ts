import "server-only";
import { createToken } from "@/lib/tokens";
import { sendEmail } from "@/lib/email";
import { passwordResetEmail, verifyEmailEmail } from "@/lib/email-templates";
import { appUrl } from "@/lib/app-url";

// These live outside the "use server" action files on purpose: every function
// exported from a "use server" file becomes a publicly callable endpoint.

/** Emails a verification link. Never throws: callers must not depend on SMTP. */
export async function sendVerificationEmail(user: { id: string; email: string }) {
  try {
    const token = await createToken(user.id, "EMAIL_VERIFY");
    await sendEmail(verifyEmailEmail(user.email, appUrl(`/verify-email?token=${token}`)));
    return true;
  } catch (e) {
    console.error("Failed to send verification email", e);
    return false;
  }
}

/** Emails a password reset link. Never throws. */
export async function sendPasswordResetEmail(user: { id: string; email: string }) {
  try {
    const token = await createToken(user.id, "PASSWORD_RESET");
    await sendEmail(passwordResetEmail(user.email, appUrl(`/reset-password?token=${token}`)));
    return true;
  } catch (e) {
    console.error("Failed to send password reset email", e);
    return false;
  }
}
