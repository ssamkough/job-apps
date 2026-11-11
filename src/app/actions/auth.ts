"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { authApi } from "@/lib/auth-api";
import { clearAuthCookies } from "@/lib/auth-cookies";
import { unexpectedAuthError } from "@/lib/auth-errors";
import {
  fieldErrors,
  forgotPasswordSchema,
  loginSchema,
  resendCodeSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from "@/lib/validation";
import { formValues, type FormState } from "@/lib/form-state";
import { OTP_LIFETIME_MINUTES } from "@/lib/constants";
import {
  RULES,
  clear,
  clientIp,
  emailKey,
  hit,
  peek,
  retryMessage,
} from "@/lib/rate-limit";

/**
 * Everything here talks to Neon Auth through `authApi()`. Neon Auth is a public
 * endpoint with its own (undocumented) rate limits; the limits below protect
 * *our* forms and keep them from being used to flood inboxes or guess codes.
 * https://neon.com/docs/auth/reference/nextjs-server.md
 */

const verifyUrl = (email: string) => `/verify-email?email=${encodeURIComponent(email)}`;

/** Counts one "send an email" against the shared per-IP and per-address caps. */
async function otpSendAllowed(email: string): Promise<FormState | null> {
  const byIp = await hit(`otp-send:ip:${await clientIp()}`, RULES.otpSendIp);
  if (!byIp.allowed) return { message: retryMessage(byIp) };
  const byEmail = await hit(`otp-send:email:${emailKey(email)}`, RULES.otpSendEmail);
  if (!byEmail.allowed) return { message: retryMessage(byEmail) };
  return null;
}

export async function signup(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  // Never echo the password back.
  const values = { name: raw.name ?? "", email: raw.email ?? "" };

  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const limit = await hit(`signup:ip:${await clientIp()}`, RULES.signupIp);
  if (!limit.allowed) return { message: retryMessage(limit), values };
  const blocked = await otpSendAllowed(parsed.data.email);
  if (blocked) return { ...blocked, values };

  const { name, email, password } = parsed.data;
  const { error } = await authApi().signUp({ email, password, name: name ?? "" });

  // For an address that is already registered Neon Auth answers exactly as it
  // does for a new one, so sign-up can't be used to find out who has an
  // account. We keep that property: both cases continue to the code screen.
  if (error && error.code !== "USER_ALREADY_EXISTS") {
    if (error.code === "WEAK_PASSWORD") {
      return { errors: { password: "Choose a password of 8 to 128 characters" }, values };
    }
    return { message: unexpectedAuthError("signup", error), values };
  }

  redirect(verifyUrl(email));
}

export async function login(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "" };

  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email, password } = parsed.data;

  // Per-IP limit on every attempt, plus a per-account limit on *failures* so
  // one address can't be hammered from many IPs.
  const ipLimit = await hit(`login:ip:${await clientIp()}`, RULES.loginIp);
  if (!ipLimit.allowed) return { message: retryMessage(ipLimit), values };

  const failKey = `login:fail:${emailKey(email)}`;
  const failures = await peek(failKey, RULES.loginEmailFailures);
  if (!failures.allowed) return { message: retryMessage(failures), values };

  const { error } = await authApi().signIn({ email, password });

  if (error) {
    // Neon Auth only reports this once the password was right, so it doesn't
    // reveal anything to someone who doesn't already have the password. It
    // sends NO code on sign-in (checked against a real branch), and the code
    // from sign-up lives only a few minutes, so send a fresh one under the same
    // caps as every other form that triggers an email. If that can't be done
    // the verify screen still offers "send a new code".
    if (error.code === "EMAIL_NOT_VERIFIED") {
      if (!(await otpSendAllowed(email))) {
        const sent = await authApi().sendOtp({ email, type: "email-verification" });
        if (sent.error) unexpectedAuthError("login-send-code", sent.error);
      }
      redirect(verifyUrl(email));
    }

    // Same answer for an unknown email and a wrong password.
    if (error.code === "INVALID_CREDENTIALS") {
      await hit(failKey, RULES.loginEmailFailures);
      return { message: "Incorrect email or password", values };
    }
    return { message: unexpectedAuthError("login", error), values };
  }

  await clear(failKey);
  redirect("/dashboard");
}

