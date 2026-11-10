"use client";

import { useActionState } from "react";
import { confirmEmail } from "@/app/actions/account";
import type { FormState } from "@/lib/form-state";
import { Notice } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

export function ConfirmEmailForm({ token }: { token: string }) {
  const [state, action] = useActionState(confirmEmail, {} as FormState);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state.message && <Notice tone="error">{state.message}</Notice>}
      <SubmitButton pendingText="Confirming…">Confirm my email</SubmitButton>
    </form>
  );
}
