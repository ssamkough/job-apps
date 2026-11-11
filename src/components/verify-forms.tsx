"use client";

import Link from "next/link";
import { useActionState } from "react";
import { resendVerificationCode, verifyEmail } from "@/app/actions/auth";
import type { FormState } from "@/lib/form-state";
import { Field, Notice, inputClass, linkClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const initial: FormState = {};

/** The one-time-code input shared by the verify and reset forms. */
export function CodeField({ error, defaultValue }: { error?: string; defaultValue?: string }) {
  return (
    <Field label="6-digit code" htmlFor="code" error={error}>
      <input
        id="code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        defaultValue={defaultValue}
        aria-invalid={!!error}
        aria-describedby={error ? "code-error" : undefined}
        className={inputClass}
      />
    </Field>
  );
}

/** The address the code was sent to: fixed when we know it, asked for when we don't. */
export function EmailField({ email, error }: { email?: string; error?: string }) {
  if (email) return <input type="hidden" name="email" value={email} />;
  return (
    <Field label="Email" htmlFor="email" error={error}>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        aria-invalid={!!error}
        className={inputClass}
      />
    </Field>
  );
}

export function VerifyEmailForm({ email }: { email?: string }) {
  const [state, action] = useActionState(verifyEmail, initial);
  const err = state.errors ?? {};
  const address = email ?? state.values?.email;

  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message && <Notice tone="error">{state.message}</Notice>}
      <EmailField email={address} error={err.email} />
      <CodeField error={err.code} />
      <SubmitButton className="w-full" pendingText="Verifying…">
        Verify email
      </SubmitButton>
    </form>
  );
}

export function ResendCodeForm({ email }: { email?: string }) {
  const [state, action] = useActionState(resendVerificationCode, initial);
  if (!email) return null;

  return (
    <form action={action} className="mt-4 space-y-3 text-center text-sm text-zinc-500">
      {state.message && (
        <Notice tone={state.ok ? "success" : "error"}>{state.message}</Notice>
      )}
      <input type="hidden" name="email" value={email} />
      <p>
        Didn&apos;t get it? Check your spam folder, or{" "}
        <button type="submit" className={linkClass}>
          send a new code
        </button>
        .
      </p>
      <p>
        <Link href="/login" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