export async function logout() {
  // Neon Auth may be unreachable; the browser is signed out regardless.
  await authApi().signOut().catch(() => {});
  await clearAuthCookies();
  redirect("/login");
}

const CODE_NOTICE = `If that address is waiting for verification, we've emailed a new code. It's valid for ${OTP_LIFETIME_MINUTES} minutes.`;

/** Finishes sign-up: the emailed code proves the address, then signs the user in. */
export async function verifyEmail(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "" };

  const parsed = verifyEmailSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email, code } = parsed.data;

  const byIp = await hit(`otp-submit:ip:${await clientIp()}`, RULES.otpSubmitIp);
  if (!byIp.allowed) return { message: retryMessage(byIp), values };
  const byEmail = await hit(`otp-submit:email:${emailKey(email)}`, RULES.otpSubmitEmail);
  if (!byEmail.allowed) return { message: retryMessage(byEmail), values };

  const { error } = await authApi().verifyEmail({ email, otp: code });
  if (error) {
    if (error.code === "INVALID_CODE") {
      return {
        message: "That code is wrong or has expired. Check it, or request a new one.",
        values,
      };
    }
    return { message: unexpectedAuthError("verify-email", error), values };
  }

  // The SDK stored the new session (auto sign-in after verification).
  redirect("/dashboard?verified=1");
}

export async function resendVerificationCode(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "" };

  const parsed = resendCodeSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email } = parsed.data;

  const blocked = await otpSendAllowed(email);
  if (blocked) return { ...blocked, values };

  const { error } = await authApi().sendOtp({ email, type: "email-verification" });
  if (error) return { message: unexpectedAuthError("resend-code", error), values };
  return { ok: true, message: CODE_NOTICE, values };
}

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "" };

  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email } = parsed.data;

  const blocked = await otpSendAllowed(email);
  if (blocked) return { ...blocked, values };

  // Send *after* responding so the response time doesn't reveal whether the
  // account exists. Neon Auth answers the same either way; this keeps us from
  // adding a difference of our own.
  after(async () => {
    try {
      const { error } = await authApi().sendOtp({ email, type: "forget-password" });
      if (error) unexpectedAuthError("request-password-reset", error);
    } catch (e) {
      // Only the error's name: its message or stack could contain the address.
      console.error("Password reset request failed", e instanceof Error ? e.name : "unknown");
    }
  });

  redirect(`/reset-password?email=${encodeURIComponent(email)}`);
}

export async function resetPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "", code: raw.code ?? "" };

  const parsed = resetPasswordSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email, code, password } = parsed.data;

  const byIp = await hit(`otp-submit:ip:${await clientIp()}`, RULES.otpSubmitIp);
  if (!byIp.allowed) return { message: retryMessage(byIp), values };
  const byEmail = await hit(`otp-submit:email:${emailKey(email)}`, RULES.otpSubmitEmail);
  if (!byEmail.allowed) return { message: retryMessage(byEmail), values };

  const { error } = await authApi().resetPassword({ email, otp: code, password });
  if (error) {
    if (error.code === "INVALID_CODE") {
      return { message: "That code is wrong or has expired. Request a new one.", values };
    }
    if (error.code === "WEAK_PASSWORD") {
      return { errors: { password: "Choose a password of 8 to 128 characters" }, values };
    }
    return { message: unexpectedAuthError("reset-password", error), values };
  }

  // With "revoke sessions on password reset" on (a documented Neon Auth
  // setting) every existing session, on every device, is already ended.
  redirect("/login?reset=1");
}
