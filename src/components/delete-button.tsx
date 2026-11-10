"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui";

/** Danger button that asks for confirmation, then runs a server action. */
export function DeleteButton({
  action,
  confirmMessage,
  children,
}: {
  action: () => Promise<void>;
  confirmMessage: string;
  children: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="danger"
      disabled={pending}
      onClick={() => {
        if (window.confirm(confirmMessage)) startTransition(() => action());
      }}
    >
      {pending ? "Deleting…" : children}
    </Button>
  );
}
