"use client";

import { useActionState } from "react";
import { changePassword, deleteAccount, signOutEverywhere } from "@/app/actions/account";
import type { FormState } from "@/lib/form-state";
import { Field, Notice, inputClass } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

const initial: FormState = {};

export function SignOutEverywhereForm() {
  const [state, action] = useActionState(signOutEverywhere, initial);
  return (
    <form action={action} className="space-y-3">
      {state.message && <Notice tone="error">{state.message}</Notice>}
      <SubmitButton variant="secondary" pendingText="Signing out…">
        Sign out of all devices
      </SubmitButton>
    </form>
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
