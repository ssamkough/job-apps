"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps } from "react";
import { buttonClass, type ButtonVariant } from "@/components/ui";

export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  className,
  ...props
}: Omit<ComponentProps<"button">, "type"> & {
  pendingText?: string;
  variant?: ButtonVariant;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className={buttonClass(variant, className)}
      {...props}
    >
      {pending ? (pendingText ?? "Saving…") : children}
    </button>
  );
}
