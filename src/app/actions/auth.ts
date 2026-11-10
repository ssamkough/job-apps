"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createSession,
  deleteUserSessions,
  destroySession,
  hashPassword,
  verifyPassword,
} from "@/lib/auth";
import {
  fieldErrors,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
} from "@/lib/validation";
import { formValues, type FormState } from "@/lib/form-state";
import {
  RULES,
  clear,
  clientIp,
  emailKey,
  hit,
  peek,
  retryMessage,
} from "@/lib/rate-limit";
import { consumeToken } from "@/lib/tokens";
import { emailQuotaAvailable } from "@/lib/email";
import { sendPasswordResetEmail, sendVerificationEmail } from "@/lib/auth-emails";

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

  const { name, email, password } = parsed.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return {
      errors: { email: "An account with this email already exists" },
      values,
    };
  }

  let user: { id: string; email: string };
  try {
    user = await db.user.create({
      data: { name, email, passwordHash: await hashPassword(password) },
      select: { id: true, email: true },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return {
        errors: { email: "An account with this email already exists" },
        values,
      };
    }
    throw e;
  }

  await createSession(user.id);
  after(() => sendVerificationEmail(user));
  redirect("/dashboard");
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

  const user = await db.user.findUnique({ where: { email } });
  const ok = await verifyPassword(password, user?.passwordHash ?? null);

  if (!user || !ok) {
    await hit(failKey, RULES.loginEmailFailures);
    return { message: "Incorrect email or password", values };
  }

  await clear(failKey);
  await createSession(user.id);
  redirect("/dashboard");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

const RESET_NOTICE =
  "If an account exists for that email, we've sent a link to reset the password. It's valid for 1 hour.";

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const raw = formValues(formData);
  const values = { email: raw.email ?? "" };

  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };
  const { email } = parsed.data;

  const byIp = await hit(`reset:ip:${await clientIp()}`, RULES.resetIp);
  if (!byIp.allowed) return { message: retryMessage(byIp), values };
  const byEmail = await hit(`reset:email:${emailKey(email)}`, RULES.resetEmail);
  if (!byEmail.allowed) return { message: retryMessage(byEmail), values };

  // Checked before looking the account up so a full daily quota is reported
  // to everyone alike and can't be used to probe for registered emails.
  if (!(await emailQuotaAvailable())) {
    return {
      message: "We can't send email right now. Please try again tomorrow.",
      values,
    };
  }

  // Look up and send *after* responding so the response time doesn't reveal
  // whether the account exists.
  after(async () => {
    try {
      const user = await db.user.findUnique({ where: { email } });
      if (user) await sendPasswordResetEmail(user);
    } catch (e) {
      console.error("Password reset lookup failed", e);
    }
  });

  return { ok: true, message: RESET_NOTICE };
}

export async function resetPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = resetPasswordSchema.safeParse(formValues(formData));
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    // A bad token isn't a field the user can fix.
    if (errors.token) return { message: errors.token };
    return { errors };
  }

  const limit = await hit(`reset-submit:ip:${await clientIp()}`, RULES.resetSubmitIp);
  if (!limit.allowed) return { message: retryMessage(limit) };

  const userId = await consumeToken(parsed.data.token, "PASSWORD_RESET");
  if (!userId) {
    return {
      message: "This link is invalid or has expired. Request a new one.",
    };
  }

  const user = await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(parsed.data.password),
      // Receiving the email proves they own the address.
      emailVerifiedAt: new Date(),
    },
    select: { emailVerifiedAt: true, id: true },
  });
  // Anyone who had the old password (or a stolen session) is signed out.
  await deleteUserSessions(user.id);

  redirect("/login?reset=1");
}
