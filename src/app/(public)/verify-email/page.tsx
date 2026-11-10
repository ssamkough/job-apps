import type { Metadata } from "next";
import Link from "next/link";
import { peekToken } from "@/lib/tokens";
import { ConfirmEmailForm } from "@/components/confirm-email-form";
import { Card, LinkButton } from "@/components/ui";

export const metadata: Metadata = { title: "Verify email", referrer: "no-referrer" };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const valid = token ? await peekToken(token, "EMAIL_VERIFY") : false;

  return (
    <Card className="mx-auto max-w-md p-6 sm:p-8">
      {token && valid ? (
        <>
          <h1 className="text-xl font-semibold text-zinc-900">Confirm your email</h1>
          <p className="mb-6 mt-1 text-sm text-zinc-500">
            One click to finish. (This extra step stops email security scanners from
            using up your link before you do.)
          </p>
          <ConfirmEmailForm token={token} />
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-zinc-900">Link expired</h1>
          <p className="mb-6 mt-1 text-sm text-zinc-500">
            This verification link is invalid, expired, or already used. Sign in and
            request a new one from Settings.
          </p>
          <LinkButton href="/settings">Go to Settings</LinkButton>
        </>
      )}
      <p className="mt-6 text-center text-xs text-zinc-400">
        <Link href="/dashboard" className="hover:text-zinc-600">Back to the app</Link>
      </p>
    </Card>
  );
}
