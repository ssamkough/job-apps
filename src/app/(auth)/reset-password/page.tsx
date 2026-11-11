import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/password-forms";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Choose a new password</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        {email ? (
          <>
            If an account exists for <strong className="text-zinc-700">{email}</strong>, we
            emailed it a 6-digit code (valid for 5 minutes).{" "}
          </>
        ) : (
          "Enter your email and the 6-digit code we sent you. "
        )}
        You&apos;ll be signed out everywhere else.
      </p>
      <ResetPasswordForm email={email} />
    </>
  );
}
