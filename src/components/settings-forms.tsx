"use client";

import { useActionState, useTransition, useState } from "react";
import { changePassword, deleteAccount, resendVerification } from "@/app/actions/account";
import type { FormState } from "@/lib/form-state";
import { Button, Field, Notice, inputClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const initial: FormState = {};

export function ResendVerificationButton({ variant = "secondary" }: { variant?: "secondary" | "ghost" }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FormState | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <Button
        variant={variant}
        disabled={pending}
        onClick={() => start(async () => setResult(await resendVerification()))}
      >
        {pending ? "Sending…" : "Resend verification email"}
      </Button>
      {result?.message && (
        <span
          role={result.ok ? "status" : "alert"}
          className={result.ok ? "text-sm text-emerald-700" : "text-sm text-rose-700"}
        >
          {result.message}
        </span>
      )}
    </span>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePassword, initial);
  const err = state.errors ?? {};
  return (
    <form action={action} className="max-w-sm space-y-4" noValidate>
      {state.message && <Notice tone={state.ok ? "success" : "error"}>{state.message}</Notice>}
      <Field label="Current password" htmlFor="current" error={err.current}>
        <input id="current" name="current" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      <Field label="New password" htmlFor="password" error={err.password} hint="At least 8 characters.">
        <input id="password" name="password" type="password" autoComplete="new-password" required className={inputClass} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={err.confirm}>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className={inputClass} />
      </Field>
      <SubmitButton pendingText="Updating…">Update password</SubmitButton>
    </form>
  );
}

export function DeleteAccountForm() {
  const [state, action] = useActionState(deleteAccount, initial);
  const err = state.errors ?? {};
  return (
    <form
      action={action}
      className="max-w-sm space-y-4"
      noValidate
      onSubmit={(e) => {
        if (!window.confirm("Permanently delete your account and everything in it? This can't be undone.")) {
          e.preventDefault();
        }
      }}
    >
      {state.message && <Notice tone="error">{state.message}</Notice>}
      <Field label="Confirm with your password" htmlFor="delete-password" error={err.password}>
        <input id="delete-password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
      </Field>
      <SubmitButton variant="danger" pendingText="Deleting…">
        Delete my account
      </SubmitButton>
    </form>
  );
}
