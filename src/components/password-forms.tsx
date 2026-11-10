"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, resetPassword } from "@/app/actions/auth";
import type { FormState } from "@/lib/form-state";
import { Field, Notice, inputClass, linkClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const initial: FormState = {};

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordReset, initial);
  const err = state.errors ?? {};

  return (
    <form action={action} className="space-y-4" noValidate>
      {state.message && (
        <Notice tone={state.ok ? "success" : "error"}>{state.message}</Notice>
      )}
      <Field label="Email" htmlFor="email" error={err.email}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          aria-invalid={!!err.email}
          className={inputClass}
        />
      </Field>
      <SubmitButton className="w-full" pendingText="Sending…">
        Send reset link
      </SubmitButton>
      <p className="text-center text-sm text-zinc-500">
        <Link href="/login" className={linkClass}>
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPassword, initial);
  const err = state.errors ?? {};

  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="token" value={token} />
      {state.message && (
        <Notice tone="error">
          {state.message}{" "}
          <Link href="/forgot-password" className="font-medium underline">
            Request a new link
          </Link>
        </Notice>
      )}
      <Field label="New password" htmlFor="password" error={err.password} hint="At least 8 characters.">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={!!err.password}
          className={inputClass}
        />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={err.confirm}>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={!!err.confirm}
          className={inputClass}
        />
      </Field>
      <SubmitButton className="w-full" pendingText="Updating…">
        Set new password
      </SubmitButton>
    </form>
  );
}
