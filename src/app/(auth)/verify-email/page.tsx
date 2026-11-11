import type { Metadata } from "next";
import { ResendCodeForm, VerifyEmailForm } from "@/components/verify-forms";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const { email } = await searchParams;
  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Check your email</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        {email ? (
          <>
            We sent a 6-digit code to <strong className="text-zinc-700">{email}</strong>.
            Enter it to finish creating your account. It&apos;s valid for 15 minutes.
          </>
        ) : (
          "Enter your email and the 6-digit code we sent you."
        )}
      </p>
      <VerifyEmailForm email={email} />
      <ResendCodeForm email={email} />
    </>
  );
}
