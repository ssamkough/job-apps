import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/password-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Reset your password</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        Enter your email and we&apos;ll send you a 6-digit code to choose a new one.
      </p>
      <ForgotPasswordForm />
    </>
  );
}
