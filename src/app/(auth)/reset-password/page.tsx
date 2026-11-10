import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/password-forms";
import { peekToken } from "@/lib/tokens";
import { linkClass } from "@/components/ui";

export const metadata: Metadata = {
  title: "Choose a new password",
  // Keeps the token out of the Referer header sent to any third-party request.
  referrer: "no-referrer",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const valid = token ? await peekToken(token, "PASSWORD_RESET") : false;

  if (!token || !valid) {
    return (
      <>
        <h1 className="text-xl font-semibold text-zinc-900">Link expired</h1>
        <p className="mb-6 mt-1 text-sm text-zinc-500">
          This reset link is invalid or has already been used.
        </p>
        <Link href="/forgot-password" className={linkClass}>
          Request a new link
        </Link>
      </>
    );
  }

  return (
    <>
      <h1 className="text-xl font-semibold text-zinc-900">Choose a new password</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        You&apos;ll be signed out everywhere else.
      </p>
      <ResetPasswordForm token={token} />
    </>
  );
}
